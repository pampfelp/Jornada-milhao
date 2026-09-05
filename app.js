// Jornada do Milhão — lógica do app. Firestore em tempo real (onSnapshot),
// sem Cloud Functions. Ver README.md para as decisões tomadas nas perguntas
// em aberto do plano original (plano_financeiro_funil.md).

import { db, APPS_SCRIPT_PROXY_URL } from "./firebase-init.js";
import {
  collection, addDoc, updateDoc, deleteDoc, doc, setDoc, getDocs, getDocsFromServer,
  onSnapshot, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
import {
  AUTH, PAPEIS, SENHA_PRIMEIRO_ACESSO, iniciarAuth, mensagemErroAuth, podeVer, isAdmin, papelAtual, sessaoLiberada,
  login, logout, enviarResetSenha, alterarMinhaSenha,
  bootstrapNecessario, criarPrimeiroAdmin, garantirBootstrapFechado,
  assinarUsuarios, criarUsuario, atualizarUsuario, removerVinculoUsuario,
} from "./auth.js";

const STATE = {
  clientes: [],
  agendamentos: [],
  etapasAgendamento: [],
  etapasVenda: [],
  oportunidades: [],
  contratos: [],
  parcelas: [],
  despesas: [],
  entradas: [],
  etapasAdmin: [],
  cardsAdmin: [],
  usuarios: [],
  config: {},
  periodoFinanceiro: new Date().toISOString().slice(0, 7),
  periodoDespesasDe: primeiroDiaMes(),
  periodoDespesasAte: ultimoDiaMes(),
  periodoEntradasDe: primeiroDiaMes(),
  periodoEntradasAte: ultimoDiaMes(),
  buscaDespesas: "",
  buscaContratos: "",
  buscaClientes: "",
  // Kanban (padrão) ou lista, e o recorte de período, por funil —
  // independentes entre os 3 (agendamento/vendas/administrativo).
  funilView: { agendamento: "kanban", vendas: "kanban", administrativo: "kanban" },
  funilPeriodoPreset: { agendamento: "tudo", vendas: "tudo", administrativo: "tudo" },
  funilPeriodoCustom: {
    agendamento: { de: "", ate: "" }, vendas: { de: "", ate: "" }, administrativo: { de: "", ate: "" }
  },
  // Busca por funil, no mesmo padrão de Contratos/Clientes/Despesas. Filtra
  // as DUAS visões ao mesmo tempo (Kanban e Lista) porque as duas saem do
  // mesmo array de cards — ver filtrarCardsFunil.
  buscaFunil: { agendamento: "", vendas: "", administrativo: "" },
  // Ordenação da visão em Lista, por funil. "campo" é a coluna e "desc" a
  // direção. O padrão (criado em, mais recente primeiro) é o de sempre.
  ordemLista: {
    agendamento: { campo: "createdAt", desc: true },
    vendas: { campo: "createdAt", desc: true },
    administrativo: { campo: "createdAt", desc: true }
  }
};

let pendingContratoOportunidadeId = null;
let pendingContratoEtapaFechamentoId = null;
// Resolve() da Promise de confirmarAcao() em aberto — ver definição da
// função mais abaixo, perto de abrirModal/fecharModal.
let pendingConfirmResolve = null;
// Callback pra "voltar" quando o modal-detalhe foi trocado pela ficha do
// cliente (acesso rápido a partir de parcela/contrato/card do funil) —
// fechar a ficha do cliente por qualquer caminho (Fechar, Esc, clique
// fora) reabre de onde veio, em vez de só sumir. Ver abrirDetalhe/
// abrirDetalheCliente/fecharModal.
let pendingDetalheAoFechar = null;
// Perda é genérica pros dois funis que têm etapa marcada como "perda"
// (Agendamento e Vendas) — guarda qual coleção/id está pendente.
let pendingPerda = null; // { colecao: "agendamentos"|"oportunidades", id }
let pendingEtapaAgendamentoId = null;
let pendingEtapaVendaId = null;
let pendingEtapaAdminId = null;
let pendingClienteId = null;
// Quando o cadastro de cliente é aberto "por cima" de outro modal (via
// "+ Criar cliente" no combobox, ou "Editar cliente" dentro do
// Agendamento/Vendas), guarda o que fazer depois de salvar: qual callback
// chamar com o cliente resultante, e quais modais reabrir por cima dos
// quais ele foi empilhado.
let pendingClienteRetornoCallback = null;
let pendingClienteRetornoModais = [];
let pendingDespesaId = null;
let pendingParcelaId = null;
let pendingContratoStatusId = null;
let pendingAgendamentoEditId = null;
let pendingOportunidadeEditId = null;
let pendingCardAdminId = null;
let pendingEntradaId = null;
let pendingMarcarPago = null; // { tipo: "parcela"|"despesa"|"entrada", id }
// Quando arrastar pra uma etapa "entraFunilVendas" sem telefone, o modal
// de edição abre pedindo o telefone; isso guarda pra onde o card deveria
// ter ido, pra completar o movimento só depois de salvar com telefone.
let pendingAgendamentoMoveEtapa = null;
let lancandoRecorrentes = false;

/* ══════════════ HELPERS ══════════════ */

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function fmtMoeda(n) {
  return (Number(n) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function parseMoeda(str) {
  if (typeof str === "number") return str;
  if (!str) return 0;
  let s = String(str).trim().replace(/[R$\s]/g, "");
  if (s.includes(",") && s.includes(".")) s = s.replace(/\./g, "").replace(",", ".");
  else if (s.includes(",")) s = s.replace(",", ".");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// Datas de negócio (vencimento, prazo, agendamento) são guardadas como
// string "yyyy-MM-dd" — mais simples de comparar/somar do que Timestamp,
// e evita fuso-horário mexendo com "dia certo" de vencimento.
function fmtData(dataStr) {
  if (!dataStr) return "—";
  const partes = String(dataStr).split("-");
  if (partes.length < 3) return "—";
  return `${partes[2]}/${partes[1]}/${partes[0]}`;
}

// Contratos gerados antes do campo "dataContrato" existir não têm esse
// campo — cai pra data de "dataGeracao" (o timestamp de quando foi
// lançado) só como fallback de exibição/ordenação, nunca escrito de volta
// sozinho (só quando alguém salva pelo modal de edição).
function dataContratoDe(c) {
  if (c.dataContrato) return c.dataContrato;
  if (c.dataGeracao && c.dataGeracao.toDate) return c.dataGeracao.toDate().toISOString().slice(0, 10);
  return "";
}

function fmtDataHora(timestamp) {
  if (!timestamp) return "—";
  const d = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("pt-BR") + " " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

// NUNCA usar toISOString() aqui — ela converte pra UTC, e o Brasil é UTC-3:
// entre ~21h e 23h59 (horário local), a data em UTC já virou amanhã, então
// "hoje" ficaria adiantado em 1 dia bem nas últimas horas de cada dia
// (afeta toda comparação de vencimento/"a pagar hoje" feita com essa
// função). Usa os getters locais, mesmo padrão de primeiroDiaMes() abaixo.
function hojeStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// "yyyy-MM-dd" local de um Timestamp do Firestore — mesmo cuidado de fuso
// do hojeStr() (nunca toISOString/UTC), usado pra filtrar por data de
// criação sem o bug clássico de virar o dia errado perto da meia-noite.
function dataLocalDeTimestamp(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  if (isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function primeiroDiaMes() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function ultimoDiaMes() {
  const d = new Date();
  const fim = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return fim.toISOString().slice(0, 10);
}

function addDias(dataStr, dias) {
  const d = new Date(dataStr + "T12:00:00");
  d.setDate(d.getDate() + Number(dias || 0));
  return d.toISOString().slice(0, 10);
}

function diasNoMes(ano, mes) {
  return new Date(ano, mes, 0).getDate();
}

// ══════════════ SLA (verde/amarelo/vermelho) — comum aos 3 funis ══════════════
// Cada etapa configura, opcionalmente, um limite pra virar amarelo e um pra
// virar vermelho, contados a partir do momento em que o card ENTROU na
// etapa atual (dataEntrouEtapa), em horas ou dias (slaUnidade). Sem limite
// configurado, o card fica sempre "verde" (sem badge de alerta).
function calcularStatusSla(dataEntrouEtapa, etapaCfg) {
  if (!etapaCfg || !dataEntrouEtapa) return null;
  const d = dataEntrouEtapa.toDate ? dataEntrouEtapa.toDate() : new Date(dataEntrouEtapa);
  if (isNaN(d.getTime())) return null;
  const unidadeMs = etapaCfg.slaUnidade === "horas" ? 3600000 : 86400000;
  const decorrido = (Date.now() - d.getTime()) / unidadeMs;
  let cor = "verde";
  if (etapaCfg.slaVermelho != null && decorrido >= etapaCfg.slaVermelho) cor = "vermelho";
  else if (etapaCfg.slaAmarelo != null && decorrido >= etapaCfg.slaAmarelo) cor = "amarelo";
  return { cor, decorrido, unidade: etapaCfg.slaUnidade === "horas" ? "h" : "d" };
}

function renderBadgeSla(dataEntrouEtapa, etapaCfg) {
  const sla = calcularStatusSla(dataEntrouEtapa, etapaCfg);
  if (!sla) return "";
  const valor = sla.decorrido < 1 ? "<1" : String(Math.floor(sla.decorrido));
  return `<span class="sla-badge sla-${sla.cor}">${valor}${sla.unidade}</span>`;
}

function mostrarToast(msg, tipo) {
  const el = document.getElementById("toast-erro");
  document.querySelector("#toast-erro .toast-title").textContent = tipo === "erro" ? "Aviso" : "Pronto";
  el.classList.toggle("erro", tipo === "erro");
  document.getElementById("toast-msg").textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(mostrarToast._t);
  mostrarToast._t = setTimeout(() => el.classList.add("hidden"), 6000);
}
function mostrarErro(msg) { mostrarToast(msg, "erro"); }

function abrirModal(id) { document.getElementById(id).classList.add("active"); }
function fecharModal(id) {
  document.getElementById(id).classList.remove("active");
  // Fechar o modal de confirmação por QUALQUER caminho (Cancelar, X, Esc,
  // clique fora) sem passar pelo botão "Confirmar" conta como negar — sem
  // isso a Promise de confirmarAcao() nunca resolveria nesses casos.
  if (id === "modal-confirmar-acao" && pendingConfirmResolve) {
    const resolve = pendingConfirmResolve;
    pendingConfirmResolve = null;
    resolve(false);
  }
  if (id === "modal-detalhe" && pendingDetalheAoFechar) {
    const voltar = pendingDetalheAoFechar;
    pendingDetalheAoFechar = null;
    voltar();
  }
}

document.querySelectorAll("[data-fechar-modal]").forEach((btn) => {
  btn.addEventListener("click", () => fecharModal(btn.dataset.fecharModal));
});

// Clique fora do card (no fundo escuro) fecha o modal — e[.target] só é o
// próprio overlay quando o clique não atingiu nenhum filho (modal-box),
// então não precisa checar "cliquei dentro por engano".
document.querySelectorAll(".modal-overlay").forEach((overlay) => {
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) fecharModal(overlay.id);
  });
});

// Esc fecha o modal visualmente "de cima" — como todos os overlays têm o
// mesmo z-index, quem está por cima é sempre o último em ordem no DOM
// entre os `.active` (é assim que o CSS já empilha visualmente, ex.:
// "Editar cliente" aberto por cima de um Agendamento).
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const abertos = document.querySelectorAll(".modal-overlay.active");
  if (!abertos.length) return;
  fecharModal(abertos[abertos.length - 1].id);
});

// Substitui confirm()/alert() nativos do navegador (nunca usar esses —
// quebram o visual e não dá pra estilizar). Uso: `if (!(await
// confirmarAcao("Excluir?"))) return;` dentro de uma função async.
// opcoes.textoConfirmar (padrão "Excluir") e opcoes.destrutivo (padrão
// true → botão vermelho; false → botão dourado padrão, pra ações que não
// destroem nada, tipo desfazer um "marcar como pago").
function confirmarAcao(mensagem, opcoes = {}) {
  return new Promise((resolve) => {
    pendingConfirmResolve = resolve;
    document.getElementById("mcf-mensagem").textContent = mensagem;
    const btnConfirmar = document.getElementById("mcf-btn-confirmar");
    btnConfirmar.textContent = opcoes.textoConfirmar || "Excluir";
    btnConfirmar.className = opcoes.destrutivo === false ? "btn btn-primary" : "btn btn-danger";
    abrirModal("modal-confirmar-acao");
  });
}
document.getElementById("mcf-btn-confirmar").addEventListener("click", () => {
  const resolve = pendingConfirmResolve;
  pendingConfirmResolve = null;
  fecharModal("modal-confirmar-acao");
  if (resolve) resolve(true);
});

// Modal de "lista por trás do número" — todo KPI que é uma contagem/soma de
// registros pode virar clicável (classe "clicavel" no ".value") e abrir
// isto com as linhas exatas daquele recorte, em vez do número ficar opaco.
// Um componente só, reaproveitado por Despesas/Entradas/Contratos/Clientes
// — cada tela monta as linhas já formatadas (abrirListaModal não conhece
// nenhuma estrutura de dados específica) e guarda em CACHE_LISTA_KPI pra
// o onclick inline (construído junto com o HTML do KPI) só precisar
// referenciar uma chave, sem serializar array em atributo HTML.
const CACHE_LISTA_KPI = {};
function abrirListaModal({ titulo, subtitulo, colunas, linhas }) {
  document.getElementById("ml-titulo").textContent = titulo || "Detalhes";
  document.getElementById("ml-subtitulo").textContent = subtitulo || "";
  document.getElementById("ml-thead").innerHTML = `<tr>${(colunas || []).map((c) => `<th>${esc(c)}</th>`).join("")}</tr>`;
  document.getElementById("ml-tbody").innerHTML = (linhas || []).length
    ? linhas.map((linha) => `<tr>${linha.map((v) => `<td>${v}</td>`).join("")}</tr>`).join("")
    : `<tr><td colspan="${(colunas || []).length || 1}"><div class="empty">Nenhum registro nesse recorte.</div></td></tr>`;
  abrirModal("modal-lista");
}
function abrirListaKpi(chave) {
  const dados = CACHE_LISTA_KPI[chave];
  if (dados) abrirListaModal(dados);
}

// Modal de detalhe genérico — toda linha de tabela e todo card de kanban
// abre isto primeiro (só leitura). "onEditar"/"onExcluir" ficam atrás dos
// botões de editar/excluir lá dentro; passar null esconde o botão correspondente
// (usado por entidades sem edição, ex: cardAdmin sem link pra excluir
// direto). "campos" é um array de [label, valorHtmlJaEscapado]. "cliente"
// (opcional) é { nome, onClick } — acesso rápido ao cadastro do cliente:
// aparece como primeiro campo, "Cliente", com o nome clicável (mesmo
// mecanismo de closure de onEditar/onExcluir, não string de onclick, pra
// não precisar serializar a função).
let detalheAtual = null;
function abrirDetalhe({ titulo, campos, onEditar, onExcluir, cliente }) {
  document.getElementById("mdt-titulo").textContent = titulo;
  const camposHtml = campos.map(([label, valor]) => (
    `<div class="detalhe-campo"><span class="detalhe-label">${esc(label)}</span><span class="detalhe-valor">${valor}</span></div>`
  ));
  if (cliente) {
    camposHtml.unshift(`<div class="detalhe-campo"><span class="detalhe-label">Cliente</span><span class="detalhe-valor"><button type="button" class="link-btn" id="mdt-cliente-link">${esc(cliente.nome || "Ver cliente")}</button></span></div>`);
  }
  document.getElementById("mdt-corpo").innerHTML = camposHtml.join("");
  detalheAtual = { onEditar, onExcluir };
  document.getElementById("mdt-btn-editar").style.display = onEditar ? "" : "none";
  document.getElementById("mdt-btn-excluir").style.display = onExcluir ? "" : "none";
  if (cliente) document.getElementById("mdt-cliente-link").addEventListener("click", cliente.onClick);
  abrirModal("modal-detalhe");
}
document.getElementById("mdt-btn-editar").addEventListener("click", () => {
  if (detalheAtual && detalheAtual.onEditar) {
    pendingDetalheAoFechar = null; // editar avança pra outro modal, não é "voltar"
    fecharModal("modal-detalhe");
    detalheAtual.onEditar();
  }
});
document.getElementById("mdt-btn-excluir").addEventListener("click", () => {
  if (detalheAtual && detalheAtual.onExcluir) {
    pendingDetalheAoFechar = null;
    fecharModal("modal-detalhe");
    detalheAtual.onExcluir();
  }
});

async function chamarAppsScript(action, payload) {
  if (!APPS_SCRIPT_PROXY_URL || APPS_SCRIPT_PROXY_URL.includes("COLE_AQUI")) {
    throw new Error("Configure APPS_SCRIPT_PROXY_URL em firebase-init.js (implante o Code.gs primeiro).");
  }
  const resp = await fetch(APPS_SCRIPT_PROXY_URL, {
    method: "POST",
    body: JSON.stringify({ action, ...payload })
  }).then((r) => r.json());
  if (!resp.ok) throw new Error(resp.erro || "Falha na chamada ao Apps Script.");
  return resp;
}

async function encontrarOuCriarCliente(nome, telefone) {
  nome = (nome || "").trim();
  if (!nome) throw new Error("Informe o nome do cliente.");
  const existente = STATE.clientes.find((c) => c.nome.trim().toLowerCase() === nome.toLowerCase());
  if (existente) return existente;
  const ref = await addDoc(collection(db, "clientes"), {
    nome, telefone: telefone || "", email: "", origem: "", observacoes: "", createdAt: serverTimestamp()
  });
  return { id: ref.id, nome, telefone: telefone || "" };
}

// Combobox de cliente: campo de texto que filtra a lista de clientes já
// cadastrados enquanto digita (sem digitar nada, mostra todos). Só aceita
// prosseguir com um cliente clicado na lista — digitar um nome sem
// selecionar nada não conta como seleção, evitando cadastro por engano.
// Se o nome digitado não bate com nenhum cliente existente, aparece uma
// opção "+ Criar cliente" que cadastra na hora.
function criarComboCliente(inputId, dropdownId, onSelecionar) {
  const input = document.getElementById(inputId);
  const dropdown = document.getElementById(dropdownId);
  const api = { clienteSelecionado: null };

  function renderOpcoes(filtro) {
    const termo = filtro.trim().toLowerCase();
    const encontrados = termo ? STATE.clientes.filter((c) => c.nome.toLowerCase().includes(termo)) : STATE.clientes;
    const existeExato = STATE.clientes.some((c) => c.nome.trim().toLowerCase() === termo);
    let html = encontrados.slice(0, 30).map((c) => (
      `<div class="combo-item" data-id="${esc(c.id)}">${esc(c.nome)}${c.telefone ? ` <span class="combo-item-sub">${esc(c.telefone)}</span>` : ""}</div>`
    )).join("");
    if (termo && !existeExato) {
      html += `<div class="combo-item combo-item-criar" data-criar="1">+ Criar cliente "${esc(filtro.trim())}"</div>`;
    }
    dropdown.innerHTML = html || `<div class="combo-vazio">${termo ? "Nenhum cliente encontrado." : "Nenhum cliente cadastrado ainda."}</div>`;
    dropdown.classList.add("active");
  }

  input.addEventListener("input", () => { api.clienteSelecionado = null; renderOpcoes(input.value); });
  input.addEventListener("focus", () => renderOpcoes(input.value));
  document.addEventListener("click", (e) => {
    if (e.target !== input && !dropdown.contains(e.target)) dropdown.classList.remove("active");
  });
  dropdown.addEventListener("click", async (e) => {
    const itemCriar = e.target.closest("[data-criar]");
    const item = e.target.closest(".combo-item[data-id]");
    if (itemCriar) {
      const nome = input.value.trim();
      if (!nome) return;
      dropdown.classList.remove("active");
      // Abre o cadastro completo do cliente (nome pré-preenchido) em vez
      // de criar na hora só com o nome — contato (telefone/e-mail) e o
      // resto dos dados são preenchidos ali, não neste combobox. Tudo bem
      // deixar em branco por enquanto; só o nome é obrigatório.
      abrirClienteEmbutido((clienteCriado) => {
        if (!clienteCriado) return;
        api.clienteSelecionado = clienteCriado;
        input.value = clienteCriado.nome;
        if (onSelecionar) onSelecionar(clienteCriado);
      }, { nomeInicial: nome });
    } else if (item) {
      const c = STATE.clientes.find((x) => x.id === item.dataset.id);
      if (c) {
        api.clienteSelecionado = c; input.value = c.nome; dropdown.classList.remove("active");
        if (onSelecionar) onSelecionar(c);
      }
    }
  });

  api.reset = () => { api.clienteSelecionado = null; input.value = ""; dropdown.classList.remove("active"); dropdown.innerHTML = ""; };
  // Preenche a seleção programaticamente (ex: reabrir o gerador de
  // contrato já com o cliente da oportunidade que foi arrastada) — não é
  // uma escolha do usuário, mas o valor já é confiável nesses casos.
  api.selecionar = (cliente) => { api.clienteSelecionado = cliente; input.value = cliente ? cliente.nome : ""; };
  return api;
}

const comboAgendamento = criarComboCliente("ma-cliente-busca", "ma-cliente-dropdown", (cliente) => atualizarContatoAgendamento(cliente));
const comboOportunidade = criarComboCliente("mo-cliente-busca", "mo-cliente-dropdown", (cliente) => atualizarContatoOportunidade(cliente));
const comboContrato = criarComboCliente("mct-cliente-busca", "mct-cliente-dropdown", (cliente) => preencherCamposFaltantesContrato(cliente.id));

// Nível de interesse do lead/oportunidade — escala fixa de 5 pontos
// (nunca emoji — regra do segundo-cerebro), tratada como "tag" visual nos
// cards e tabelas (não é uma lista que cresce, então não entra na regra de
// combobox filtrável — é um seletor de 5 botões fixos, tipo avaliação por
// estrelas, com o número servindo de "rótulo" e o tooltip carregando o
// significado qualitativo).
const NIVEL_INTERESSE = {
  1: { label: "Muito desinteressado" },
  2: { label: "Interesse moderadamente baixo" },
  3: { label: "Interesse médio" },
  4: { label: "Interesse moderadamente alto" },
  5: { label: "Muito interessado" }
};
function labelNivelInteresse(n) { return n && NIVEL_INTERESSE[n] ? `${n} — ${NIVEL_INTERESSE[n].label}` : "—"; }

function criarPickerNivelInteresse(containerId) {
  const el = document.getElementById(containerId);
  el.innerHTML = Object.keys(NIVEL_INTERESSE).map((n) => (
    `<button type="button" class="nivel-btn" data-nivel="${n}" title="${esc(NIVEL_INTERESSE[n].label)}">${n}</button>`
  )).join("");
  const api = { valor: null };
  function marcar() {
    el.querySelectorAll(".nivel-btn").forEach((b) => b.classList.toggle("selected", Number(b.dataset.nivel) === api.valor));
  }
  el.querySelectorAll(".nivel-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const n = Number(btn.dataset.nivel);
      api.valor = api.valor === n ? null : n; // clicar de novo no mesmo desmarca
      marcar();
    });
  });
  api.set = (n) => { api.valor = n || null; marcar(); };
  return api;
}
const pickerNivelAgendamento = criarPickerNivelInteresse("ma-nivel-interesse");
const pickerNivelOportunidade = criarPickerNivelInteresse("mo-nivel-interesse");

// Pickers genéricos pros campos de qualificação do cliente — mesmo
// princípio do nível de interesse acima (conjunto fixo e pequeno de
// opções, não uma lista que cresce, então botões em vez de combobox).
function criarPickerOpcaoUnica(containerId, opcoes) {
  const el = document.getElementById(containerId);
  el.innerHTML = opcoes.map((o) => (
    `<button type="button" class="nivel-btn nivel-btn-texto" data-valor="${esc(o.valor)}" title="${esc(o.titulo || o.rotulo)}">${esc(o.rotulo)}</button>`
  )).join("");
  const api = { valor: null };
  function marcar() {
    el.querySelectorAll(".nivel-btn").forEach((b) => b.classList.toggle("selected", b.dataset.valor === api.valor));
  }
  el.querySelectorAll(".nivel-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = btn.dataset.valor;
      api.valor = api.valor === v ? null : v; // clicar de novo no mesmo desmarca
      marcar();
    });
  });
  api.set = (v) => { api.valor = (v == null || v === "") ? null : String(v); marcar(); };
  return api;
}
function criarCheckboxGroup(containerId, opcoes) {
  const el = document.getElementById(containerId);
  el.innerHTML = opcoes.map((o, i) => (
    `<label class="checkbox-field"><input type="checkbox" id="${containerId}-${i}" data-valor="${esc(o)}"> ${esc(o)}</label>`
  )).join("");
  return {
    getSelecionados: () => [...el.querySelectorAll("input[type=checkbox]:checked")].map((c) => c.dataset.valor),
    setSelecionados: (lista) => {
      const set = new Set(lista || []);
      el.querySelectorAll("input[type=checkbox]").forEach((c) => { c.checked = set.has(c.dataset.valor); });
    }
  };
}

const OPCOES_ESTABELECIMENTO = [
  { valor: "ponto_fixo", rotulo: "Ponto fixo" },
  { valor: "remoto_online", rotulo: "Remoto/Online" }
];
const OPCOES_COMPROMETIMENTO = Array.from({ length: 11 }, (_, n) => ({ valor: String(n), rotulo: String(n) }));
const OPCOES_ONDE_TRAVA = [
  "Margem caindo, mesmo vendendo",
  "Não consigo escalar as vendas mesmo tendo equipe",
  "Minha operação não comporta crescer mais",
  "Falta de previsibilidade - mês bom, mês ruim",
  "Gestão de time comercial",
  "Dificuldade em contratar e remunerar time comercial"
];
const LABEL_TIME_COMERCIAL = { "0_1": "0 a 1 vendedores", ate_2: "Até 2 vendedores", ate_3: "Até 3 vendedores", equipe: "Equipe comercial" };
const LABEL_FATURAMENTO = {
  menos_500k: "Menos de R$ 500.000,00",
  "500k_800k": "Entre R$ 500.000,00 e R$ 800.000,00",
  "800k_1_2mi": "Entre R$ 800.000,00 e R$ 1,2 milhão",
  "1_2mi_2mi": "Entre R$ 1,2 milhão e R$ 2 milhões",
  acima_2mi: "Acima de R$ 2 milhões"
};
const LABEL_ESTABELECIMENTO = { ponto_fixo: "Ponto fixo", remoto_online: "Remoto/Online" };

// Qualificação vive no LEAD (agendamento), não no cadastro do cliente —
// um mesmo cliente pode ter mais de um lead ao longo do tempo, e essas
// respostas são específicas de cada conversa de qualificação.
const pickerEstabelecimento = criarPickerOpcaoUnica("ma-estabelecimento", OPCOES_ESTABELECIMENTO);
const pickerComprometimento = criarPickerOpcaoUnica("ma-comprometimento", OPCOES_COMPROMETIMENTO);
const checkboxOndeTrava = criarCheckboxGroup("ma-onde-trava", OPCOES_ONDE_TRAVA);

// Máscara de CPF/CNPJ — detecta pela quantidade de dígitos digitados (até
// 11 = CPF, 12+ = CNPJ) e reformata a cada tecla.
function aplicarMascaraCpfCnpj(valor) {
  const digitos = String(valor || "").replace(/\D/g, "").slice(0, 14);
  if (digitos.length <= 11) {
    return digitos
      .replace(/(\d{3})(\d)/, "$1.$2")
      .replace(/(\d{3})(\d)/, "$1.$2")
      .replace(/(\d{3})(\d{1,2})$/, "$1-$2");
  }
  return digitos
    .replace(/(\d{2})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d)/, "$1/$2")
    .replace(/(\d{4})(\d{1,2})$/, "$1-$2");
}
function wireMascaraCpfCnpj(inputId) {
  document.getElementById(inputId).addEventListener("input", (e) => {
    e.target.value = aplicarMascaraCpfCnpj(e.target.value);
  });
}
wireMascaraCpfCnpj("mc-cpfcnpj");
wireMascaraCpfCnpj("mc-representante-cpf");

// Máscara de telefone — 10 dígitos (DDD + fixo) vira (00) 0000-0000, 11
// dígitos (DDD + celular) vira (00) 00000-0000.
function aplicarMascaraTelefone(valor) {
  const digitos = String(valor || "").replace(/\D/g, "").slice(0, 11);
  if (digitos.length <= 10) {
    return digitos
      .replace(/(\d{2})(\d)/, "($1) $2")
      .replace(/(\d{4})(\d{1,4})$/, "$1-$2");
  }
  return digitos
    .replace(/(\d{2})(\d)/, "($1) $2")
    .replace(/(\d{5})(\d{1,4})$/, "$1-$2");
}
function wireMascaraTelefone(inputId) {
  document.getElementById(inputId).addEventListener("input", (e) => {
    e.target.value = aplicarMascaraTelefone(e.target.value);
  });
}
wireMascaraTelefone("mc-telefone");
wireMascaraTelefone("mct-telefone");
wireMascaraTelefone("mu-telefone");

// Mostra os campos de representante legal só quando o CPF/CNPJ digitado
// tiver mais de 11 dígitos (ou seja, é um CNPJ) — cliente pessoa física
// não tem "representante", é qualificado direto no contrato. Retorna a
// função de atualização pra poder ser chamada de novo depois de um
// preenchimento programático (que não dispara o evento "input").
function wireBlocoRepresentante(cpfCnpjInputId, blocoId) {
  const input = document.getElementById(cpfCnpjInputId);
  const bloco = document.getElementById(blocoId);
  const atualizar = () => { bloco.style.display = apenasDigitos(input.value).length > 11 ? "flex" : "none"; };
  input.addEventListener("input", atualizar);
  atualizar();
  return atualizar;
}
const atualizarBlocoRepresentanteCliente = wireBlocoRepresentante("mc-cpfcnpj", "mc-bloco-representante");

// Busca de endereço com sugestões — usa a API pública do Nominatim
// (OpenStreetMap), gratuita e sem chave/cartão de crédito. O Google
// Places faria a mesma coisa, mas exige criar um projeto no Google Cloud
// com faturamento ativado mesmo pra usar a cota grátis — não é um
// requisito razoável só pra sugestão de endereço. Nunca bloqueia: o campo
// continua um texto livre, a sugestão é só um atalho.
function criarBuscaEndereco(inputId, dropdownId) {
  const input = document.getElementById(inputId);
  const dropdown = document.getElementById(dropdownId);
  let debounceTimer = null;

  async function buscar(termo) {
    if (!termo || termo.trim().length < 4) { dropdown.classList.remove("active"); return; }
    dropdown.innerHTML = `<div class="combo-vazio">Buscando...</div>`;
    dropdown.classList.add("active");
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=0&limit=6&countrycodes=br&q=${encodeURIComponent(termo)}`;
      const resp = await fetch(url, { headers: { "Accept-Language": "pt-BR" } });
      const resultados = await resp.json();
      if (!Array.isArray(resultados) || !resultados.length) {
        dropdown.innerHTML = `<div class="combo-vazio">Nenhum endereço encontrado — pode digitar manualmente.</div>`;
        return;
      }
      dropdown.innerHTML = resultados.map((r, i) => `<div class="combo-item" data-i="${i}">${esc(r.display_name)}</div>`).join("");
      dropdown.querySelectorAll(".combo-item").forEach((item) => {
        item.addEventListener("click", () => {
          input.value = resultados[Number(item.dataset.i)].display_name;
          dropdown.classList.remove("active");
        });
      });
    } catch (err) {
      dropdown.innerHTML = `<div class="combo-vazio">Erro ao buscar — pode digitar manualmente.</div>`;
    }
  }

  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    const termo = input.value;
    debounceTimer = setTimeout(() => buscar(termo), 450);
  });
  document.addEventListener("click", (e) => {
    if (e.target !== input && !dropdown.contains(e.target)) dropdown.classList.remove("active");
  });
}
criarBuscaEndereco("mc-endereco-busca", "mc-endereco-dropdown");

/* ══════════════ NAVEGAÇÃO ══════════════ */

let calendariosCarregados = false;
document.querySelectorAll(".sidebar a[data-view]").forEach((a) => {
  a.addEventListener("click", () => {
    document.querySelectorAll(".sidebar a[data-view]").forEach((x) => x.classList.remove("active"));
    a.classList.add("active");
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    document.getElementById("view-" + a.dataset.view).classList.add("active");
    fecharMenuMobile();
    if (a.dataset.view === "config" && !calendariosCarregados) {
      calendariosCarregados = true;
      carregarListaCalendarios();
    }
  });
});
function fecharMenuMobile() {
  document.getElementById("sidebar").classList.remove("mobile-open");
  document.getElementById("sidebar-backdrop").classList.remove("active");
}
document.getElementById("btn-abrir-menu").addEventListener("click", () => {
  document.getElementById("sidebar").classList.add("mobile-open");
  document.getElementById("sidebar-backdrop").classList.add("active");
});
document.getElementById("sidebar-backdrop").addEventListener("click", fecharMenuMobile);

// Os 3 funis moram numa tela só — o toggle troca qual painel/kanban fica
// visível, sem recarregar nada (os 3 já têm listener próprio rodando).
function selecionarFunil(funil) {
  document.querySelectorAll(".funil-toggle-btn").forEach((b) => b.classList.toggle("active", b.dataset.funil === funil));
  document.querySelectorAll(".funil-pane").forEach((p) => p.classList.toggle("active", p.id === "pane-" + funil));
  localStorage.setItem("jm_funil_ativo", funil);
}
document.querySelectorAll(".funil-toggle-btn").forEach((btn) => {
  btn.addEventListener("click", () => selecionarFunil(btn.dataset.funil));
});
selecionarFunil(localStorage.getItem("jm_funil_ativo") || "agendamento");

/* ══════════════ KANBAN — motor genérico (Pointer Events: mouse + toque) ══════════════
   Reaproveita cards e colunas pros 3 funis (agendamento/vendas/administrativo).
   HTML5 draggable nativo não dispara em toque no iOS/Android — por isso o
   arraste é feito na mão com pointerdown/pointermove/pointerup, com um
   "long press" antes de iniciar o arraste no toque (pra não brigar com o
   scroll vertical da coluna). */
let kbState = null;
let kbLongPress = null;
let kbGlobalReady = false;
let kbLastDragEnd = 0;
const KB_LONGPRESS_MS = 380, KB_LONGPRESS_TOL = 10;
let kbAutoScrollRAF = null, kbAutoScrollWrap = null, kbAutoScrollDir = 0, kbAutoScrollVel = 0;
const KB_AUTOSCROLL_ZONE = 56, KB_AUTOSCROLL_MAXVEL = 16;

function kbHighlightColUnder(x, y) {
  const el = document.elementFromPoint(x, y);
  const col = el ? el.closest(".kanban-col") : null;
  document.querySelectorAll(".kanban-col.kanban-col-dragover").forEach((c) => { if (c !== col) c.classList.remove("kanban-col-dragover"); });
  if (col) col.classList.add("kanban-col-dragover");
  return col;
}
function kbStopAutoScroll() {
  kbAutoScrollDir = 0;
  if (kbAutoScrollRAF) { cancelAnimationFrame(kbAutoScrollRAF); kbAutoScrollRAF = null; }
}
function kbAutoScrollStep() {
  if (!kbAutoScrollDir || !kbState || !kbState.dragging) { kbAutoScrollRAF = null; return; }
  kbAutoScrollWrap.scrollLeft += kbAutoScrollDir * kbAutoScrollVel;
  kbHighlightColUnder(kbState.lastX, kbState.lastY);
  kbAutoScrollRAF = requestAnimationFrame(kbAutoScrollStep);
}
function kbUpdateAutoScroll(wrap, clientX) {
  const rect = wrap.getBoundingClientRect();
  const distL = clientX - rect.left, distR = rect.right - clientX;
  let dir = 0, vel = 0;
  if (distL < KB_AUTOSCROLL_ZONE && wrap.scrollLeft > 0) { dir = -1; vel = KB_AUTOSCROLL_MAXVEL * (1 - Math.max(distL, 0) / KB_AUTOSCROLL_ZONE); }
  else if (distR < KB_AUTOSCROLL_ZONE && wrap.scrollLeft < wrap.scrollWidth - wrap.clientWidth - 1) { dir = 1; vel = KB_AUTOSCROLL_MAXVEL * (1 - Math.max(distR, 0) / KB_AUTOSCROLL_ZONE); }
  kbAutoScrollWrap = wrap; kbAutoScrollDir = dir; kbAutoScrollVel = Math.max(vel, 3);
  if (dir === 0) { kbStopAutoScroll(); return; }
  if (!kbAutoScrollRAF) kbAutoScrollRAF = requestAnimationFrame(kbAutoScrollStep);
}
function kbCancelLongPress() {
  if (kbLongPress) { clearTimeout(kbLongPress.timer); kbLongPress = null; }
}
function kbStartDrag(card, id, wrap, pointerId, clientX, clientY, offsetX, offsetY, width) {
  kbState = { card, id, wrap, pointerId, startX: clientX, startY: clientY, offsetX, offsetY, width, dragging: true, ghost: null, lastX: clientX, lastY: clientY };
  card.classList.add("kcard-dragging");
  try { card.setPointerCapture(pointerId); } catch (e) {}
  const ghost = card.cloneNode(true);
  ghost.classList.add("kcard-ghost");
  ghost.style.width = width + "px";
  document.body.appendChild(ghost);
  ghost.style.left = (clientX - offsetX) + "px";
  ghost.style.top = (clientY - offsetY) + "px";
  kbState.ghost = ghost;
  kbHighlightColUnder(clientX, clientY);
}
function kbOnPointerMove(e) {
  if (kbLongPress && kbLongPress.pointerId === e.pointerId) {
    const dx = e.clientX - kbLongPress.startX, dy = e.clientY - kbLongPress.startY;
    if (Math.abs(dx) > KB_LONGPRESS_TOL || Math.abs(dy) > KB_LONGPRESS_TOL) kbCancelLongPress();
    return;
  }
  const st = kbState;
  if (!st || st.pointerId !== e.pointerId) return;
  if (!st.dragging) {
    const dx = e.clientX - st.startX, dy = e.clientY - st.startY;
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
    st.dragging = true;
    st.card.classList.add("kcard-dragging");
    try { st.card.setPointerCapture(st.pointerId); } catch (err) {}
    const ghost = st.card.cloneNode(true);
    ghost.classList.add("kcard-ghost");
    ghost.style.width = st.width + "px";
    document.body.appendChild(ghost);
    st.ghost = ghost;
  }
  e.preventDefault();
  st.lastX = e.clientX; st.lastY = e.clientY;
  st.ghost.style.left = (e.clientX - st.offsetX) + "px";
  st.ghost.style.top = (e.clientY - st.offsetY) + "px";
  kbHighlightColUnder(e.clientX, e.clientY);
  kbUpdateAutoScroll(st.wrap, e.clientX);
}
function kbOnPointerUp(e) {
  if (kbLongPress && kbLongPress.pointerId === e.pointerId) {
    // pointerup chegou antes do long-press disparar o arraste — no toque,
    // isso é um toque rápido (clique), não uma tentativa de arrastar.
    const lp = kbLongPress;
    kbCancelLongPress();
    onCardClick(lp.wrap.dataset.funil, lp.id);
    return;
  }
  const st = kbState;
  if (!st || st.pointerId !== e.pointerId) return;
  kbState = null;
  kbStopAutoScroll();
  if (!st.dragging) {
    // Mouse: pointerdown sem mover o suficiente pra virar arraste = clique.
    onCardClick(st.wrap.dataset.funil, st.id);
    return;
  }
  const elUnder = document.elementFromPoint(e.clientX, e.clientY);
  const colFinal = elUnder ? elUnder.closest(".kanban-col") : null;
  document.querySelectorAll(".kanban-col.kanban-col-dragover").forEach((c) => c.classList.remove("kanban-col-dragover"));
  st.card.classList.remove("kcard-dragging");
  kbLastDragEnd = Date.now();
  if (st.ghost && st.ghost.parentNode) st.ghost.parentNode.removeChild(st.ghost);
  if (colFinal) {
    const novaEtapa = colFinal.getAttribute("data-etapa");
    const funil = st.wrap.dataset.funil;
    if (novaEtapa) onMoveCard(funil, st.id, novaEtapa);
  }
}
function ativarDragKanban(wrap) {
  if (!kbGlobalReady) {
    kbGlobalReady = true;
    document.addEventListener("pointermove", kbOnPointerMove, { passive: false });
    document.addEventListener("pointerup", kbOnPointerUp);
    document.addEventListener("pointercancel", kbOnPointerUp);
  }
  wrap.querySelectorAll(".kanban-card").forEach((card) => {
    card.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (e.target.closest("[data-kcard-action]")) return;
      const rect = card.getBoundingClientRect();
      const id = card.getAttribute("data-id");
      const offsetX = e.clientX - rect.left, offsetY = e.clientY - rect.top;
      if (e.pointerType === "mouse") {
        kbState = { card, id, wrap, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, offsetX, offsetY, width: rect.width, dragging: false, ghost: null };
        return;
      }
      kbCancelLongPress();
      const pointerId = e.pointerId, clientX = e.clientX, clientY = e.clientY;
      kbLongPress = {
        pointerId, startX: clientX, startY: clientY, card, wrap, id,
        timer: setTimeout(() => {
          kbLongPress = null;
          kbStartDrag(card, id, wrap, pointerId, clientX, clientY, offsetX, offsetY, rect.width);
        }, KB_LONGPRESS_MS)
      };
    });
  });
}

// Toggle Kanban/Lista + filtro de período, comum aos 3 funis. "Lista" é uma
// tabela achatada (sem colunas por etapa) — útil quando tem muito card e
// arrastar deixa de ser prático; o período filtra por data de CRIAÇÃO do
// card (mesmo campo/mesmo cuidado de fuso do Relatório do Funil).
function periodoPresetParaRange(preset, custom) {
  const hoje = hojeStr();
  if (preset === "hoje") return { de: hoje, ate: hoje };
  if (preset === "7dias") return { de: addDias(hoje, -6), ate: hoje };
  if (preset === "15dias") return { de: addDias(hoje, -14), ate: hoje };
  if (preset === "mes") return { de: primeiroDiaMes(), ate: ultimoDiaMes() };
  if (preset === "personalizado") return { de: custom.de || "", ate: custom.ate || "" };
  return { de: "", ate: "" }; // "tudo"
}
function filtrarCardsPorPeriodoFunil(cards, funil) {
  const { de, ate } = periodoPresetParaRange(STATE.funilPeriodoPreset[funil], STATE.funilPeriodoCustom[funil]);
  if (!de && !ate) return cards;
  return cards.filter((c) => {
    const data = dataLocalDeTimestamp(c.createdAt);
    return (!de || data >= de) && (!ate || data <= ate);
  });
}

// Busca sem acento e sem caixa: quem digita "joao" acha "João", que é o
// caso real de quem procura um lead com o telefone tocando.
function normalizarBusca(texto) {
  return String(texto || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * Período + busca, na mesma passada. As duas visões (Kanban e Lista) leem
 * daqui, então o que a busca esconde some das duas — sem isso, o número da
 * coluna do Kanban discordaria da lista logo ao lado.
 *
 * "textoDoCard" é a única parte que cada funil precisa dizer: o resto do
 * filtro é igual pros três.
 */
function filtrarCardsFunil(cards, funil, etapasRaw, textoDoCard) {
  const doPeriodo = filtrarCardsPorPeriodoFunil(cards, funil);
  const termo = normalizarBusca(STATE.buscaFunil[funil]).trim();
  if (!termo) return doPeriodo;
  return doPeriodo.filter((c) => {
    const etapaCfg = etapasRaw.find((e) => e.id === c.etapa);
    const alvo = [textoDoCard(c), etapaCfg ? etapaCfg.nome : "", fmtData(dataLocalDeTimestamp(c.createdAt))].join(" ");
    return normalizarBusca(alvo).includes(termo);
  });
}

/**
 * KPIs de topo dos funis (crença 17: toda tela de listagem mostra os
 * próprios números). Os três funis usam esta função pra que "atrasados"
 * signifique a MESMA coisa nos três — SLA vermelho, calculado pela mesma
 * função que pinta a bolinha do card, nunca uma segunda régua.
 */
function kpisFunil(cards, etapasRaw, extras) {
  const atrasados = cards.filter((c) => {
    const sla = calcularStatusSla(c.dataEntrouEtapa, etapasRaw.find((e) => e.id === c.etapa));
    return sla && sla.cor === "vermelho";
  }).length;
  return [...extras, { tag: "Atrasados", num: String(atrasados), sub: "no vermelho do SLA" }]
    .map((k) => `<div class="funil-kpi"><div class="tag">${esc(k.tag)}</div><div class="num">${k.num}</div>${k.sub ? `<div class="sub">${esc(k.sub)}</div>` : ""}</div>`)
    .join("");
}
/**
 * Ordena a lista pelo campo escolhido no cabeçalho. Só os campos que a
 * tabela mostra, e sempre com um critério de desempate estável (data de
 * criação), senão duas linhas iguais trocam de lugar a cada render e a
 * tela "pisca" sozinha.
 */
function ordenarLinhasFunil(cards, funil, etapasRaw) {
  const { campo, desc } = STATE.ordemLista[funil];
  const criadoEm = (c) => c.createdAt?.seconds || 0;
  // Card sem data de entrada na etapa não tem SLA nenhum (a coluna mostra
  // "—"). Ele vai pro fim nas DUAS direções: sem isso, o primeiro clique em
  // SLA, que deveria trazer o mais atrasado, traria justamente as linhas que
  // não têm atraso pra mostrar.
  const semDado = (c) => campo === "sla" && !(c.dataEntrouEtapa?.toDate ? c.dataEntrouEtapa.toDate() : null);
  const chave = (c) => {
    if (campo === "cliente") return normalizarBusca(c.clienteNome || "");
    if (campo === "etapa") {
      const e = etapasRaw.find((x) => x.id === c.etapa);
      // Por ORDEM da etapa, não por nome: o funil tem uma sequência, e
      // ordenar alfabeticamente embaralharia essa sequência.
      return e ? e.ordem : 9999;
    }
    if (campo === "sla") {
      // Tempo PARADO na etapa, não a data de entrada. Assim "maior primeiro"
      // (que é o primeiro clique) quer dizer "mais atrasado primeiro", que é
      // o que se espera de uma coluna de SLA.
      const d = c.dataEntrouEtapa.toDate ? c.dataEntrouEtapa.toDate() : new Date(c.dataEntrouEtapa);
      return Date.now() - d.getTime();
    }
    return criadoEm(c);
  };
  return cards.slice().sort((a, b) => {
    const va = semDado(a), vb = semDado(b);
    if (va !== vb) return va ? 1 : -1;
    if (va && vb) return criadoEm(b) - criadoEm(a);
    const ka = chave(a), kb = chave(b);
    if (ka < kb) return desc ? 1 : -1;
    if (ka > kb) return desc ? -1 : 1;
    return criadoEm(b) - criadoEm(a);
  });
}

function renderListaFunil(funil, cards, etapasRaw, getEtapaFn, detalheFn) {
  const linhas = ordenarLinhasFunil(cards, funil, etapasRaw);
  const { campo, desc } = STATE.ordemLista[funil];
  document.querySelectorAll(`#lista-${funil} th[data-ordenar]`).forEach((th) => {
    const ativo = th.dataset.ordenar === campo;
    th.classList.toggle("ordenado", ativo);
    th.classList.toggle("ordenado-asc", ativo && !desc);
  });
  document.getElementById(`lista-${funil}-corpo`).innerHTML = linhas.length ? linhas.map((c) => {
    const etapaCfg = etapasRaw.find((e) => e.id === getEtapaFn(c));
    return `<tr class="linha-clicavel" onclick="window.__jm.onCardClick('${funil}','${esc(c.id)}')">
      <td>${esc(c.clienteNome || "—")}</td>
      <td>${esc(etapaCfg ? etapaCfg.nome : "—")}</td>
      <td>${detalheFn(c)}</td>
      <td>${renderBadgeSla(c.dataEntrouEtapa, etapaCfg) || "—"}</td>
      <td>${fmtData(dataLocalDeTimestamp(c.createdAt))}</td>
    </tr>`;
  }).join("") : `<tr><td colspan="5"><div class="empty">Nenhum card nesse recorte.</div></td></tr>`;
}

/**
 * Telefone com um clique pra copiar. O stopPropagation não é detalhe: o
 * telefone vive dentro de uma linha/card que abre o detalhe ao ser clicado,
 * e sem isso copiar o número abriria o cadastro por cima.
 */
function telefoneCopiavel(telefone) {
  if (!telefone) return "—";
  return `<span class="tel-copiar" title="Clique para copiar" onclick="event.stopPropagation();window.__jm.copiarTelefone('${esc(telefone)}',this)">${esc(telefone)}</span>`;
}
function copiarTelefone(telefone, el) {
  navigator.clipboard.writeText(telefone).then(() => {
    mostrarToast("Telefone copiado.");
    if (el) { el.classList.add("copiado"); setTimeout(() => el.classList.remove("copiado"), 900); }
  }).catch(() => mostrarErro("Não foi possível copiar. Copie manualmente: " + telefone));
}
// Liga o par de botões Kanban/Lista e o grupo de período pra um funil —
// chamado uma vez por funil, na carga do módulo (os elementos já existem
// no HTML, e re-renderizar só troca o conteúdo dos containers, nunca os
// wrappers). "aoMudar" é o próprio renderKanbanX(), que já sabe montar as
// duas visões a partir do STATE atual.
function wireToggleFunil(funil, aoMudar) {
  const grupoView = document.getElementById(`view-toggle-${funil}`);
  grupoView.querySelectorAll(".view-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      grupoView.querySelectorAll(".view-toggle-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      STATE.funilView[funil] = btn.dataset.view;
      document.getElementById(`kanban-${funil}`).style.display = btn.dataset.view === "kanban" ? "" : "none";
      document.getElementById(`lista-${funil}`).style.display = btn.dataset.view === "lista" ? "" : "none";
    });
  });
  const grupoPeriodo = document.getElementById(`periodo-toggle-${funil}`);
  const custom = document.getElementById(`periodo-custom-${funil}`);
  grupoPeriodo.querySelectorAll(".periodo-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      grupoPeriodo.querySelectorAll(".periodo-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      STATE.funilPeriodoPreset[funil] = btn.dataset.periodo;
      custom.style.display = btn.dataset.periodo === "personalizado" ? "flex" : "none";
      aoMudar();
    });
  });
  custom.querySelector(".pf-de").addEventListener("change", (e) => {
    STATE.funilPeriodoCustom[funil].de = e.target.value || "";
    aoMudar();
  });
  custom.querySelector(".pf-ate").addEventListener("change", (e) => {
    STATE.funilPeriodoCustom[funil].ate = e.target.value || "";
    aoMudar();
  });

  document.getElementById(`busca-${funil}`).addEventListener("input", (e) => {
    STATE.buscaFunil[funil] = e.target.value || "";
    aoMudar();
  });

  document.querySelectorAll(`#lista-${funil} th[data-ordenar]`).forEach((th) => {
    th.addEventListener("click", () => {
      const atual = STATE.ordemLista[funil];
      // Clicar de novo na mesma coluna inverte; coluna nova começa
      // decrescente, que é o que quase sempre se quer ver primeiro.
      STATE.ordemLista[funil] = atual.campo === th.dataset.ordenar
        ? { campo: atual.campo, desc: !atual.desc }
        : { campo: th.dataset.ordenar, desc: true };
      aoMudar();
    });
  });
}

function renderKanban(wrapId, funilKey, colunas, cards, getEtapaFn, renderCardContentFn) {
  const wrap = document.getElementById(wrapId);
  wrap.dataset.funil = funilKey;
  const porEtapa = {};
  colunas.forEach((c) => { porEtapa[c.id] = []; });
  cards.forEach((c) => {
    const e = getEtapaFn(c);
    if (!porEtapa[e]) porEtapa[e] = [];
    porEtapa[e].push(c);
  });
  wrap.innerHTML = colunas.map((col) => {
    const lista = porEtapa[col.id] || [];
    const cardsHtml = lista.length
      ? lista.map((c) => `<div class="kanban-card" data-id="${esc(c.id)}">${renderCardContentFn(c)}</div>`).join("")
      : `<div class="kanban-col-empty">Vazio.</div>`;
    return `<div class="kanban-col" data-etapa="${esc(col.id)}">
      <div class="kanban-col-head"><div class="kc-top"><span class="kc-dot"></span><div class="kc-nome">${esc(col.nome)}</div></div><div class="kc-sub">${lista.length} card(s)</div></div>
      <div class="kanban-col-body" data-etapa="${esc(col.id)}">${cardsHtml}</div>
    </div>`;
  }).join("");
  ativarDragKanban(wrap);
}

function onMoveCard(funil, cardId, novaEtapa) {
  if (funil === "agendamento") moverAgendamento(cardId, novaEtapa);
  else if (funil === "vendas") moverOportunidade(cardId, novaEtapa);
  else if (funil === "administrativo") moverCardAdmin(cardId, novaEtapa);
}

function onCardClick(funil, cardId) {
  if (funil === "agendamento") abrirDetalheAgendamento(cardId);
  else if (funil === "vendas") abrirDetalheOportunidade(cardId);
  else if (funil === "administrativo") abrirDetalheCardAdmin(cardId);
}

/* ══════════════ FUNIL DE AGENDAMENTO ══════════════ */

function renderCardAgendamento(a) {
  const etapaCfg = STATE.etapasAgendamento.find((e) => e.id === a.etapa);
  return `
    <div class="kcard-nome">${esc(a.clienteNome)}${a.nivelInteresse ? ` <span class="kcard-nivel" title="${esc(labelNivelInteresse(a.nivelInteresse))}">${a.nivelInteresse}</span>` : ""}</div>
    <div class="kcard-sub">${esc(a.telefone || "")}</div>
    <div class="kcard-foot">
      <span class="kcard-prazo">${a.data ? `${fmtData(a.data)} ${esc(a.hora || "")}` : ""}</span>
      ${renderBadgeSla(a.dataEntrouEtapa, etapaCfg)}
    </div>
    ${a.motivoPerda ? `<div class="sublabel" style="margin-top:6px;">Motivo: ${esc(a.motivoPerda)}</div>` : ""}
  `;
}

function colunasAgendamento() {
  return [...STATE.etapasAgendamento].sort((a, b) => a.ordem - b.ordem).map((e) => ({ id: e.id, nome: e.nome }));
}

function renderKanbanAgendamento() {
  const cards = filtrarCardsFunil(STATE.agendamentos, "agendamento", STATE.etapasAgendamento,
    (a) => [a.clienteNome, a.telefone, a.email, a.instagram, a.observacoes, a.motivoPerda].join(" "));
  renderKanban("kanban-agendamento", "agendamento", colunasAgendamento(), cards, (a) => a.etapa, renderCardAgendamento);
  renderListaFunil("agendamento", cards, STATE.etapasAgendamento, (a) => a.etapa,
    (a) => `${telefoneCopiavel(a.telefone)}${a.data ? ` · ${fmtData(a.data)} ${esc(a.hora || "")}` : ""}`);

  const comAgenda = cards.filter((a) => !!a.data).length;
  document.getElementById("agendamento-kpis").innerHTML = kpisFunil(cards, STATE.etapasAgendamento, [
    { tag: "Leads no recorte", num: String(cards.length), sub: "período e busca aplicados" },
    { tag: "Com data marcada", num: String(comAgenda), sub: "reunião já agendada" }
  ]);
}
wireToggleFunil("agendamento", renderKanbanAgendamento);

// Duas travas independentes por etapa (configuráveis em Configurações →
// Funil de Agendamento), porque "Reagendar" precisa da mesma exigência de
// contato que "Agendado" sem disparar a automação de Vendas/Agenda
// (só "entraFunilVendas" dispara isso, e só "Agendado" tem essa flag por
// padrão):
//   exigeContato        → telefone, e-mail e origem (cadastro do cliente)
//                         e data/hora (do agendamento) precisam existir.
//   exigeQualificacao   → dados de qualificação DO LEAD (Instagram,
//                         estabelecimento, time comercial, faturamento,
//                         onde trava, comprometimento, nível de
//                         interesse) precisam existir — ficam no
//                         agendamento, não no cadastro do cliente, porque
//                         um mesmo cliente pode ter mais de um lead ao
//                         longo do tempo com respostas diferentes.
// Nenhuma das duas trava a etapa de perda (checada antes, abaixo).
function requisitosFaltantesEtapa(etapaCfg, cliente, ag) {
  const faltando = [];
  if (!etapaCfg) return faltando;
  if (etapaCfg.exigeContato) {
    if (!cliente?.telefone) faltando.push("telefone");
    if (!cliente?.email) faltando.push("e-mail");
    if (!cliente?.origem) faltando.push("origem do lead");
    if (!ag?.data) faltando.push("data/hora do agendamento");
  }
  if (etapaCfg.exigeQualificacao) {
    if (!ag?.instagram) faltando.push("Instagram da empresa");
    if (!ag?.estabelecimento) faltando.push("estabelecimento (ponto fixo/remoto)");
    if (!ag?.timeComercial) faltando.push("time comercial");
    if (!ag?.faturamento6meses) faltando.push("faturamento dos últimos 6 meses");
    if (!(ag?.ondeTrava && ag.ondeTrava.length)) faltando.push("onde a empresa trava");
    if (ag?.comprometimento == null) faltando.push("nível de comprometimento (0 a 10)");
    if (ag?.nivelInteresse == null) faltando.push("nível de interesse");
  }
  return faltando;
}

async function moverAgendamento(id, novaEtapa) {
  const ag = STATE.agendamentos.find((a) => a.id === id);
  if (!ag || ag.etapa === novaEtapa) return;
  const etapaCfg = STATE.etapasAgendamento.find((e) => e.id === novaEtapa);

  if (etapaCfg && etapaCfg.perda) {
    pendingPerda = { colecao: "agendamentos", id };
    document.getElementById("mp-motivo").value = "";
    abrirModal("modal-perda");
    return;
  }

  // Contato e data vêm do CADASTRO DO CLIENTE / do próprio agendamento, não
  // de um campo digitado aqui — contato só se edita na ficha do cliente,
  // via "Editar cliente" dentro do modal do lead. Sem tudo preenchido,
  // abre o modal pedindo antes de completar o movimento; em qualquer
  // etapa sem essas exigências o card transita livre, sem pedir nada.
  const clienteDoLead = STATE.clientes.find((c) => c.id === ag.clienteId);
  const faltando = requisitosFaltantesEtapa(etapaCfg, clienteDoLead, ag);
  if (faltando.length) {
    mostrarErro(`Pra mover pra "${etapaCfg.nome}", ainda falta: ${faltando.join(", ")}.`);
    pendingAgendamentoMoveEtapa = novaEtapa;
    editarAgendamento(id, { confirmarAgendamento: !!etapaCfg.exigeContato, viaGateMovimento: true });
    return;
  }

  try {
    await updateDoc(doc(db, "agendamentos", id), { etapa: novaEtapa, dataEntrouEtapa: serverTimestamp(), updatedAt: serverTimestamp() });
    await addDoc(collection(db, "agendamentos", id, "historico"), { tipo: "mudanca_etapa", de: ag.etapa, para: novaEtapa, timestamp: serverTimestamp() });
    if (etapaCfg && etapaCfg.entraFunilVendas) await processarAgendamentoAgendado(id, { ...ag, etapa: novaEtapa });
  } catch (err) { mostrarErro("Não foi possível mover: " + err.message); }
}

// Mostra o contato do cliente selecionado no lead (só leitura — editar
// contato é sempre pela ficha do cliente, nunca aqui) e liga/desliga o
// botão "Editar cliente" conforme tem alguém selecionado ou não.
function atualizarContatoAgendamento(cliente) {
  const el = document.getElementById("ma-contato-cliente");
  const btn = document.getElementById("ma-btn-editar-cliente");
  if (!cliente) { el.textContent = "Selecione um cliente."; btn.disabled = true; return; }
  btn.disabled = false;
  el.textContent = `Tel: ${cliente.telefone || "não cadastrado"} · E-mail: ${cliente.email || "não cadastrado"} · Origem: ${cliente.origem || "não cadastrada"}`;
}

// Só a etapa marcada "entra automaticamente no Funil de Vendas" (por
// padrão, só "Agendado") dispara isso — o card já entra como novo lead e
// o evento já vai pra Agenda, sem precisar de botão manual. É a ÚNICA
// automação do funil de Agendamento; todas as outras etapas são só pra
// acompanhamento manual (arrastar livremente). Chamado tanto na criação
// (se a 1ª etapa já tiver a flag) quanto ao arrastar um card pra essa
// etapa. As duas metades (criar oportunidade / lançar na Agenda) são
// independentes: uma falhar não deve impedir a outra, e os flags
// "convertido"/"enviadoAgenda" evitam duplicar em re-execuções.
async function processarAgendamentoAgendado(agendamentoId, dados) {
  if (!dados.convertido) {
    const primeiraEtapaVenda = [...STATE.etapasVenda].sort((a, b) => a.ordem - b.ordem)[0];
    if (!primeiraEtapaVenda) {
      mostrarErro("Cadastre ao menos uma etapa do Funil de Vendas em Configurações — o agendamento foi salvo, mas ainda não virou oportunidade.");
    } else {
      try {
        await addDoc(collection(db, "oportunidades"), {
          clienteId: dados.clienteId || null, clienteNome: dados.clienteNome, telefone: dados.telefone || "",
          email: dados.email || "", nivelInteresse: dados.nivelInteresse || null,
          instagram: dados.instagram || "", estabelecimento: dados.estabelecimento || null,
          timeComercial: dados.timeComercial || null, faturamento6meses: dados.faturamento6meses || null,
          ondeTrava: dados.ondeTrava || [], comprometimento: dados.comprometimento != null ? dados.comprometimento : null,
          data: dados.data || "", hora: dados.hora || "",
          agendamentoId, etapa: primeiraEtapaVenda.id, valorProposto: 0, observacoes: dados.observacoes || "",
          perdida: false, motivoPerda: "", fechada: false,
          dataEntrouEtapa: serverTimestamp(), createdAt: serverTimestamp(), updatedAt: serverTimestamp()
        });
        await updateDoc(doc(db, "agendamentos", agendamentoId), { convertido: true });
      } catch (err) { mostrarErro("Não foi possível criar a oportunidade: " + err.message); }
    }
  }
  if (!dados.enviadoAgenda) {
    try {
      const calendarId = STATE.config.calendarioAgendaId || undefined;
      // Assume que o fuso do navegador de quem usa o sistema é o mesmo do
      // projeto Apps Script (Brasil) — sem isso, "hora" pode cair errado
      // na Agenda. Ver README se algum dia isso passar a ser um problema.
      const inicioISO = `${dados.data}T${dados.hora || "09:00"}:00`;
      const resp = await chamarAppsScript("criarEventoAgenda", {
        calendarId, clienteNome: dados.clienteNome, clienteEmail: dados.email || "", observacoes: dados.observacoes || "", inicio: inicioISO
      });
      await updateDoc(doc(db, "agendamentos", agendamentoId), { enviadoAgenda: true, googleEventId: resp.googleEventId || null });
    } catch (err) {
      mostrarErro("Agendamento salvo, mas não foi possível criar o evento na Agenda: " + err.message);
    }
  }
}

// Exclusão em cascata do histórico — sem isso, o subdocumento fica órfão
// no Firestore pra sempre (as regras já permitem apagar `historico`
// especificamente por causa disso). Compartilhada pelos 3 funis.
async function excluirComHistorico(colecao, id) {
  const historicoSnap = await getDocs(collection(db, colecao, id, "historico"));
  for (const d of historicoSnap.docs) await deleteDoc(d.ref);
  await deleteDoc(doc(db, colecao, id));
}

async function excluirAgendamento(id) {
  if (!(await confirmarAcao("Excluir este agendamento?"))) return;
  try { await excluirComHistorico("agendamentos", id); } catch (err) { mostrarErro(err.message); }
}

// Qualificação vive no LEAD, não no cliente — um mesmo cliente pode gerar
// mais de um lead ao longo do tempo, cada um com suas próprias respostas.
function resetCamposQualificacaoAgendamento() {
  document.getElementById("ma-instagram").value = "";
  pickerEstabelecimento.set(null);
  document.getElementById("ma-time-comercial").value = "";
  document.getElementById("ma-faturamento").value = "";
  checkboxOndeTrava.setSelecionados([]);
  pickerComprometimento.set(null);
}
function preencherCamposQualificacaoAgendamento(a) {
  document.getElementById("ma-instagram").value = a.instagram || "";
  pickerEstabelecimento.set(a.estabelecimento || null);
  document.getElementById("ma-time-comercial").value = a.timeComercial || "";
  document.getElementById("ma-faturamento").value = a.faturamento6meses || "";
  checkboxOndeTrava.setSelecionados(a.ondeTrava || []);
  pickerComprometimento.set(a.comprometimento != null ? String(a.comprometimento) : null);
}

document.getElementById("btn-novo-agendamento").addEventListener("click", () => {
  pendingAgendamentoEditId = null;
  pendingAgendamentoMoveEtapa = null;
  document.getElementById("modal-agendamento-titulo").textContent = "Novo lead";
  comboAgendamento.reset();
  atualizarContatoAgendamento(null);
  document.getElementById("ma-data").value = "";
  document.getElementById("ma-hora").value = "";
  document.getElementById("ma-obs").value = "";
  pickerNivelAgendamento.set(null);
  resetCamposQualificacaoAgendamento();
  document.getElementById("ma-campos-agendamento").style.display = "none";
  abrirModal("modal-agendamento");
});
document.getElementById("ma-btn-editar-cliente").addEventListener("click", () => {
  const cliente = comboAgendamento.clienteSelecionado;
  if (!cliente || !cliente.id) { mostrarErro("Selecione (ou crie) um cliente antes de editar o contato."); return; }
  abrirClienteEmbutido((clienteAtualizado) => {
    if (!clienteAtualizado) return;
    comboAgendamento.selecionar(clienteAtualizado);
    atualizarContatoAgendamento(clienteAtualizado);
  }, { clienteId: cliente.id });
});
// opts.confirmarAgendamento: chamado pelo gate de mover pra "Agendado" —
// nesse caso o bloco de data/hora aparece e fica implícito que é pra
// preencher agora. Fora disso (editar um lead comum, ou o "Editar cliente" do modal de
// detalhe) o bloco só aparece se o lead já tiver data salva.
function editarAgendamento(id, opts = {}) {
  const a = STATE.agendamentos.find((x) => x.id === id);
  if (!a) return;
  pendingAgendamentoEditId = id;
  // "viaGateMovimento" (setado só pelo gate de mover etapa, não pelo "Editar cliente" de
  // edição normal) é quem decide se um pendingAgendamentoMoveEtapa já
  // setado deve ser preservado — não dá pra usar "confirmarAgendamento"
  // pra isso, porque uma etapa pode exigir qualificação sem exigir
  // contato (confirmarAgendamento fica false, mas o movimento continua
  // pendente).
  if (!opts.viaGateMovimento) pendingAgendamentoMoveEtapa = null;
  document.getElementById("modal-agendamento-titulo").textContent = opts.confirmarAgendamento
    ? `Confirmar agendamento — ${a.clienteNome}`
    : `Editar lead — ${a.clienteNome}`;
  const clienteDoLead = STATE.clientes.find((c) => c.id === a.clienteId)
    || { id: a.clienteId || null, nome: a.clienteNome, telefone: a.telefone || "", email: a.email || "" };
  comboAgendamento.selecionar(clienteDoLead);
  atualizarContatoAgendamento(clienteDoLead);
  document.getElementById("ma-data").value = a.data || (opts.confirmarAgendamento ? hojeStr() : "");
  document.getElementById("ma-hora").value = a.hora || "";
  document.getElementById("ma-obs").value = a.observacoes || "";
  pickerNivelAgendamento.set(a.nivelInteresse || null);
  preencherCamposQualificacaoAgendamento(a);
  document.getElementById("ma-campos-agendamento").style.display = (opts.confirmarAgendamento || a.data) ? "" : "none";
  abrirModal("modal-agendamento");
}
function lerCamposQualificacaoAgendamento() {
  return {
    instagram: document.getElementById("ma-instagram").value.trim(),
    estabelecimento: pickerEstabelecimento.valor,
    timeComercial: document.getElementById("ma-time-comercial").value,
    faturamento6meses: document.getElementById("ma-faturamento").value,
    ondeTrava: checkboxOndeTrava.getSelecionados(),
    comprometimento: pickerComprometimento.valor != null ? Number(pickerComprometimento.valor) : null
  };
}
document.getElementById("btn-salvar-agendamento").addEventListener("click", async () => {
  const cliente = comboAgendamento.clienteSelecionado;
  if (!cliente) { mostrarErro("Selecione um cliente da lista, ou clique em \"+ Criar cliente\" pra cadastrar um novo."); return; }
  const qualificacao = lerCamposQualificacaoAgendamento();

  if (pendingAgendamentoEditId) {
    const dataEditada = document.getElementById("ma-data").value || "";
    const nivelEditado = pickerNivelAgendamento.valor;
    if (pendingAgendamentoMoveEtapa) {
      const etapaAlvo = STATE.etapasAgendamento.find((e) => e.id === pendingAgendamentoMoveEtapa);
      const faltando = requisitosFaltantesEtapa(etapaAlvo, cliente, { data: dataEditada, nivelInteresse: nivelEditado, ...qualificacao });
      if (faltando.length) { mostrarErro(`Ainda falta: ${faltando.join(", ")} — clique em "Editar cliente" se for algo do cadastro.`); return; }
    }
    try {
      const agendamentoOriginal = STATE.agendamentos.find((a) => a.id === pendingAgendamentoEditId);
      await updateDoc(doc(db, "agendamentos", pendingAgendamentoEditId), {
        clienteId: cliente.id, clienteNome: cliente.nome,
        telefone: cliente.telefone || "",
        email: cliente.email || "",
        nivelInteresse: nivelEditado,
        ...qualificacao,
        data: dataEditada,
        hora: document.getElementById("ma-hora").value || "",
        observacoes: document.getElementById("ma-obs").value.trim(),
        updatedAt: serverTimestamp()
      });
      // Se a edição foi disparada por uma tentativa de arrastar pra uma
      // etapa que exigia telefone, completa o movimento agora que ele foi
      // preenchido — sem isso o card ficaria só editado, sem nunca chegar
      // na etapa que o usuário arrastou.
      const confirmandoAgendamento = !!pendingAgendamentoMoveEtapa;
      if (pendingAgendamentoMoveEtapa) {
        const novaEtapa = pendingAgendamentoMoveEtapa;
        pendingAgendamentoMoveEtapa = null;
        const etapaCfg = STATE.etapasAgendamento.find((e) => e.id === novaEtapa);
        await updateDoc(doc(db, "agendamentos", pendingAgendamentoEditId), { etapa: novaEtapa, dataEntrouEtapa: serverTimestamp() });
        await addDoc(collection(db, "agendamentos", pendingAgendamentoEditId, "historico"), {
          tipo: "mudanca_etapa", de: agendamentoOriginal ? agendamentoOriginal.etapa : null, para: novaEtapa, timestamp: serverTimestamp()
        });
        if (etapaCfg && etapaCfg.entraFunilVendas) {
          await processarAgendamentoAgendado(pendingAgendamentoEditId, {
            clienteId: cliente.id, clienteNome: cliente.nome, telefone: cliente.telefone || "", email: cliente.email || "", nivelInteresse: nivelEditado,
            ...qualificacao,
            data: document.getElementById("ma-data").value, hora: document.getElementById("ma-hora").value,
            observacoes: document.getElementById("ma-obs").value.trim(),
            convertido: agendamentoOriginal ? agendamentoOriginal.convertido : false,
            enviadoAgenda: agendamentoOriginal ? agendamentoOriginal.enviadoAgenda : false
          });
        }
      }
      fecharModal("modal-agendamento");
      pendingAgendamentoEditId = null;
      mostrarToast(confirmandoAgendamento ? "Agendamento confirmado." : "Lead atualizado.");
    } catch (err) { mostrarErro(err.message); }
    return;
  }

  const primeiraEtapa = [...STATE.etapasAgendamento].sort((a, b) => a.ordem - b.ordem)[0];
  if (!primeiraEtapa) { mostrarErro("Cadastre ao menos uma etapa do Funil de Agendamento em Configurações."); return; }
  const dataNova = document.getElementById("ma-data").value || "";
  // Normalmente a 1ª etapa é "Novo Lead" (sem exigências), então um lead
  // novo não pede nada — só se alguém configurar o funil pra já nascer
  // direto numa etapa com exigeContato/exigeQualificacao.
  const faltandoCriacao = requisitosFaltantesEtapa(primeiraEtapa, cliente, { data: dataNova, nivelInteresse: pickerNivelAgendamento.valor, ...qualificacao });
  if (faltandoCriacao.length) { mostrarErro(`Pra criar direto em "${primeiraEtapa.nome}", falta: ${faltandoCriacao.join(", ")}.`); return; }
  const dados = {
    clienteId: cliente.id, clienteNome: cliente.nome,
    telefone: cliente.telefone || "",
    email: cliente.email || "",
    nivelInteresse: pickerNivelAgendamento.valor,
    ...qualificacao,
    data: dataNova,
    hora: document.getElementById("ma-hora").value || "",
    etapa: primeiraEtapa.id, googleEventId: null, convertido: false, enviadoAgenda: false, motivoPerda: "",
    observacoes: document.getElementById("ma-obs").value.trim()
  };
  try {
    const ref = await addDoc(collection(db, "agendamentos"), { ...dados, dataEntrouEtapa: serverTimestamp(), createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    fecharModal("modal-agendamento");
    mostrarToast("Lead criado.");
    if (primeiraEtapa.entraFunilVendas) await processarAgendamentoAgendado(ref.id, dados);
  } catch (err) { mostrarErro(err.message); }
});

function abrirDetalheAgendamento(id) {
  const a = STATE.agendamentos.find((x) => x.id === id);
  if (!a) return;
  const etapaCfg = STATE.etapasAgendamento.find((e) => e.id === a.etapa);
  const clienteDoLead = STATE.clientes.find((c) => c.id === a.clienteId);
  abrirDetalhe({
    titulo: a.clienteNome,
    campos: [
      ["Origem do lead", esc((clienteDoLead && clienteDoLead.origem) || "—")],
      ["Telefone", esc(a.telefone || "—")],
      ["E-mail", esc(a.email || "—")],
      ["Instagram da empresa", esc(a.instagram || "—")],
      ["Estabelecimento", esc(LABEL_ESTABELECIMENTO[a.estabelecimento] || "—")],
      ["Time comercial", esc(LABEL_TIME_COMERCIAL[a.timeComercial] || "—")],
      ["Faturamento (últimos 6 meses)", esc(LABEL_FATURAMENTO[a.faturamento6meses] || "—")],
      ["Onde a empresa trava", (a.ondeTrava && a.ondeTrava.length) ? esc(a.ondeTrava.join("; ")) : "—"],
      ["Comprometimento (0 a 10)", a.comprometimento != null ? `${a.comprometimento}/10` : "—"],
      ["Nível de interesse", esc(labelNivelInteresse(a.nivelInteresse))],
      ["Data", esc(fmtData(a.data))],
      ["Hora", esc(a.hora || "—")],
      ["Etapa", esc(etapaCfg ? etapaCfg.nome : "—")],
      ["Observações", esc(a.observacoes || "—")],
      ["Já virou oportunidade?", a.convertido ? "Sim" : "Não"],
      ["Evento criado na Agenda?", a.enviadoAgenda ? "Sim" : "Não"],
      ...(a.motivoPerda ? [["Motivo da perda", esc(a.motivoPerda)]] : [])
    ],
    onEditar: () => editarAgendamento(id),
    onExcluir: () => excluirAgendamento(id),
    cliente: a.clienteId ? { nome: a.clienteNome, onClick: () => abrirDetalheCliente(a.clienteId, () => abrirDetalheAgendamento(id)) } : null
  });
}

/* ══════════════ FUNIL DE VENDAS ══════════════ */

function colunasVendas() {
  return [...STATE.etapasVenda].sort((a, b) => a.ordem - b.ordem).map((e) => ({ id: e.id, nome: e.nome }));
}

function renderCardOportunidade(o) {
  const etapaCfg = STATE.etapasVenda.find((e) => e.id === o.etapa);
  return `
    <div class="kcard-nome">${esc(o.clienteNome)}${o.nivelInteresse ? ` <span class="kcard-nivel" title="${esc(labelNivelInteresse(o.nivelInteresse))}">${o.nivelInteresse}</span>` : ""}</div>
    <div class="kcard-sub">${esc(o.telefone || "")}${o.data ? ` · ${fmtData(o.data)} ${esc(o.hora || "")}` : ""}</div>
    <div class="kcard-foot">
      <span class="kcard-valor">${fmtMoeda(o.valorProposto)}</span>
      ${renderBadgeSla(o.dataEntrouEtapa, etapaCfg)}
    </div>
    ${o.perdida && o.motivoPerda ? `<div class="sublabel" style="margin-top:6px;">Motivo: ${esc(o.motivoPerda)}</div>` : ""}
  `;
}

function renderKanbanVendas() {
  const cards = filtrarCardsFunil(STATE.oportunidades, "vendas", STATE.etapasVenda,
    (o) => [o.clienteNome, o.telefone, o.email, o.instagram, o.observacoes, o.motivoPerda].join(" "));
  renderKanban("kanban-vendas", "vendas", colunasVendas(), cards, (o) => o.etapa, renderCardOportunidade);
  renderListaFunil("vendas", cards, STATE.etapasVenda, (o) => o.etapa,
    (o) => `${fmtMoeda(o.valorProposto)} · ${telefoneCopiavel(o.telefone)}`);

  const ativas = cards.filter((o) => !o.perdida);
  const valorTotal = ativas.reduce((s, o) => s + (Number(o.valorProposto) || 0), 0);
  document.getElementById("vendas-kpis").innerHTML = kpisFunil(cards, STATE.etapasVenda, [
    { tag: "Oportunidades ativas", num: String(ativas.length), sub: "sem contar as perdidas" },
    { tag: "Valor em negociação", num: fmtMoeda(valorTotal), sub: "soma das ativas" }
  ]);
}
wireToggleFunil("vendas", renderKanbanVendas);

async function moverOportunidade(id, novaEtapa) {
  const op = STATE.oportunidades.find((o) => o.id === id);
  if (!op || op.etapa === novaEtapa) return;
  const etapaCfg = STATE.etapasVenda.find((e) => e.id === novaEtapa);

  if (etapaCfg && etapaCfg.perda) {
    pendingPerda = { colecao: "oportunidades", id };
    document.getElementById("mp-motivo").value = "";
    abrirModal("modal-perda");
    return;
  }

  if (etapaCfg && etapaCfg.fechamento) {
    pendingContratoOportunidadeId = id;
    pendingContratoEtapaFechamentoId = novaEtapa;
    comboContrato.selecionar({ id: op.clienteId || null, nome: op.clienteNome, telefone: op.telefone || "" });
    // Preenche primeiro pelo cadastro do cliente, depois sobrepõe com o
    // que já estava na oportunidade (mais recente/específico) — sem essa
    // ordem, o telefone/e-mail que vieram do agendamento seriam apagados
    // se o cadastro do cliente ainda estivesse em branco.
    preencherCamposFaltantesContrato(op.clienteId);
    document.getElementById("mct-telefone").value = op.telefone || document.getElementById("mct-telefone").value;
    document.getElementById("mct-email").value = op.email || document.getElementById("mct-email").value;
    document.getElementById("mct-valor").value = op.valorProposto ? String(op.valorProposto).replace(".", ",") : "";
    document.getElementById("mct-forma").value = "avista";
    document.getElementById("mct-tipo-contrato").value = "padrao";
    document.getElementById("mct-bloco-comissao").style.display = "none";
    document.getElementById("mct-data-contrato").value = hojeStr();
    document.getElementById("mct-primeiraparcela").value = hojeStr();
    document.getElementById("mct-linha-parcelamento").style.display = "none";
    atualizarPreviewParcelas();
    abrirModal("modal-contrato");
    return;
  }

  try {
    await updateDoc(doc(db, "oportunidades", id), { etapa: novaEtapa, dataEntrouEtapa: serverTimestamp(), updatedAt: serverTimestamp() });
    await addDoc(collection(db, "oportunidades", id, "historico"), { tipo: "mudanca_etapa", de: op.etapa, para: novaEtapa, timestamp: serverTimestamp() });
  } catch (err) { mostrarErro("Não foi possível mover: " + err.message); }
}

async function excluirOportunidade(id) {
  if (!(await confirmarAcao("Excluir esta oportunidade?"))) return;
  try { await excluirComHistorico("oportunidades", id); } catch (err) { mostrarErro(err.message); }
}

// Compartilhado entre Agendamento e Vendas — qualquer etapa marcada como
// "perda" (Perdido, em ambos os funis) passa por aqui antes de mover de
// verdade, pra registrar o motivo.
document.getElementById("btn-confirmar-perda").addEventListener("click", async () => {
  if (!pendingPerda) return;
  const { colecao, id } = pendingPerda;
  const motivo = document.getElementById("mp-motivo").value.trim();
  const etapaAtual = (colecao === "agendamentos" ? STATE.agendamentos : STATE.oportunidades).find((x) => x.id === id);
  const novaEtapa = colecao === "agendamentos"
    ? STATE.etapasAgendamento.find((e) => e.perda)
    : STATE.etapasVenda.find((e) => e.perda);
  if (!novaEtapa) { mostrarErro("Etapa de perda não encontrada."); return; }
  try {
    const patch = { etapa: novaEtapa.id, motivoPerda: motivo, dataEntrouEtapa: serverTimestamp(), updatedAt: serverTimestamp() };
    if (colecao === "oportunidades") patch.perdida = true;
    await updateDoc(doc(db, colecao, id), patch);
    await addDoc(collection(db, colecao, id, "historico"), {
      tipo: "mudanca_etapa", de: etapaAtual ? etapaAtual.etapa : null, para: novaEtapa.id, motivoPerda: motivo, timestamp: serverTimestamp()
    });
    fecharModal("modal-perda");
    pendingPerda = null;
  } catch (err) { mostrarErro(err.message); }
});

// Mesma lógica da versão de Agendamento (ver atualizarContatoAgendamento)
// — contato do cliente é só leitura aqui, edição sempre pela ficha dele.
function atualizarContatoOportunidade(cliente) {
  const el = document.getElementById("mo-contato-cliente");
  const btn = document.getElementById("mo-btn-editar-cliente");
  if (!cliente) { el.textContent = "Selecione um cliente."; btn.disabled = true; return; }
  btn.disabled = false;
  el.textContent = `Tel: ${cliente.telefone || "não cadastrado"} · E-mail: ${cliente.email || "não cadastrado"}`;
}
document.getElementById("btn-nova-oportunidade").addEventListener("click", () => {
  pendingOportunidadeEditId = null;
  document.getElementById("modal-oportunidade-titulo").textContent = "Nova oportunidade";
  comboOportunidade.reset();
  atualizarContatoOportunidade(null);
  document.getElementById("mo-valor").value = "";
  document.getElementById("mo-data").value = "";
  document.getElementById("mo-hora").value = "";
  document.getElementById("mo-obs").value = "";
  pickerNivelOportunidade.set(null);
  abrirModal("modal-oportunidade");
});
document.getElementById("mo-btn-editar-cliente").addEventListener("click", () => {
  const cliente = comboOportunidade.clienteSelecionado;
  if (!cliente || !cliente.id) { mostrarErro("Selecione (ou crie) um cliente antes de editar o contato."); return; }
  abrirClienteEmbutido((clienteAtualizado) => {
    if (!clienteAtualizado) return;
    comboOportunidade.selecionar(clienteAtualizado);
    atualizarContatoOportunidade(clienteAtualizado);
  }, { clienteId: cliente.id });
});
function editarOportunidade(id) {
  const o = STATE.oportunidades.find((x) => x.id === id);
  if (!o) return;
  pendingOportunidadeEditId = id;
  document.getElementById("modal-oportunidade-titulo").textContent = `Editar oportunidade — ${o.clienteNome}`;
  const clienteDaOp = STATE.clientes.find((c) => c.id === o.clienteId)
    || { id: o.clienteId || null, nome: o.clienteNome, telefone: o.telefone || "", email: o.email || "" };
  comboOportunidade.selecionar(clienteDaOp);
  atualizarContatoOportunidade(clienteDaOp);
  document.getElementById("mo-valor").value = o.valorProposto ? String(o.valorProposto).replace(".", ",") : "";
  document.getElementById("mo-data").value = o.data || "";
  document.getElementById("mo-hora").value = o.hora || "";
  document.getElementById("mo-obs").value = o.observacoes || "";
  pickerNivelOportunidade.set(o.nivelInteresse || null);
  abrirModal("modal-oportunidade");
}
document.getElementById("btn-salvar-oportunidade").addEventListener("click", async () => {
  const cliente = comboOportunidade.clienteSelecionado;
  if (!cliente) { mostrarErro("Selecione um cliente da lista, ou clique em \"+ Criar cliente\" pra cadastrar um novo."); return; }

  if (pendingOportunidadeEditId) {
    try {
      await updateDoc(doc(db, "oportunidades", pendingOportunidadeEditId), {
        clienteId: cliente.id, clienteNome: cliente.nome,
        telefone: cliente.telefone || "",
        email: cliente.email || "",
        nivelInteresse: pickerNivelOportunidade.valor,
        valorProposto: parseMoeda(document.getElementById("mo-valor").value),
        data: document.getElementById("mo-data").value || "",
        hora: document.getElementById("mo-hora").value || "",
        observacoes: document.getElementById("mo-obs").value.trim(),
        updatedAt: serverTimestamp()
      });
      fecharModal("modal-oportunidade");
      pendingOportunidadeEditId = null;
      mostrarToast("Oportunidade atualizada.");
    } catch (err) { mostrarErro(err.message); }
    return;
  }

  const primeiraEtapa = [...STATE.etapasVenda].sort((a, b) => a.ordem - b.ordem)[0];
  if (!primeiraEtapa) { mostrarErro("Cadastre ao menos uma etapa do Funil de Vendas em Configurações."); return; }
  try {
    await addDoc(collection(db, "oportunidades"), {
      clienteId: cliente.id, clienteNome: cliente.nome,
      telefone: cliente.telefone || "",
      email: cliente.email || "",
      nivelInteresse: pickerNivelOportunidade.valor,
      agendamentoId: null, etapa: primeiraEtapa.id,
      valorProposto: parseMoeda(document.getElementById("mo-valor").value),
      data: document.getElementById("mo-data").value || "",
      hora: document.getElementById("mo-hora").value || "",
      observacoes: document.getElementById("mo-obs").value.trim(),
      perdida: false, motivoPerda: "", fechada: false,
      dataEntrouEtapa: serverTimestamp(), createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    });
    fecharModal("modal-oportunidade");
    mostrarToast("Oportunidade criada.");
  } catch (err) { mostrarErro(err.message); }
});

function abrirDetalheOportunidade(id) {
  const o = STATE.oportunidades.find((x) => x.id === id);
  if (!o) return;
  const etapaCfg = STATE.etapasVenda.find((e) => e.id === o.etapa);
  abrirDetalhe({
    titulo: o.clienteNome,
    campos: [
      ["Telefone", esc(o.telefone || "—")],
      ["E-mail", esc(o.email || "—")],
      ["Instagram da empresa", esc(o.instagram || "—")],
      ["Estabelecimento", esc(LABEL_ESTABELECIMENTO[o.estabelecimento] || "—")],
      ["Time comercial", esc(LABEL_TIME_COMERCIAL[o.timeComercial] || "—")],
      ["Faturamento (últimos 6 meses)", esc(LABEL_FATURAMENTO[o.faturamento6meses] || "—")],
      ["Onde a empresa trava", (o.ondeTrava && o.ondeTrava.length) ? esc(o.ondeTrava.join("; ")) : "—"],
      ["Comprometimento (0 a 10)", o.comprometimento != null ? `${o.comprometimento}/10` : "—"],
      ["Nível de interesse", esc(labelNivelInteresse(o.nivelInteresse))],
      ["Data do agendamento", esc(fmtData(o.data))],
      ["Hora do agendamento", esc(o.hora || "—")],
      ["Valor proposto", esc(fmtMoeda(o.valorProposto))],
      ["Etapa", esc(etapaCfg ? etapaCfg.nome : "—")],
      ["Observações", esc(o.observacoes || "—")],
      ["Fechada?", o.fechada ? "Sim" : "Não"],
      ...(o.motivoPerda ? [["Motivo da perda", esc(o.motivoPerda)]] : [])
    ],
    onEditar: () => editarOportunidade(id),
    onExcluir: () => excluirOportunidade(id),
    cliente: o.clienteId ? { nome: o.clienteNome, onClick: () => abrirDetalheCliente(o.clienteId, () => abrirDetalheOportunidade(id)) } : null
  });
}

/* ══════════════ GERADOR DE CONTRATO ══════════════ */

function apenasDigitos(s) {
  return String(s || "").replace(/\D/g, "");
}

// Número por extenso em português — usado nos textos do contrato em PDF,
// que seguem o padrão jurídico de escrever valores entre parênteses (ex:
// "R$ 4.000,00 (quatro mil reais)"). Cobre de 0 a 999.999.999, o
// suficiente pra qualquer valor de contrato realista.
const EXTENSO_UNIDADES = ["", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove"];
const EXTENSO_DEZ_A_DEZENOVE = ["dez", "onze", "doze", "treze", "catorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove"];
const EXTENSO_DEZENAS = ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"];
const EXTENSO_CENTENAS = ["", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos"];
const MESES_NOME_EXTENSO = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

function extensoAte999(n) {
  if (n === 0) return "";
  if (n === 100) return "cem";
  const partes = [];
  const centena = Math.floor(n / 100);
  const resto = n % 100;
  if (centena) partes.push(EXTENSO_CENTENAS[centena]);
  if (resto) {
    if (resto < 10) partes.push(EXTENSO_UNIDADES[resto]);
    else if (resto < 20) partes.push(EXTENSO_DEZ_A_DEZENOVE[resto - 10]);
    else {
      const dezena = Math.floor(resto / 10), unidade = resto % 10;
      partes.push(EXTENSO_DEZENAS[dezena] + (unidade ? " e " + EXTENSO_UNIDADES[unidade] : ""));
    }
  }
  return partes.join(" e ");
}
function numeroInteiroExtenso(n) {
  if (n === 0) return "zero";
  const milhoes = Math.floor(n / 1000000);
  const milhares = Math.floor((n % 1000000) / 1000);
  const centenas = n % 1000;
  const partes = [];
  if (milhoes) partes.push(extensoAte999(milhoes) + (milhoes === 1 ? " milhão" : " milhões"));
  if (milhares) partes.push(milhares === 1 ? "mil" : extensoAte999(milhares) + " mil");
  if (centenas) partes.push(extensoAte999(centenas));
  return partes.join(" e ");
}
function valorExtenso(valor) {
  const inteiro = Math.floor(Math.abs(valor) + 1e-9);
  const centavos = Math.round((Math.abs(valor) - inteiro) * 100);
  // "um milhão DE reais" — o "de" só entra quando "milhão/milhões" fica
  // colado direto na moeda (nenhum "mil"/centena no meio, ex: 1.200.000
  // não leva "de": "um milhão e duzentos mil reais").
  const precisaDe = inteiro >= 1000000 && inteiro % 1000000 === 0;
  let texto = `${numeroInteiroExtenso(inteiro)}${precisaDe ? " de " : " "}${inteiro === 1 ? "real" : "reais"}`;
  if (centavos > 0) texto += ` e ${numeroInteiroExtenso(centavos)} ${centavos === 1 ? "centavo" : "centavos"}`;
  return texto;
}
function dataExtenso(dataStr) {
  const [y, m, d] = (dataStr || hojeStr()).split("-").map(Number);
  return `${d} de ${MESES_NOME_EXTENSO[m - 1]} de ${y}`;
}

// Monta o parágrafo de qualificação do CONTRATANTE (cliente) pro contrato
// — varia conforme o CPF/CNPJ tem 11 ou mais de 11 dígitos (mesmo
// critério de aplicarMascaraCpfCnpj). Pessoa jurídica inclui o
// representante legal (se cadastrado); pessoa física é qualificada
// diretamente, sem representante. Já devolve HTML escapado — é inserido
// direto no corpo do PDF (ver montarHtmlContrato), não é mais texto puro
// de um Google Docs.
function construirQualificacaoContratante(cliente) {
  const digitos = apenasDigitos(cliente.cpfCnpj);
  const endereco = esc(cliente.endereco || "endereço não informado");
  if (digitos.length > 11) {
    let texto = `pessoa jurídica de direito privado, inscrita no CNPJ sob o nº ${esc(cliente.cpfCnpj || "—")}, com sede em ${endereco}`;
    if (cliente.representanteNome) {
      texto += `, neste ato representada por ${esc(cliente.representanteNome)}`;
      if (cliente.representanteCpf) texto += `, portador(a) do CPF nº ${esc(cliente.representanteCpf)}`;
    }
    return texto;
  }
  return `pessoa física, portador(a) do CPF nº ${esc(cliente.cpfCnpj || "—")}, residente e domiciliado(a) em ${endereco}`;
}

// A mentoria é sempre um programa de 6 meses, independente da forma de
// pagamento (à vista, entrada+parcelas ou personalizada) — não varia com
// o número ou as datas das parcelas.
const PRAZO_CONTRATO_TEXTO = "6 (seis) meses";

// Lista (HTML) de cada parcela do contrato — funciona pras 3 formas de
// pagamento: à vista (1 item), entrada + parcelas (rotula a numero=0 como
// "Entrada") e personalizada (cada item já vem com o valor/vencimento
// digitado à mão).
function construirTabelaParcelasHtml(parcelas, forma) {
  return `<ul>${(parcelas || []).map((p) => {
    const rotulo = forma === "avista" ? "Pagamento único" : p.numero === 0 ? "Entrada" : `Parcela ${p.numero}`;
    return `<li>${esc(rotulo)}: ${esc(fmtMoeda(p.valor))} (${esc(valorExtenso(p.valor))}), com vencimento em ${esc(fmtData(p.vencimento))}.</li>`;
  }).join("")}</ul>`;
}

// Monta o contrato inteiro já em HTML, com CSS embutido — pronto pra virar
// PDF direto no Code.gs (Utilities.newBlob(html,...).getAs(
// "application/pdf")), sem passar por nenhum Google Docs modelo. Mesmo
// padrão usado no SolarGreen-ERP (composeMonitoramento/composeManutencao
// + actionEnviarContratoParaAssinatura): o layout inteiro vem só deste
// HTML, sob controle total daqui — elimina de vez a "capa"/formatação
// escondida que um Google Docs editado à mão podia carregar, porque não
// existe mais Google Docs nenhum no meio do caminho.
// "Padrão" (Assessoria Empresarial) é o único tipo até 2026-08-31 — o
// contrato assinado da SOLAR ROOF LTDA (fora do sistema, comparado a
// pedido do Felipe) usou uma consultoria com comissão variável sobre
// faturamento, típica de energia solar. "consultoria_comissao" replica
// esse formato, mas com a numeração de cláusulas corrigida (o PDF de
// referência pulava 3.7 e 7.2/7.3 — sinal de edição manual sem
// renumerar; aqui fica sequencial) e os parâmetros (%, piso, kWp)
// configuráveis no formulário em vez de fixos no texto.
function montarHtmlContrato(cliente, contrato, parcelas) {
  const ehComissao = contrato.tipoContrato === "consultoria_comissao";
  const dataContrato = contrato.dataContrato || hojeStr();
  const nomeCliente = esc(cliente.nome);
  const valorTotalTexto = esc(fmtMoeda(contrato.valorTotal));
  const valorTotalExtenso = esc(valorExtenso(contrato.valorTotal));
  const formaPagamentoTexto = esc(descricaoFormaPagamento(contrato.formaPagamento, contrato.valorEntrada, contrato.numParcelas));
  const qualificacao = construirQualificacaoContratante(cliente);
  const tabelaParcelas = construirTabelaParcelasHtml(parcelas, contrato.formaPagamento);
  const dataExtensoTexto = esc(dataExtenso(dataContrato));
  const digitos = apenasDigitos(cliente.cpfCnpj);
  const linhaRepresentante = digitos.length > 11 && cliente.representanteNome
    ? `<br>Nome: ${esc(cliente.representanteNome)}`
    : "";
  const contatoCliente = [cliente.telefone && `telefone ${esc(cliente.telefone)}`, cliente.email && `e-mail ${esc(cliente.email)}`].filter(Boolean).join(", ");
  const linhaContatoCliente = ehComissao && contatoCliente ? `, ${contatoCliente}` : "";
  const linhaContatoContratado = ehComissao ? ", e-mail expansao.viegas@gmail.com, telefone (91) 98145-9254" : "";

  const tituloContrato = ehComissao ? "Contrato de Prestação de Serviços de Consultoria" : "Contrato de Prestação de Serviços de Assessoria Empresarial";
  const subtituloPrograma = ehComissao ? `<p style="text-align:center;margin-top:-14px;margin-bottom:18px;">Programa: Jornada do Milhão</p>` : "";
  const introContrato = ehComissao
    ? "Prestação de Serviços Educacionais e de Consultoria"
    : "Prestação de Serviços de Assessoria Empresarial para Potencialização Comercial";

  const objetoDoContrato = ehComissao ? `
<p>1.1 O presente contrato tem por objeto a prestação de serviços educacionais e de consultoria referentes ao programa "Jornada do Milhão", voltado a empresários do setor de energia solar fotovoltaica, com o objetivo de estruturar, escalar e profissionalizar as operações comerciais do CONTRATANTE.</p>
<p>1.2 Os serviços contemplam os seguintes módulos e entregáveis, sendo a execução de inteira responsabilidade do CONTRATANTE:</p>
<h2>Módulo 1 — Fundamentos e Diagnóstico</h2>
<ul>
<li>Sessão de kickoff individual (até 2h) para diagnóstico completo do negócio;</li>
<li>Análise e definição, junto à gestão comercial, do perfil de cliente ideal e dos critérios de qualificação de leads;</li>
<li>Avaliação do modelo comercial vigente e mapeamento de gargalos;</li>
<li>Definição de remuneração, precificação e posicionamento de mercado;</li>
<li>Plano de ação prático personalizado para execução imediata.</li>
</ul>
<h2>Módulo 2 — Estruturação Comercial</h2>
<ul>
<li>Criação e validação de scripts de vendas (diagnóstico, proposta e fechamento);</li>
<li>Estruturação do funil comercial com cadência de prospecção e follow-up.</li>
</ul>
<h2>Módulo 3 — Gestão e Liderança do Time Comercial</h2>
<ul>
<li>Mentoria ao gestor/diretor comercial em práticas de liderança e gestão de resultados;</li>
<li>Construção do planejamento comercial anual com metas e indicadores.</li>
</ul>
<h2>Módulo 4 — Gestão Financeira da Precificação</h2>
<ul>
<li>Análise de compra de equipamentos e formação de preço de kits solares;</li>
<li>Precificação de projetos residenciais.</li>
</ul>
<p>1.3 Os serviços serão prestados de maneira autônoma e independente, sem vínculo empregatício entre as partes, sendo o CONTRATANTE responsável pela execução e implementação das estratégias, bem como pelo cumprimento dos prazos e das metas estabelecidas.</p>
` : `
<p>1.1 O presente contrato tem por objeto a prestação de serviços de assessoria empresarial, com foco comercial e restruturação, no apoio direto ao diretor comercial da empresa para aprimorar estratégias comerciais e alcançar os objetivos estratégicos estabelecidos.</p>
<p>1.2 As atividades a serem desenvolvidas pelo CONTRATADO incluem:</p>
<h2>1.2.1. Análise e Otimização Comercial</h2>
<ul>
<li>Avaliação dos canais de venda e das estratégias comerciais utilizadas;</li>
<li>Diagnóstico da performance da equipe comercial e validação de indicadores de desempenho;</li>
<li>Criação e implementação de dispositivos de análise e verificação de performance;</li>
<li>Implantação de novos canais de aquisição de clientes.</li>
</ul>
<h2>1.2.2. Mentoria e Aconselhamento Estratégico</h2>
<ul>
<li>Mentoria ao diretor/gerente comercial e à equipe em práticas comerciais eficazes;</li>
<li>Construção do planejamento com acompanhamento de indicadores;</li>
<li>Análise de compra de equipamentos, precificação de kits e remuneração de time comercial;</li>
<li>Desenvolvimento de ações estratégicas para aumento de vendas e melhoria de resultados.</li>
</ul>
<p>1.3 Os serviços serão prestados de maneira autônoma e independente, sem vínculo empregatício entre as partes, sendo o CONTRATANTE responsável pela execução e implementação das estratégias, bem como pelo cumprimento dos prazos e das metas estabelecidas.</p>
`;

  // Cláusulas de remuneração variável — só existem no tipo "comissão".
  // Numeradas em sequência depois das 4 já existentes (3.1 a 3.4), pra
  // nunca deixar buraco de numeração como o contrato de referência tinha.
  const comissaoPctTexto = esc(String(contrato.comissaoPct ?? 4).replace(".", ","));
  const comissaoPisoTexto = esc(fmtMoeda(contrato.comissaoPiso ?? 400000));
  const comissaoKwpTexto = esc(String(contrato.comissaoKwp ?? 60).replace(".", ","));
  const clausulaComissaoExtra = ehComissao ? `
<p>3.5 Será devida, ainda, remuneração variável correspondente a ${comissaoPctTexto}% (${esc(numeroInteiroExtenso(Math.round(contrato.comissaoPct ?? 4)))} por cento) incidente sobre o faturamento novo da CONTRATANTE que exceder o montante de ${comissaoPisoTexto} (${esc(valorExtenso(contrato.comissaoPiso ?? 400000))}) por mês, calculada exclusivamente sobre a parcela do faturamento mensal que ultrapassar esse limite.</p>
<p>3.6 Para os fins desta cláusula, entende-se por "faturamento novo" o faturamento decorrente de vendas e projetos originados, direta ou indiretamente, das estratégias, processos e ações comerciais implementadas no âmbito da consultoria objeto deste contrato.</p>
<p>3.7 Ficam excluídos da base de cálculo da remuneração variável: a) os projetos com potência instalada superior a ${comissaoKwpTexto} kWp (${esc(numeroInteiroExtenso(Math.round(contrato.comissaoKwp ?? 60)))} quilowatts-pico); e b) os projetos fechados/vendidos diretamente pelo próprio CONTRATANTE, na qualidade de CEO/sócio-administrador da empresa, sem participação da equipe comercial estruturada no âmbito da consultoria.</p>
<p>3.8 Somente integrarão a base de cálculo da remuneração variável as vendas efetivamente concretizadas e cujos respectivos valores já tenham sido efetivamente recebidos pela CONTRATANTE dentro do mês de apuração.</p>
<p>3.9 O pagamento da remuneração fixa mensal (item 3.1) será realizado todo dia 20 (vinte) de cada mês. O pagamento da remuneração variável (item 3.5) será realizado todo dia 10 (dez) do mês subsequente ao mês de apuração/referência, mediante prévio fechamento e conferência dos valores apurados entre as partes.</p>
<p>3.10 Uma vez apurada e paga, a remuneração variável não estará sujeita a qualquer tipo de estorno, dedução, glosa ou compensação em razão de erro operacional, atraso operacional, falha de sistema ou de processo interno, sendo de responsabilidade exclusiva da CONTRATANTE conferir e validar os valores apurados previamente ao respectivo pagamento.</p>
<p>3.11 O atraso no pagamento de quaisquer dos valores previstos nesta cláusula sujeitará a CONTRATANTE à incidência de multa de 2% (dois por cento) sobre o valor em atraso, juros de mora de 1% (um por cento) ao mês, calculados pro rata die, e atualização monetária pelo IPCA (ou índice que vier a substituí-lo), sem prejuízo da exigibilidade integral da obrigação principal.</p>
` : "";

  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Contrato - ${nomeCliente}</title>
<style>
body{font-family:"Times New Roman",Times,serif;font-size:12.5px;line-height:1.6;color:#111;max-width:760px;margin:0 auto;padding:24px 8px 48px;}
h1{font-size:15px;text-align:center;font-weight:700;margin-bottom:22px;text-transform:uppercase;}
h2{font-size:12.5px;font-weight:700;margin-top:16px;margin-bottom:6px;}
p{margin:0 0 8px;text-align:justify;}
ul{margin:0 0 8px;padding-left:22px;}
li{margin-bottom:3px;text-align:justify;}
.assinaturas{margin-top:56px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:32px;}
.assinatura{width:280px;}
.assinatura-linha{border-top:1px solid #333;margin-top:48px;padding-top:6px;font-size:11px;text-align:center;}
@media print{@page{margin:1.5cm 2cm 2cm;}}
</style></head><body>
<h1>${tituloContrato}</h1>
${subtituloPrograma}

<p><strong>CONTRATANTE:</strong></p>
<p>${nomeCliente}, ${qualificacao}${linhaContatoCliente}.</p>

<p><strong>CONTRATADO:</strong></p>
<p>BENEDITO JOÃO VIEGAS DE MATOS, pessoa física, brasileiro, casado, CPF nº 925.437.152/15, escritório comercial localizado na Rua Municipalidade, Edifício Mirai Offices, sala 216, bairro Umarizal, Belém/PA${linhaContatoContratado}.</p>

<p>As partes acima qualificadas têm entre si justo e contratado o presente instrumento de ${introContrato}, que se regerá pelas cláusulas e condições a seguir:</p>

<h2>1. OBJETO</h2>
${objetoDoContrato}

<h2>2. PRAZO DE VIGÊNCIA</h2>
<p>2.1 O presente contrato terá vigência de ${PRAZO_CONTRATO_TEXTO}, contados a partir da data de sua assinatura.</p>
<p>2.2 O contrato poderá ser prorrogado por igual período, mediante acordo entre as partes, formalizado por aditivo contratual.</p>

<h2>3. REMUNERAÇÃO E CONDIÇÕES DE PAGAMENTO</h2>
<p>3.1 Pela prestação dos serviços, a CONTRATANTE pagará ao CONTRATADO o valor total de ${valorTotalTexto} (${valorTotalExtenso}), na forma de ${formaPagamentoTexto}, conforme o detalhamento abaixo:</p>
${tabelaParcelas}
<p>3.2 O CONTRATADO emitirá a nota fiscal correspondente a cada parcela preferencialmente até o dia 15 de cada mês, e o pagamento pela CONTRATANTE deverá ser realizado nas datas de vencimento indicadas acima, via depósito bancário na conta indicada pelo CONTRATADO.</p>
<p>3.3 A prestação do serviço será de forma remota, através de reuniões semanais de preferência com horários fixos estabelecidos entre as partes, tanto para financeiro quanto comercial, e uma reunião de resultado mensal.</p>
<p>3.4 As despesas de deslocamento, hospedagem e alimentação eventualmente necessárias para a prestação dos serviços deverão ser previamente autorizadas pela CONTRATANTE e serão reembolsadas mediante apresentação de comprovantes.</p>
${clausulaComissaoExtra}

<h2>4. OBRIGAÇÕES DAS PARTES</h2>
<h2>4.1. Obrigações do CONTRATADO</h2>
<p>4.1.1 Prestar os serviços contratados com alto grau de excelência técnica, adotando as melhores práticas de mercado em consultoria comercial, observando as diretrizes estratégicas estabelecidas pela CONTRATANTE e mantendo compromisso com a maximização de resultados.</p>
<p>4.1.2 Atuar de forma proativa na identificação de oportunidades de melhoria e inovação nos processos comerciais da CONTRATANTE, sugerindo ações estratégicas baseadas em análise de dados e tendências de mercado.</p>
<p>4.1.3 Manter total confidencialidade sobre quaisquer informações estratégicas, operacionais e comerciais da CONTRATANTE, protegendo o sigilo dos dados a que tiver acesso, inclusive após o término do contrato, salvo mediante autorização expressa.</p>
<p>4.1.4 Apresentar, conforme o requerido, relatórios analíticos e gerenciais periódicos sobre as atividades desenvolvidas, contemplando métricas de desempenho, impactos estratégicos e recomendações para aprimoramento contínuo das operações comerciais da CONTRATANTE.</p>
<p>4.1.5 Disponibilizar suporte consultivo ao diretor comercial e demais profissionais envolvidos, sempre que necessário, garantindo alinhamento contínuo entre as diretrizes estratégicas e a execução prática.</p>
<p>4.1.6 Garantir que os serviços sejam prestados com independência técnica, sem qualquer subordinação hierárquica à CONTRATANTE, resguardando o caráter consultivo e estratégico da prestação de serviços.</p>
<p>4.1.7 Assegurar conformidade com todas as normas regulatórias aplicáveis e com os princípios éticos e de governança corporativa vigentes no mercado, garantindo que suas ações estejam alinhadas às boas práticas empresariais.</p>
<h2>4.2. Obrigações da CONTRATANTE</h2>
<p>4.2.1 Disponibilizar todas as informações, documentos e acessos necessários para que o CONTRATADO possa desenvolver suas atividades de forma eficaz e estratégica, garantindo fluidez na execução dos serviços.</p>
<p>4.2.2 Efetuar os pagamentos devidos nos prazos estabelecidos, conforme as condições acordadas, assegurando a previsibilidade e estabilidade financeira da relação contratual.</p>
<p>4.2.3 Garantir um ambiente colaborativo, permitindo que o CONTRATADO tenha a autonomia necessária para sugerir e implementar melhorias estratégicas no âmbito da consultoria prestada.</p>
<p>4.2.4 Envolver os gestores e profissionais-chave da área comercial nas ações estratégicas e recomendações apresentadas pelo CONTRATADO, assegurando que a consultoria tenha impacto efetivo na performance comercial da empresa.</p>
<p>4.2.5 Manter diálogo contínuo com o CONTRATADO, fornecendo feedbacks e sinalizações estratégicas que possam contribuir para o aperfeiçoamento dos serviços prestados.</p>
<p>4.2.6 Adotar as medidas cabíveis para a implementação das recomendações apresentadas pelo CONTRATADO, desde que compatíveis com os objetivos estratégicos da empresa, garantindo coerência e alinhamento entre a consultoria e a prática empresarial.</p>

<h2>5. CONFIDENCIALIDADE</h2>
<p>5.1 O CONTRATADO reconhece que, no curso da prestação dos serviços objeto deste contrato, poderá ter acesso a informações estratégicas, comerciais, operacionais, financeiras, técnicas e de qualquer outra natureza relacionadas à CONTRATANTE, suas atividades, clientes, fornecedores, parceiros e demais partes interessadas, sejam elas verbais, escritas, eletrônicas ou de qualquer outro meio tangível ou intangível ("Informações Confidenciais").</p>
<p>5.2 O CONTRATADO se compromete a manter absoluto sigilo e confidencialidade sobre todas as Informações Confidenciais obtidas em razão deste contrato, comprometendo-se a:</p>
<ul>
<li>a) Não divulgar, reproduzir, compartilhar ou permitir o acesso de terceiros às Informações Confidenciais, salvo mediante autorização prévia e expressa da CONTRATANTE;</li>
<li>b) Não utilizar as Informações Confidenciais para qualquer fim que não seja estritamente necessário para a execução dos serviços previstos neste contrato;</li>
<li>c) Adotar todas as medidas razoáveis e necessárias para resguardar a integridade e a segurança das Informações Confidenciais, incluindo medidas técnicas, administrativas e jurídicas compatíveis com as melhores práticas de mercado;</li>
<li>d) Garantir que seus funcionários, colaboradores, sócios, consultores, subcontratados ou quaisquer terceiros que, porventura, tenham acesso às Informações Confidenciais, assumam o mesmo compromisso de sigilo e confidencialidade, sendo o CONTRATADO integralmente responsável por eventuais violações cometidas por esses agentes.</li>
</ul>
<p>5.3 As obrigações de confidencialidade previstas nesta cláusula não se aplicarão às informações que:</p>
<ul>
<li>a) Já eram de conhecimento público no momento da divulgação ou se tornarem publicamente disponíveis sem violação deste contrato;</li>
<li>b) Forem comprovadamente desenvolvidas de forma independente pelo CONTRATADO, sem acesso às Informações Confidenciais da CONTRATANTE;</li>
<li>c) Forem legalmente exigidas por determinação judicial, administrativa ou regulatória, hipótese em que o CONTRATADO deverá notificar a CONTRATANTE previamente e cooperar para minimizar a divulgação das informações na extensão permitida pela legislação aplicável.</li>
</ul>
<p>5.4 O dever de confidencialidade permanecerá vigente durante toda a vigência do contrato e pelo prazo de 5 (cinco) anos após sua rescisão ou término, independentemente do motivo.</p>
<p>5.5 Em caso de violação da presente cláusula, a CONTRATANTE poderá adotar todas as medidas legais cabíveis, incluindo, mas não se limitando, à rescisão imediata do contrato e à indenização por perdas e danos diretos e indiretos sofridos.</p>

<h2>6. RESCISÃO</h2>
<p>6.1 O presente contrato poderá ser rescindido por qualquer das partes, a qualquer tempo, mediante notificação prévia, por escrito, com antecedência mínima de 30 (trinta) dias, sem incidência de penalidades, salvo na hipótese de descumprimento de qualquer obrigação contratual.</p>
<p>6.2 O contrato será rescindido de pleno direito, independentemente de qualquer notificação ou interpelação judicial ou extrajudicial, nas seguintes hipóteses:</p>
<ul>
<li>a) Inadimplemento de qualquer obrigação assumida neste contrato por uma das partes, caso a parte adimplente notifique a parte inadimplente, concedendo prazo razoável para a devida regularização, e esta não cumpra a obrigação no prazo estabelecido;</li>
<li>b) Decretação de falência, recuperação judicial ou extrajudicial de qualquer das partes, que comprometa a capacidade de cumprimento do presente contrato;</li>
<li>c) Ocorrência de caso fortuito ou força maior que inviabilize, de forma definitiva, a continuidade da prestação dos serviços e o cumprimento das obrigações contratuais;</li>
<li>d) Qualquer violação de normas legais ou regulatórias aplicáveis que impactem diretamente a execução deste contrato e inviabilizem sua continuidade.</li>
</ul>
<p>6.3 Na hipótese de rescisão antecipada imotivada por qualquer das partes, as obrigações pendentes de execução até a data efetiva da rescisão deverão ser cumpridas integralmente, salvo disposição expressa em contrário entre as partes.</p>

<h2>7. DISPOSIÇÕES GERAIS</h2>
<p>7.1 O CONTRATADO poderá utilizar profissionais terceirizados para a execução dos serviços, desde que previamente autorizados pela CONTRATANTE, permanecendo integralmente responsável pela qualidade, sigilo e cumprimento das obrigações assumidas neste contrato.</p>
<p>7.2 Para dirimir quaisquer questões oriundas deste contrato que não possam ser resolvidas de forma consensual, fica eleito o Foro da Comarca de Belém/PA, com renúncia expressa a qualquer outro, por mais privilegiado que seja.</p>
<p>7.3 O presente contrato poderá ser formalizado e assinado eletronicamente, utilizando-se plataforma reconhecida no mercado que assegure a autenticidade, integridade e validade jurídica do documento, nos termos da legislação aplicável, incluindo, mas não se limitando, à Medida Provisória nº 2.200-2/2001 e ao Código Civil. As assinaturas eletrônicas das partes terão o mesmo valor legal das assinaturas manuscritas.</p>
<p>7.4 E, por estarem justas e contratadas, as partes firmam o presente contrato, que passa a vigorar a partir da data de sua assinatura.</p>

<p>Belém, ${dataExtensoTexto}</p>

<div class="assinaturas">
<div class="assinatura"><div class="assinatura-linha">CONTRATANTE<br>${nomeCliente}${linhaRepresentante}</div></div>
<div class="assinatura"><div class="assinatura-linha">CONTRATADO<br>BENEDITO JOÃO VIEGAS DE MATOS<br>CPF: 925.437.152-15</div></div>
</div>
</body></html>`;
}

function calcularParcelas(valorTotal, forma, valorEntrada, numParcelas, diaVencimento, dataPrimeira, parcelasPersonalizadas) {
  if (forma === "avista") {
    return [{ numero: 1, valor: valorTotal, vencimento: dataPrimeira }];
  }
  if (forma === "personalizada") {
    return (parcelasPersonalizadas || []).map((p, i) => ({ numero: i + 1, valor: p.valor, vencimento: p.vencimento }));
  }
  const parcelas = [{ numero: 0, valor: valorEntrada, vencimento: dataPrimeira }];
  const restante = Math.max(valorTotal - valorEntrada, 0);
  const valorParcela = Math.round((restante / numParcelas) * 100) / 100;
  let dataBase = new Date(dataPrimeira + "T12:00:00");
  let somaParcelas = 0;
  for (let i = 1; i <= numParcelas; i++) {
    dataBase.setMonth(dataBase.getMonth() + 1);
    const y = dataBase.getFullYear();
    const m = String(dataBase.getMonth() + 1).padStart(2, "0");
    const dia = String(Math.min(diaVencimento, diasNoMes(y, dataBase.getMonth() + 1))).padStart(2, "0");
    const valor = (i === numParcelas) ? Math.round((restante - somaParcelas) * 100) / 100 : valorParcela;
    somaParcelas += valorParcela;
    parcelas.push({ numero: i, valor, vencimento: `${y}-${m}-${dia}` });
  }
  return parcelas;
}

// "Parcelas personalizadas" — cada linha tem valor e vencimento digitados
// à mão (em vez de calculado por divisão igual), pra casos como "1º mês
// 4.000, 2º mês 4.000, 3º mês 5.000...". O DOM é a única fonte de verdade
// (não existe um array espelho) — cada linha carrega seus próprios inputs.
let parcelaPersonalizadaSeq = 0;
function linhaParcelaPersonalizadaHtml(idx, valor, vencimento) {
  return `
    <div class="row parcela-personalizada-linha" data-idx="${idx}" style="align-items:flex-end;gap:8px;margin-bottom:6px;">
      <div class="field" style="flex:1;"><label>Valor</label><input type="text" inputmode="decimal" class="mpp-valor" placeholder="0,00" value="${valor || ""}"></div>
      <div class="field" style="flex:1;"><label>Vencimento</label><input type="date" class="mpp-vencimento" value="${vencimento || ""}"></div>
      <button type="button" class="btn btn-remover-parcela-personalizada" data-idx="${idx}" style="height:38px;">×</button>
    </div>`;
}
function adicionarParcelaPersonalizada(valor, vencimento) {
  const idx = parcelaPersonalizadaSeq++;
  document.getElementById("mct-parcelas-personalizadas-lista").insertAdjacentHTML("beforeend", linhaParcelaPersonalizadaHtml(idx, valor, vencimento));
  atualizarPreviewParcelas();
}
// Ponto de partida sugerido ao escolher "personalizada" pela 1ª vez —
// Benedito pediu esse padrão específico (2 parcelas de 4.000, 2 de 5.000,
// 2 de 6.000); a pessoa edita valor/vencimento de qualquer linha depois.
const VALORES_PADRAO_PARCELAS_PERSONALIZADAS = [4000, 4000, 5000, 5000, 6000, 6000];
function preencherPadraoParcelasPersonalizadas() {
  VALORES_PADRAO_PARCELAS_PERSONALIZADAS.forEach((valor) => {
    adicionarParcelaPersonalizada(String(valor.toFixed(2)).replace(".", ","), proximaDataSugeridaParcelaPersonalizada());
  });
}
function limparParcelasPersonalizadas() {
  document.getElementById("mct-parcelas-personalizadas-lista").innerHTML = "";
  parcelaPersonalizadaSeq = 0;
}
function proximaDataSugeridaParcelaPersonalizada() {
  const linhas = [...document.querySelectorAll("#mct-parcelas-personalizadas-lista .parcela-personalizada-linha")];
  const diaVenc = parseInt(document.getElementById("mct-diavencimento").value, 10) || 10;
  if (!linhas.length) return document.getElementById("mct-primeiraparcela").value || hojeStr();
  const ultimaData = linhas[linhas.length - 1].querySelector(".mpp-vencimento").value || hojeStr();
  const base = new Date(ultimaData + "T12:00:00");
  base.setMonth(base.getMonth() + 1);
  const y = base.getFullYear(), m = String(base.getMonth() + 1).padStart(2, "0");
  const dia = String(Math.min(diaVenc, diasNoMes(y, base.getMonth() + 1))).padStart(2, "0");
  return `${y}-${m}-${dia}`;
}
document.getElementById("btn-add-parcela-personalizada").addEventListener("click", () => {
  adicionarParcelaPersonalizada("", proximaDataSugeridaParcelaPersonalizada());
});
document.getElementById("mct-parcelas-personalizadas-lista").addEventListener("click", (e) => {
  const btn = e.target.closest(".btn-remover-parcela-personalizada");
  if (!btn) return;
  btn.closest(".parcela-personalizada-linha").remove();
  atualizarPreviewParcelas();
});
document.getElementById("mct-parcelas-personalizadas-lista").addEventListener("input", atualizarPreviewParcelas);

function lerParcelasPersonalizadasForm() {
  return [...document.querySelectorAll("#mct-parcelas-personalizadas-lista .parcela-personalizada-linha")].map((linha) => ({
    valor: parseMoeda(linha.querySelector(".mpp-valor").value),
    vencimento: linha.querySelector(".mpp-vencimento").value
  }));
}

function descricaoFormaPagamento(forma, valorEntrada, numParcelas) {
  if (forma === "avista") return "À vista";
  if (forma === "personalizada") return `${numParcelas}x personalizadas`;
  return `Entrada de ${fmtMoeda(valorEntrada)} + ${numParcelas}x`;
}

function lerFormularioContrato() {
  const forma = document.getElementById("mct-forma").value;
  const parcelasPersonalizadas = forma === "personalizada" ? lerParcelasPersonalizadasForm() : [];
  return {
    valorTotal: forma === "personalizada"
      ? parcelasPersonalizadas.reduce((s, p) => s + p.valor, 0)
      : parseMoeda(document.getElementById("mct-valor").value),
    forma,
    valorEntrada: parseMoeda(document.getElementById("mct-entrada").value),
    numParcelas: forma === "personalizada" ? parcelasPersonalizadas.length : (parseInt(document.getElementById("mct-numparcelas").value, 10) || 1),
    diaVencimento: parseInt(document.getElementById("mct-diavencimento").value, 10) || 10,
    dataPrimeira: document.getElementById("mct-primeiraparcela").value || hojeStr(),
    parcelasPersonalizadas,
    tipoContrato: document.getElementById("mct-tipo-contrato").value,
    comissaoPct: parseMoeda(document.getElementById("mct-comissao-pct").value) || 4,
    comissaoPiso: parseMoeda(document.getElementById("mct-comissao-piso").value) || 400000,
    comissaoKwp: parseMoeda(document.getElementById("mct-comissao-kwp").value) || 60
  };
}

function atualizarPreviewParcelas() {
  if (document.getElementById("mct-forma").value === "entrada_parcelas") aplicarPadraoEntradaParcelas();
  const f = lerFormularioContrato();
  if (f.forma === "personalizada") {
    document.getElementById("mct-valor").value = f.valorTotal ? String(f.valorTotal.toFixed(2)).replace(".", ",") : "";
  }
  if (!f.valorTotal) { document.getElementById("mct-preview-parcelas").textContent = ""; return; }
  const parcelas = calcularParcelas(f.valorTotal, f.forma, f.valorEntrada, f.numParcelas, f.diaVencimento, f.dataPrimeira, f.parcelasPersonalizadas);
  let texto;
  if (f.forma === "avista") texto = `À vista: ${fmtMoeda(parcelas[0].valor)} em ${fmtData(parcelas[0].vencimento)}.`;
  else if (f.forma === "personalizada") texto = `${parcelas.length}x personalizadas, total ${fmtMoeda(f.valorTotal)}.`;
  else texto = `Entrada de ${fmtMoeda(parcelas[0].valor)} em ${fmtData(parcelas[0].vencimento)} + ${f.numParcelas}x de ~${fmtMoeda(parcelas[1] ? parcelas[1].valor : 0)}, todo dia ${f.diaVencimento}.`;
  document.getElementById("mct-preview-parcelas").textContent = texto;
}
["mct-valor", "mct-forma", "mct-entrada", "mct-numparcelas", "mct-diavencimento", "mct-primeiraparcela"].forEach((id) => {
  document.getElementById(id).addEventListener("input", () => {
    // Editar entrada/nº de parcelas à mão desliga a sugestão automática
    // ANTES de recalcular o preview, senão o 1º caractere digitado seria
    // sobrescrito pelo valor sugerido no mesmo evento.
    if (id === "mct-entrada" || id === "mct-numparcelas") parcelamentoAutoPreenchido = false;
    atualizarPreviewParcelas();
  });
  document.getElementById(id).addEventListener("change", atualizarPreviewParcelas);
});
// Enquanto true, "entrada" e "nº de parcelas" ainda não foram editados à
// mão — o sistema pode continuar sugerindo entrada = 1/6 do valor total e
// 5 parcelas (6 pagamentos iguais no total) sempre que o valor mudar.
// Vira false assim que a pessoa mexe em qualquer um dos dois campos, e aí
// para de sugerir/sobrescrever o que ela já ajustou.
let parcelamentoAutoPreenchido = true;
function aplicarPadraoEntradaParcelas() {
  if (!parcelamentoAutoPreenchido) return;
  const total = parseMoeda(document.getElementById("mct-valor").value);
  document.getElementById("mct-numparcelas").value = 5;
  const entradaSugerida = total > 0 ? Math.round((total / 6) * 100) / 100 : 0;
  document.getElementById("mct-entrada").value = entradaSugerida ? String(entradaSugerida.toFixed(2)).replace(".", ",") : "";
}
document.getElementById("mct-forma").addEventListener("change", (e) => {
  const forma = e.target.value;
  document.getElementById("mct-linha-parcelamento").style.display = forma === "entrada_parcelas" ? "flex" : "none";
  document.getElementById("mct-bloco-personalizadas").style.display = forma === "personalizada" ? "block" : "none";
  document.getElementById("mct-valor").readOnly = forma === "personalizada";
  if (forma === "personalizada" && !document.querySelectorAll("#mct-parcelas-personalizadas-lista .parcela-personalizada-linha").length) {
    preencherPadraoParcelasPersonalizadas();
  }
  atualizarPreviewParcelas();
});
document.getElementById("mct-tipo-contrato").addEventListener("change", (e) => {
  document.getElementById("mct-bloco-comissao").style.display = e.target.value === "consultoria_comissao" ? "block" : "none";
});

function limparFormularioContrato() {
  ["mct-valor", "mct-entrada", "mct-telefone", "mct-email", "mct-cpfcnpj", "mct-endereco-busca", "mct-representante-nome", "mct-representante-cpf", "mct-comissao-pct", "mct-comissao-piso", "mct-comissao-kwp"].forEach((id) => (document.getElementById(id).value = ""));
  atualizarBlocoRepresentanteContrato();
  document.getElementById("mct-tipo-contrato").value = "padrao";
  document.getElementById("mct-bloco-comissao").style.display = "none";
  comboContrato.reset();
  parcelamentoAutoPreenchido = true;
  document.getElementById("mct-numparcelas").value = 1;
  document.getElementById("mct-diavencimento").value = 10;
  document.getElementById("mct-forma").value = "avista";
  document.getElementById("mct-valor").readOnly = false;
  document.getElementById("mct-linha-parcelamento").style.display = "none";
  document.getElementById("mct-bloco-personalizadas").style.display = "none";
  limparParcelasPersonalizadas();
  document.getElementById("mct-preview-parcelas").textContent = "";
}

// "todos os dados de todas as tabelas que faltam" pro contrato — telefone,
// CPF/CNPJ e endereço do cliente. Só preenche o que já existe; o que
// faltar fica em branco pra pessoa completar ali mesmo, na hora de gerar
// (e é obrigatório — ver gerarContrato()).
function preencherCamposFaltantesContrato(clienteId) {
  const cliente = STATE.clientes.find((c) => c.id === clienteId);
  document.getElementById("mct-telefone").value = cliente ? (cliente.telefone || "") : "";
  document.getElementById("mct-email").value = cliente ? (cliente.email || "") : "";
  document.getElementById("mct-cpfcnpj").value = cliente ? (cliente.cpfCnpj || "") : "";
  document.getElementById("mct-endereco-busca").value = cliente ? (cliente.endereco || "") : "";
  document.getElementById("mct-representante-nome").value = cliente ? (cliente.representanteNome || "") : "";
  document.getElementById("mct-representante-cpf").value = cliente ? (cliente.representanteCpf || "") : "";
  atualizarBlocoRepresentanteContrato();
}
wireMascaraCpfCnpj("mct-cpfcnpj");
wireMascaraCpfCnpj("mct-representante-cpf");
const atualizarBlocoRepresentanteContrato = wireBlocoRepresentante("mct-cpfcnpj", "mct-bloco-representante");
criarBuscaEndereco("mct-endereco-busca", "mct-endereco-dropdown");

document.getElementById("btn-novo-contrato").addEventListener("click", () => {
  pendingContratoOportunidadeId = null;
  pendingContratoEtapaFechamentoId = null;
  limparFormularioContrato();
  document.getElementById("mct-data-contrato").value = hojeStr();
  document.getElementById("mct-primeiraparcela").value = hojeStr();
  document.getElementById("mct-linha-parcelamento").style.display = "none";
  abrirModal("modal-contrato");
});

document.getElementById("btn-gerar-contrato").addEventListener("click", gerarContrato);
async function gerarContrato() {
  const clienteSelecionado = comboContrato.clienteSelecionado;
  if (!clienteSelecionado) { mostrarErro("Selecione um cliente da lista, ou clique em \"+ Criar cliente\" pra cadastrar um novo."); return; }
  const f = lerFormularioContrato();
  if (!f.valorTotal) { mostrarErro("Informe o valor total."); return; }
  if (f.forma === "personalizada" && f.parcelasPersonalizadas.some((p) => !p.valor || !p.vencimento)) {
    mostrarErro("Preencha valor e vencimento de todas as parcelas personalizadas.");
    return;
  }

  // Telefone, CPF/CNPJ e endereço são obrigatórios pra gerar o contrato —
  // o card só sai da etapa de origem depois de passar por aqui.
  const telefoneContrato = document.getElementById("mct-telefone").value.trim();
  const cpfCnpjContrato = document.getElementById("mct-cpfcnpj").value.trim();
  const enderecoContrato = document.getElementById("mct-endereco-busca").value.trim();
  if (!telefoneContrato) { mostrarErro("Telefone é obrigatório pra gerar o contrato."); return; }
  if (!cpfCnpjContrato) { mostrarErro("CPF ou CNPJ é obrigatório pra gerar o contrato."); return; }
  if (!enderecoContrato) { mostrarErro("Endereço é obrigatório pra gerar o contrato."); return; }

  // Cliente pessoa jurídica (CNPJ) precisa de um representante legal
  // qualificado no contrato — pessoa física não (ela mesma assina).
  const representanteNomeContrato = document.getElementById("mct-representante-nome").value.trim();
  const representanteCpfContrato = document.getElementById("mct-representante-cpf").value.trim();
  const clienteEhPj = apenasDigitos(cpfCnpjContrato).length > 11;
  if (clienteEhPj && !representanteNomeContrato) { mostrarErro("Nome do representante legal é obrigatório pra CNPJ."); return; }
  if (clienteEhPj && !representanteCpfContrato) { mostrarErro("CPF do representante legal é obrigatório pra CNPJ."); return; }

  const parcelasCalc = calcularParcelas(f.valorTotal, f.forma, f.valorEntrada, f.numParcelas, f.diaVencimento, f.dataPrimeira, f.parcelasPersonalizadas);

  try {
    // Pré-preenchido a partir de uma oportunidade sem clienteId (dado
    // antigo) ainda pode cair aqui sem id — busca/cria pelo nome nesse
    // caso; senão, a seleção do combobox já é confiável.
    const cliente = clienteSelecionado.id ? clienteSelecionado : await encontrarOuCriarCliente(clienteSelecionado.nome, "");

    // "todos os dados que faltam pro contrato" — completa o cadastro do
    // cliente com o que estava em branco (nunca sobrescreve o que já
    // existia).
    const emailContrato = document.getElementById("mct-email").value.trim();
    const clienteAtual = STATE.clientes.find((c) => c.id === cliente.id);
    const patchCliente = {};
    if (telefoneContrato && !(clienteAtual && clienteAtual.telefone)) patchCliente.telefone = telefoneContrato;
    if (emailContrato && !(clienteAtual && clienteAtual.email)) patchCliente.email = emailContrato;
    if (cpfCnpjContrato && !(clienteAtual && clienteAtual.cpfCnpj)) patchCliente.cpfCnpj = cpfCnpjContrato;
    if (enderecoContrato && !(clienteAtual && clienteAtual.endereco)) patchCliente.endereco = enderecoContrato;
    if (representanteNomeContrato && !(clienteAtual && clienteAtual.representanteNome)) patchCliente.representanteNome = representanteNomeContrato;
    if (representanteCpfContrato && !(clienteAtual && clienteAtual.representanteCpf)) patchCliente.representanteCpf = representanteCpfContrato;
    if (Object.keys(patchCliente).length) await updateDoc(doc(db, "clientes", cliente.id), patchCliente);

    // Pro texto do PDF, usa sempre o que está no formulário agora (mais
    // recente que o "cliente" selecionado no combobox, que pode não ter
    // esses campos se acabaram de ser preenchidos aqui pela 1ª vez).
    const clienteParaPdf = {
      nome: cliente.nome, cpfCnpj: cpfCnpjContrato, endereco: enderecoContrato,
      representanteNome: representanteNomeContrato, representanteCpf: representanteCpfContrato,
      telefone: telefoneContrato, email: emailContrato
    };

    // "dataContrato" (data da assinatura, editável) é o que conta pro
    // faturamento do período — "dataGeracao" continua sendo o timestamp
    // real de quando o registro foi lançado no sistema, só pra auditoria.
    // Lançar um contrato antigo hoje não deveria contar como faturamento
    // deste mês.
    const dataContrato = document.getElementById("mct-data-contrato").value || hojeStr();
    const ehComissao = f.tipoContrato === "consultoria_comissao";
    const contratoRef = await addDoc(collection(db, "contratos"), {
      oportunidadeId: pendingContratoOportunidadeId || null,
      clienteId: cliente.id, clienteNome: cliente.nome,
      valorTotal: f.valorTotal, formaPagamento: f.forma,
      valorEntrada: f.forma === "entrada_parcelas" ? f.valorEntrada : 0,
      numParcelas: f.forma === "avista" ? 1 : f.numParcelas,
      diaVencimento: f.diaVencimento, dataContrato,
      tipoContrato: f.tipoContrato,
      ...(ehComissao ? { comissaoPct: f.comissaoPct, comissaoPiso: f.comissaoPiso, comissaoKwp: f.comissaoKwp } : {}),
      dataGeracao: serverTimestamp(), pdfUrl: null, pdfFileId: null, status: "ativo"
    });

    for (const p of parcelasCalc) {
      await addDoc(collection(db, "parcelas"), {
        contratoId: contratoRef.id, clienteId: cliente.id, clienteNome: cliente.nome,
        numero: p.numero, valor: p.valor, vencimento: p.vencimento,
        status: "esperado", dataPagamento: null, createdAt: serverTimestamp()
      });
    }

    const primeiraEtapaAdmin = [...STATE.etapasAdmin].sort((a, b) => a.ordem - b.ordem)[0];
    if (primeiraEtapaAdmin) {
      await addDoc(collection(db, "cardsAdmin"), {
        contratoId: contratoRef.id, clienteId: cliente.id, clienteNome: cliente.nome,
        valorTotal: f.valorTotal, etapa: primeiraEtapaAdmin.id,
        dataEntrouEtapa: serverTimestamp(), createdAt: serverTimestamp(), updatedAt: serverTimestamp()
      });
    }

    if (pendingContratoOportunidadeId) {
      const opOrigem = STATE.oportunidades.find((o) => o.id === pendingContratoOportunidadeId);
      await updateDoc(doc(db, "oportunidades", pendingContratoOportunidadeId), {
        etapa: pendingContratoEtapaFechamentoId, dataEntrouEtapa: serverTimestamp(), fechada: true, contratoId: contratoRef.id, updatedAt: serverTimestamp()
      });
      await addDoc(collection(db, "oportunidades", pendingContratoOportunidadeId, "historico"), {
        tipo: "mudanca_etapa", de: opOrigem ? opOrigem.etapa : null, para: pendingContratoEtapaFechamentoId, timestamp: serverTimestamp()
      });
    }

    // Contrato, parcelas e card administrativo já estão salvos — o resto
    // (gerar o PDF) fica pra depois, em segundo plano, porque a chamada ao
    // Apps Script (Docs → PDF → Drive) pode levar vários segundos e não
    // deveria travar o modal esperando isso.
    fecharModal("modal-contrato");
    limparFormularioContrato();
    pendingContratoOportunidadeId = null;
    pendingContratoEtapaFechamentoId = null;
    mostrarToast("Contrato criado.");

    gerarPdfContratoEmSegundoPlano(contratoRef.id, cliente.nome, montarHtmlContrato(
      clienteParaPdf,
      {
        valorTotal: f.valorTotal, formaPagamento: f.forma, valorEntrada: f.valorEntrada, numParcelas: f.numParcelas, dataContrato,
        tipoContrato: f.tipoContrato, comissaoPct: f.comissaoPct, comissaoPiso: f.comissaoPiso, comissaoKwp: f.comissaoKwp
      },
      parcelasCalc
    ));
  } catch (err) {
    mostrarErro("Não foi possível gerar o contrato: " + err.message);
  }
}

// Roda depois que o modal já fechou — por isso não é "await"ado por
// gerarContrato(). O pequeno atraso antes do "Gerando PDF..." é só pra dar
// tempo do toast "Contrato criado." aparecer antes de ser substituído.
async function gerarPdfContratoEmSegundoPlano(contratoId, clienteNome, htmlContrato) {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  mostrarToast(`Gerando PDF do contrato de ${clienteNome}...`);
  try {
    const resp = await chamarAppsScript("gerarContratoPDF", { html: htmlContrato, clienteNome });
    await updateDoc(doc(db, "contratos", contratoId), { pdfUrl: resp.url, pdfFileId: resp.fileId || null });
    mostrarToast(`PDF do contrato de ${clienteNome} criado.`);
  } catch (err) {
    mostrarErro(`Contrato de ${clienteNome} criado, mas o PDF não pôde ser gerado: ` + err.message);
  }
}

// Drive expõe o mesmo arquivo em URLs diferentes conforme o uso: "/preview"
// funciona embutido num iframe (não força download, mostra visor nativo do
// Drive), e "uc?export=download" força o download direto do arquivo. As
// duas exigem que o arquivo esteja compartilhado "qualquer pessoa com o
// link" — já é o que o Code.gs configura ao gerar o PDF.
function linksPdfDrive(fileId) {
  if (!fileId) return null;
  return {
    preview: `https://drive.google.com/file/d/${fileId}/preview`,
    download: `https://drive.google.com/uc?export=download&id=${fileId}`
  };
}

document.getElementById("contr-busca").addEventListener("input", (e) => {
  STATE.buscaContratos = e.target.value || "";
  renderTabelaContratos();
});

function formaPagamentoLabel(c) {
  return c.formaPagamento === "avista" ? "À vista" : c.formaPagamento === "personalizada" ? `${c.numParcelas}x personalizadas` : `Entrada + ${c.numParcelas}x`;
}
function statusContrato(c) { return c.status === "cancelado" ? "cancelado" : "ativo"; }

function renderTabelaContratos() {
  const termoBusca = STATE.buscaContratos.trim().toLowerCase();
  const contratosVisiveis = !termoBusca ? STATE.contratos : STATE.contratos.filter((c) => {
    const alvo = [
      c.clienteNome, String(c.valorTotal || ""), fmtMoeda(c.valorTotal), formaPagamentoLabel(c),
      statusContrato(c) === "cancelado" ? "cancelado" : "ativo", fmtData(dataContratoDe(c))
    ].join(" ").toLowerCase();
    return alvo.includes(termoBusca);
  });

  const hoje = hojeStr();
  const idsVisiveis = new Set(contratosVisiveis.map((c) => c.id));
  const parcelasVisiveis = STATE.parcelas.filter((p) => idsVisiveis.has(p.contratoId));
  const parcelasVencidas = parcelasVisiveis.filter((p) => p.status === "esperado" && p.vencimento && p.vencimento < hoje);
  const somar = (lista) => lista.reduce((s, p) => s + (Number(p.valor) || 0), 0);
  const contratosAtivos = contratosVisiveis.filter((c) => statusContrato(c) === "ativo");

  const nomeClienteDaParcela = (p) => { const c = STATE.contratos.find((x) => x.id === p.contratoId); return c ? c.clienteNome : "—"; };
  const linhaListaContrato = (c) => [esc(c.clienteNome), fmtMoeda(c.valorTotal), formaPagamentoLabel(c), statusContrato(c) === "ativo" ? "Ativo" : "Cancelado"];
  CACHE_LISTA_KPI.contratosParcelasAtraso = { titulo: "Parcelas em atraso", subtitulo: `${parcelasVencidas.length} parcela(s)`, colunas: ["Cliente", "Valor", "Vencimento"], linhas: parcelasVencidas.map((p) => [esc(nomeClienteDaParcela(p)), fmtMoeda(p.valor), fmtData(p.vencimento)]) };
  CACHE_LISTA_KPI.contratosTotal = { titulo: "Total contratado", subtitulo: `${contratosVisiveis.length} contrato(s)`, colunas: ["Cliente", "Valor total", "Forma de pagamento", "Status"], linhas: contratosVisiveis.map(linhaListaContrato) };
  CACHE_LISTA_KPI.contratosAtivos = { titulo: "Contratos ativos", subtitulo: `${contratosAtivos.length} contrato(s)`, colunas: ["Cliente", "Valor total", "Forma de pagamento", "Status"], linhas: contratosAtivos.map(linhaListaContrato) };

  document.getElementById("contratos-kpis").innerHTML = `
    <div class="kpi-card negative"><div class="label">Parcelas em atraso</div><div class="value clicavel" onclick="window.__jm.abrirListaKpi('contratosParcelasAtraso')">${fmtMoeda(somar(parcelasVencidas))}</div><div class="sub">${parcelasVencidas.length} parcela(s) vencida(s) e não pagas</div></div>
    <div class="kpi-card"><div class="label">Total contratado</div><div class="value clicavel" onclick="window.__jm.abrirListaKpi('contratosTotal')">${fmtMoeda(contratosVisiveis.reduce((s, c) => s + (Number(c.valorTotal) || 0), 0))}</div><div class="sub">soma do valor total dos contratos</div></div>
    <div class="kpi-card positive"><div class="label">Contratos ativos</div><div class="value clicavel" onclick="window.__jm.abrirListaKpi('contratosAtivos')">${contratosAtivos.length}</div><div class="sub">de ${contratosVisiveis.length} no total</div></div>
  `;

  document.getElementById("tabela-contratos").innerHTML = contratosVisiveis.map((c) => {
    const parcelasDoContrato = STATE.parcelas.filter((p) => p.contratoId === c.id);
    const pagas = parcelasDoContrato.filter((p) => p.status === "realizado").length;
    const links = linksPdfDrive(c.pdfFileId);
    return `<tr class="linha-clicavel" onclick="window.__jm.abrirDetalheContrato('${c.id}')">
      <td>${esc(c.clienteNome)}</td>
      <td class="num">${fmtMoeda(c.valorTotal)}</td>
      <td>${formaPagamentoLabel(c)}</td>
      <td>${pagas}/${parcelasDoContrato.length}</td>
      <td>${fmtData(dataContratoDe(c))}</td>
      <td>${links ? `<a href="${esc(links.download)}" onclick="event.stopPropagation()">Baixar PDF</a>` : c.pdfUrl ? `<a href="${esc(c.pdfUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Ver PDF</a>` : `<button class="btn-small" onclick="event.stopPropagation();window.__jm.gerarPdfContratoExistente('${c.id}')">Gerar PDF</button>`}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="6"><div class="empty">${termoBusca ? "Nenhum contrato encontrado pra essa busca." : "Nenhum contrato ainda."}</div></td></tr>`;
}

async function excluirContrato(id) {
  if (!(await confirmarAcao("Excluir este contrato e todas as parcelas/etapas administrativas vinculadas? Isso não pode ser desfeito."))) return;
  try {
    for (const p of STATE.parcelas.filter((x) => x.contratoId === id)) await deleteDoc(doc(db, "parcelas", p.id));
    for (const c of STATE.cardsAdmin.filter((x) => x.contratoId === id)) await deleteDoc(doc(db, "cardsAdmin", c.id));
    await deleteDoc(doc(db, "contratos", id));
    mostrarToast("Contrato excluído.");
  } catch (err) { mostrarErro("Não foi possível excluir: " + err.message); }
}

function editarContratoStatus(id) {
  const c = STATE.contratos.find((x) => x.id === id);
  if (!c) return;
  pendingContratoStatusId = id;
  document.getElementById("modal-contrato-status-titulo").textContent = `Editar contrato — ${c.clienteNome}`;
  document.getElementById("mcs-data-contrato").value = dataContratoDe(c);
  document.getElementById("mcs-status").value = c.status || "ativo";
  abrirModal("modal-contrato-status");
}
document.getElementById("btn-salvar-contrato-status").addEventListener("click", async () => {
  if (!pendingContratoStatusId) return;
  const dataContrato = document.getElementById("mcs-data-contrato").value;
  if (!dataContrato) { mostrarErro("Informe a data do contrato."); return; }
  try {
    await updateDoc(doc(db, "contratos", pendingContratoStatusId), {
      dataContrato, status: document.getElementById("mcs-status").value
    });
    fecharModal("modal-contrato-status");
    pendingContratoStatusId = null;
    mostrarToast("Contrato atualizado.");
  } catch (err) { mostrarErro(err.message); }
});

function abrirDetalheContrato(id) {
  const c = STATE.contratos.find((x) => x.id === id);
  if (!c) return;
  const parcelasDoContrato = STATE.parcelas.filter((p) => p.contratoId === id);
  const pagas = parcelasDoContrato.filter((p) => p.status === "realizado").length;
  const links = linksPdfDrive(c.pdfFileId);
  const campos = [
    ["Tipo de contrato", c.tipoContrato === "consultoria_comissao" ? "Consultoria com comissão variável" : "Padrão — Assessoria Empresarial"],
    ["Valor total", esc(fmtMoeda(c.valorTotal))],
    ["Forma de pagamento", esc(descricaoFormaPagamento(c.formaPagamento, c.valorEntrada, c.numParcelas))],
    ["Parcelas pagas", `${pagas}/${parcelasDoContrato.length}`],
    ["Data do contrato", esc(fmtData(dataContratoDe(c)))],
    ["Lançado no sistema em", esc(fmtDataHora(c.dataGeracao))],
    ["Status", esc(c.status === "cancelado" ? "Cancelado" : "Ativo")]
  ];
  if (c.tipoContrato === "consultoria_comissao") {
    campos.push(["Comissão variável", `${esc(String(c.comissaoPct ?? 4))}% sobre o que exceder ${esc(fmtMoeda(c.comissaoPiso ?? 400000))}/mês (projetos até ${esc(String(c.comissaoKwp ?? 60))} kWp)`]);
  }
  if (links) {
    campos.push(["PDF", `<iframe src="${esc(links.preview)}" style="width:100%;height:340px;border:1px solid var(--line);border-radius:8px;background:#fff;"></iframe>
      <div style="display:flex;gap:14px;align-items:center;margin-top:8px;flex-wrap:wrap;">
        <a href="${esc(c.pdfUrl || links.preview)}" target="_blank" rel="noopener">Abrir em nova aba</a>
        <a href="${esc(links.download)}">Baixar PDF</a>
        <button class="btn-small" type="button" onclick="window.__jm.gerarPdfContratoExistente('${id}')">Gerar PDF novamente</button>
      </div>
      <p class="hint" style="margin-top:6px;">Use "Gerar PDF novamente" se o modelo do contrato mudou depois que este PDF foi gerado (ex: placeholder não preenchido) — ele substitui o PDF atual por um novo, com os dados de hoje.</p>`]);
  } else if (c.pdfUrl) {
    campos.push(["PDF", `<a href="${esc(c.pdfUrl)}" target="_blank" rel="noopener">Ver PDF</a>`]);
  } else {
    campos.push(["PDF", `
      <p class="hint" style="margin-bottom:8px;">Ainda não gerado (pode ter sido criado antes do Apps Script estar configurado).</p>
      <button class="btn btn-primary" onclick="window.__jm.gerarPdfContratoExistente('${id}')">Gerar PDF agora</button>
    `]);
  }
  const clienteDoContrato = STATE.clientes.find((x) => x.id === c.clienteId);
  if (c.linkAssinatura) {
    campos.push(["Assinatura eletrônica", `
      <p class="hint" style="margin-bottom:6px;">Status: ${esc(LABEL_STATUS_ASSINATURA[c.statusAssinatura] || "Enviado")} — e-mail disparado pra ${esc((clienteDoContrato && clienteDoContrato.email) || "—")} em ${esc(fmtDataHora(c.enviadoAssinaturaEm))}.</p>
      <a href="${esc(c.linkAssinatura)}" target="_blank" rel="noopener">Abrir link de assinatura</a>
    `]);
  } else if (c.pdfFileId) {
    const emailCliente = clienteDoContrato && clienteDoContrato.email;
    // Botão sempre aparece — quando falta e-mail, fica desabilitado com um
    // aviso explicando por quê (nunca some: a pessoa precisa entender que
    // a ação existe, só não está disponível agora).
    campos.push(["Assinatura eletrônica", `
      <button class="btn btn-primary" ${emailCliente ? "" : "disabled"} title="${emailCliente ? "" : "Cadastre um e-mail pro cliente antes"}" onclick="window.__jm.enviarContratoParaAssinatura('${id}')">Enviar para assinatura digital</button>
      ${emailCliente ? "" : `<p class="hint" style="margin-top:6px;">Cadastre um e-mail pro cliente pra poder enviar o contrato pra assinatura digital.</p>`}
    `]);
  }
  abrirDetalhe({
    titulo: c.clienteNome,
    campos,
    onEditar: () => editarContratoStatus(id),
    onExcluir: () => excluirContrato(id),
    cliente: c.clienteId ? { nome: c.clienteNome, onClick: () => abrirDetalheCliente(c.clienteId, () => abrirDetalheContrato(id)) } : null
  });
}

// Cobre contratos sem PDF ainda, ou o botão "Gerar PDF novamente" (quando
// o modelo do contrato mudou depois que o PDF já tinha sido gerado) —
// gera com os mesmos dados já salvos no contrato, sem precisar recriar
// nada.
async function gerarPdfContratoExistente(id) {
  const c = STATE.contratos.find((x) => x.id === id);
  if (!c) return;
  const cliente = STATE.clientes.find((x) => x.id === c.clienteId) || { nome: c.clienteNome };
  const parcelasDoContrato = STATE.parcelas.filter((p) => p.contratoId === id).sort((a, b) => a.numero - b.numero);
  try {
    const resp = await chamarAppsScript("gerarContratoPDF", {
      html: montarHtmlContrato(cliente, c, parcelasDoContrato),
      clienteNome: c.clienteNome
    });
    await updateDoc(doc(db, "contratos", id), { pdfUrl: resp.url, pdfFileId: resp.fileId || null });
    mostrarToast("PDF gerado com sucesso.");
    abrirDetalheContrato(id);
  } catch (err) { mostrarErro("Não foi possível gerar o PDF: " + err.message); }
}

// ═══ Assinatura eletrônica (Autentique) — o Code.gs é quem fala com a API
// (o token fica em Script Properties, nunca no navegador). A Autentique
// dispara o e-mail com o link de assinatura sozinha; guardamos o link
// aqui também só como cópia de backup, caso o Benedito precise reenviar.
const LABEL_STATUS_ASSINATURA = { enviado: "Enviado, aguardando assinatura", assinado: "Assinado" };

async function enviarContratoParaAssinatura(id) {
  const c = STATE.contratos.find((x) => x.id === id);
  if (!c) return;
  if (!c.pdfFileId) { mostrarErro("Gere o PDF do contrato antes de enviar pra assinatura."); return; }
  const cliente = STATE.clientes.find((x) => x.id === c.clienteId);
  if (!cliente || !cliente.email) { mostrarErro("Cadastre o e-mail do cliente antes de enviar pra assinatura."); return; }
  mostrarToast(`Enviando contrato de ${c.clienteNome} pra assinatura...`);
  try {
    const resp = await chamarAppsScript("enviarParaAssinatura", {
      fileId: c.pdfFileId, clienteNome: c.clienteNome, clienteEmail: cliente.email,
      nomeDocumento: `Contrato - ${c.clienteNome}`
    });
    await updateDoc(doc(db, "contratos", id), {
      autentiqueDocId: resp.autentiqueDocId || null,
      linkAssinatura: resp.link || null,
      statusAssinatura: "enviado",
      enviadoAssinaturaEm: serverTimestamp()
    });
    mostrarToast(`Contrato enviado pra assinatura — e-mail disparado pra ${cliente.email}.`);
    abrirDetalheContrato(id);
  } catch (err) {
    mostrarErro("Não foi possível enviar pra assinatura: " + err.message);
  }
}

/* ══════════════ FUNIL ADMINISTRATIVO ══════════════ */

function renderCardAdmin(c) {
  const etapaCfg = STATE.etapasAdmin.find((e) => e.id === c.etapa);
  return `
    <div class="kcard-nome">${esc(c.clienteNome)}</div>
    <div class="kcard-sub">${fmtMoeda(c.valorTotal)}</div>
    <div class="kcard-foot">
      ${renderBadgeSla(c.dataEntrouEtapa, etapaCfg)}
    </div>
  `;
}

function renderKanbanAdministrativo() {
  const colunas = [...STATE.etapasAdmin].sort((a, b) => a.ordem - b.ordem).map((e) => ({ id: e.id, nome: e.nome }));
  const cards = filtrarCardsFunil(STATE.cardsAdmin, "administrativo", STATE.etapasAdmin,
    (c) => [c.clienteNome, String(c.valorTotal || "")].join(" "));
  renderKanban("kanban-administrativo", "administrativo", colunas, cards, (c) => c.etapa, renderCardAdmin);
  renderListaFunil("administrativo", cards, STATE.etapasAdmin, (c) => c.etapa, (c) => fmtMoeda(c.valorTotal));

  const valorTotal = cards.reduce((s, c) => s + (Number(c.valorTotal) || 0), 0);
  document.getElementById("administrativo-kpis").innerHTML = kpisFunil(cards, STATE.etapasAdmin, [
    { tag: "Contratos em execução", num: String(cards.length), sub: "período e busca aplicados" },
    { tag: "Valor total", num: fmtMoeda(valorTotal), sub: "soma dos contratos" }
  ]);
}
wireToggleFunil("administrativo", renderKanbanAdministrativo);

async function moverCardAdmin(id, novaEtapa) {
  const card = STATE.cardsAdmin.find((c) => c.id === id);
  if (!card || card.etapa === novaEtapa) return;
  try {
    await updateDoc(doc(db, "cardsAdmin", id), {
      etapa: novaEtapa, dataEntrouEtapa: serverTimestamp(), updatedAt: serverTimestamp()
    });
    await addDoc(collection(db, "cardsAdmin", id, "historico"), { tipo: "mudanca_etapa", de: card.etapa, para: novaEtapa, timestamp: serverTimestamp() });
  } catch (err) { mostrarErro("Não foi possível mover: " + err.message); }
}

function editarCardAdmin(id) {
  const c = STATE.cardsAdmin.find((x) => x.id === id);
  if (!c) return;
  pendingCardAdminId = id;
  document.getElementById("modal-cardadmin-titulo").textContent = `Editar — ${c.clienteNome}`;
  document.getElementById("mca-valor").value = String(c.valorTotal || "").replace(".", ",");
  abrirModal("modal-cardadmin");
}
document.getElementById("btn-salvar-cardadmin").addEventListener("click", async () => {
  if (!pendingCardAdminId) return;
  try {
    await updateDoc(doc(db, "cardsAdmin", pendingCardAdminId), { valorTotal: parseMoeda(document.getElementById("mca-valor").value) });
    fecharModal("modal-cardadmin");
    pendingCardAdminId = null;
    mostrarToast("Atualizado.");
  } catch (err) { mostrarErro(err.message); }
});

async function excluirCardAdmin(id) {
  if (!(await confirmarAcao("Excluir este card do Funil Administrativo? Isso NÃO exclui o contrato nem as parcelas vinculadas — use com cuidado."))) return;
  try { await excluirComHistorico("cardsAdmin", id); } catch (err) { mostrarErro(err.message); }
}

function abrirDetalheCardAdmin(id) {
  const c = STATE.cardsAdmin.find((x) => x.id === id);
  if (!c) return;
  const etapaCfg = STATE.etapasAdmin.find((e) => e.id === c.etapa);
  // cardAdmin não guarda clienteId direto — só o contrato que o originou.
  const contratoVinculado = STATE.contratos.find((x) => x.id === c.contratoId);
  const clienteId = contratoVinculado ? contratoVinculado.clienteId : null;
  abrirDetalhe({
    titulo: c.clienteNome,
    campos: [
      ["Valor total", esc(fmtMoeda(c.valorTotal))],
      ["Etapa", esc(etapaCfg ? etapaCfg.nome : "—")],
      ["Contrato vinculado", c.contratoId ? "Sim (veja em Contratos)" : "—"]
    ],
    onEditar: () => editarCardAdmin(id),
    onExcluir: () => excluirCardAdmin(id),
    cliente: clienteId ? { nome: c.clienteNome, onClick: () => abrirDetalheCliente(clienteId, () => abrirDetalheCardAdmin(id)) } : null
  });
}

/* ══════════════ RELATÓRIO DE FUNIL (conversão + tempo em cada etapa) ══════════════
   Sob demanda (só ao clicar em "Relatório", não fica recalculando o
   tempo todo): busca o histórico de cada card do funil (poucas dezenas de
   documentos, tranquilo em paralelo) e reconstrói o conjunto de etapas que
   cada card já visitou (posição atual + todo "para" já registrado). A
   conversão entre etapas consecutivas é (quantos já chegaram na etapa N+1)
   / (quantos já chegaram na etapa N) — como o funil é de trânsito livre,
   isso é uma aproximação padrão de mercado (a mesma lógica que o funil do
   SolarGreen usa), não uma contagem estritamente sequencial. */

function fmtDuracao(ms) {
  if (ms == null) return "—";
  const horas = ms / 3600000;
  if (horas < 24) return `${horas.toFixed(1)}h`;
  return `${(horas / 24).toFixed(1)}d`;
}

async function calcularAnaliseFunil(cards, etapasSorted, colecaoNome) {
  const historicos = await Promise.all(cards.map(async (c) => {
    try {
      const snap = await getDocs(collection(db, colecaoNome, c.id, "historico"));
      return snap.docs.map((d) => d.data());
    } catch (err) { return []; }
  }));

  const alcancaram = {};
  etapasSorted.forEach((e) => (alcancaram[e.id] = new Set()));
  cards.forEach((c, i) => {
    if (alcancaram[c.etapa]) alcancaram[c.etapa].add(c.id);
    historicos[i].forEach((h) => { if (h.para && alcancaram[h.para]) alcancaram[h.para].add(c.id); });
  });

  const agora = Date.now();
  const temposAtuais = {};
  etapasSorted.forEach((e) => (temposAtuais[e.id] = []));
  cards.forEach((c) => {
    if (!c.dataEntrouEtapa || !temposAtuais[c.etapa]) return;
    const d = c.dataEntrouEtapa.toDate ? c.dataEntrouEtapa.toDate() : new Date(c.dataEntrouEtapa);
    if (!isNaN(d.getTime())) temposAtuais[c.etapa].push(agora - d.getTime());
  });

  // A 1ª etapa conta por TOTAL de cards existentes, nunca por
  // alcançabilidade — um card criado (ou editado depois, ex: via
  // planilha.html) direto numa etapa avançada, sem nunca ter passado pela
  // 1ª de verdade, não pode "sumir" do denominador do relatório, senão a
  // conversão das etapas seguintes fica artificialmente maior do que
  // realmente é. Calculado antes do map final pra também corrigir o
  // "anterior" usado na conversão da 2ª etapa (que compara contra a 1ª).
  const jaPassaramPorEtapa = etapasSorted.map((e, i) => i === 0 ? cards.length : alcancaram[e.id].size);

  return etapasSorted.map((e, i) => {
    const jaPassaram = jaPassaramPorEtapa[i];
    const anterior = i > 0 ? jaPassaramPorEtapa[i - 1] : jaPassaram;
    const conversao = i === 0 ? (jaPassaram > 0 ? 100 : 0) : (anterior > 0 ? (jaPassaram / anterior) * 100 : 0);
    const tempos = temposAtuais[e.id];
    const tempoMedioMs = tempos.length ? tempos.reduce((s, v) => s + v, 0) / tempos.length : null;
    return { etapa: e, cardsAgora: cards.filter((c) => c.etapa === e.id).length, jaPassaram, conversao, tempoMedioMs };
  });
}

// Filtro De/Até por relatório (um estado por funil — os 3 relatórios podem
// ter recortes de período diferentes ao mesmo tempo). O filtro decide só
// QUAIS cards entram na "foto" (por data de CRIAÇÃO do card, nunca por
// última movimentação) — "Já passaram"/"Tempo médio" continuam somando o
// histórico INTEIRO de cada card que entrou nessa população, não só as
// transições que caíram dentro do período. Sem filtro (De/Até vazios), o
// relatório continua mostrando todos os cards de sempre, como antes.
const filtrosRelatorioFunil = {
  agendamentos: { de: "", ate: "" },
  oportunidades: { de: "", ate: "" },
  cardsAdmin: { de: "", ate: "" }
};

function renderRelatorioFunil(containerId, linhas, colecaoNome) {
  const filtro = filtrosRelatorioFunil[colecaoNome];
  document.getElementById(containerId).innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:12px;">
      <h2 style="margin:0;">Relatório do <span>funil</span></h2>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <label class="hint" style="margin:0;">De <input type="date" class="rf-de" value="${esc(filtro.de)}" style="margin-left:4px;"></label>
        <label class="hint" style="margin:0;">Até <input type="date" class="rf-ate" value="${esc(filtro.ate)}" style="margin-left:4px;"></label>
        <button class="btn-small rf-limpar" type="button">Tudo</button>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Etapa</th><th>Agora</th><th>Já passaram</th><th>Conversão</th><th>Tempo médio atual</th></tr></thead>
        <tbody>
          ${linhas.map((l) => `<tr>
            <td>${esc(l.etapa.nome)}</td>
            <td class="num">${l.cardsAgora}</td>
            <td class="num">${l.jaPassaram}</td>
            <td class="num">${l.conversao.toFixed(0)}%</td>
            <td class="num">${fmtDuracao(l.tempoMedioMs)}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>
    <p class="hint" style="margin-top:10px;">"Já passaram" conta cada card que já esteve nessa etapa em algum momento (posição atual ou pelo histórico). Como o funil é de trânsito livre (arrastar pra qualquer etapa), a conversão é aproximada — não assume ordem estritamente sequencial. ${filtro.de || filtro.ate ? "Com período ativo, a tabela considera só os cards criados nesse recorte — \"Já passaram\"/tempo médio somam o histórico inteiro desses cards, não só o que aconteceu dentro do período." : "Sem período selecionado, mostra todos os cards de sempre."}</p>
  `;
}

function configurarBotaoRelatorio(btnId, blocoId, getCards, getEtapas, colecaoNome) {
  const bloco = document.getElementById(blocoId);

  async function recalcular() {
    bloco.innerHTML = `<p class="hint">Calculando...</p>`;
    try {
      const filtro = filtrosRelatorioFunil[colecaoNome];
      const todosOsCards = getCards();
      const cardsFiltrados = (!filtro.de && !filtro.ate) ? todosOsCards : todosOsCards.filter((c) => {
        const dataCriacao = dataLocalDeTimestamp(c.createdAt);
        return (!filtro.de || dataCriacao >= filtro.de) && (!filtro.ate || dataCriacao <= filtro.ate);
      });
      const linhas = await calcularAnaliseFunil(cardsFiltrados, getEtapas(), colecaoNome);
      renderRelatorioFunil(blocoId, linhas, colecaoNome);
      bloco.querySelector(".rf-de").addEventListener("change", (e) => { filtrosRelatorioFunil[colecaoNome].de = e.target.value; recalcular(); });
      bloco.querySelector(".rf-ate").addEventListener("change", (e) => { filtrosRelatorioFunil[colecaoNome].ate = e.target.value; recalcular(); });
      bloco.querySelector(".rf-limpar").addEventListener("click", () => {
        filtrosRelatorioFunil[colecaoNome].de = ""; filtrosRelatorioFunil[colecaoNome].ate = "";
        recalcular();
      });
    } catch (err) {
      bloco.innerHTML = `<p class="hint">Não foi possível calcular: ${esc(err.message)}</p>`;
    }
  }

  document.getElementById(btnId).addEventListener("click", () => {
    if (bloco.style.display !== "none") { bloco.style.display = "none"; return; }
    bloco.style.display = "block";
    recalcular();
  });
}
configurarBotaoRelatorio("btn-relatorio-agendamento", "relatorio-agendamento",
  () => STATE.agendamentos, () => [...STATE.etapasAgendamento].sort((a, b) => a.ordem - b.ordem), "agendamentos");
configurarBotaoRelatorio("btn-relatorio-vendas", "relatorio-vendas",
  () => STATE.oportunidades, () => [...STATE.etapasVenda].sort((a, b) => a.ordem - b.ordem), "oportunidades");
configurarBotaoRelatorio("btn-relatorio-administrativo", "relatorio-administrativo",
  () => STATE.cardsAdmin, () => [...STATE.etapasAdmin].sort((a, b) => a.ordem - b.ordem), "cardsAdmin");

/* ══════════════ PAINEL FINANCEIRO ══════════════ */

document.getElementById("fin-periodo").value = STATE.periodoFinanceiro;
document.getElementById("fin-periodo").addEventListener("change", (e) => {
  STATE.periodoFinanceiro = e.target.value || new Date().toISOString().slice(0, 7);
  renderFinanceiro();
});

// Modal compartilhado por parcelas, despesas e entradas pra marcar como
// pago/recebido — sempre pede a data real, nunca assume "hoje". Marcar uma
// parcela antiga como paga sem poder escolher a data fazia ela contar
// como caixa do mês errado (o dia em que alguém clicou, não o dia em que o
// dinheiro de fato entrou).
const COLECAO_POR_TIPO_PAGO = { parcela: "parcelas", despesa: "despesas", entrada: "entradas" };
// Busca o título pelo id (em vez de receber por parâmetro) pra não
// precisar embutir nome/descrição dentro de um atributo onclick — um
// apóstrofo no nome do cliente quebraria a string do onclick.
function tituloParaMarcarPago(tipo, id) {
  if (tipo === "parcela") { const p = STATE.parcelas.find((x) => x.id === id); return p ? p.clienteNome : ""; }
  if (tipo === "despesa") { const d = STATE.despesas.find((x) => x.id === id); return d ? d.descricao : ""; }
  if (tipo === "entrada") { const e = STATE.entradas.find((x) => x.id === id); return e ? e.descricao : ""; }
  return "";
}
function abrirModalMarcarPago(tipo, id) {
  pendingMarcarPago = { tipo, id };
  const titulo = tituloParaMarcarPago(tipo, id);
  document.getElementById("modal-marcar-pago-titulo").textContent = titulo
    ? `Marcar como ${tipo === "despesa" ? "pago" : "recebido"} — ${titulo}`
    : `Marcar como ${tipo === "despesa" ? "pago" : "recebido"}`;
  document.getElementById("mmp-data").value = hojeStr();
  abrirModal("modal-marcar-pago");
}
document.getElementById("btn-confirmar-marcar-pago").addEventListener("click", async () => {
  if (!pendingMarcarPago) return;
  const data = document.getElementById("mmp-data").value;
  if (!data) { mostrarErro("Informe a data."); return; }
  const { tipo, id } = pendingMarcarPago;
  try {
    await updateDoc(doc(db, COLECAO_POR_TIPO_PAGO[tipo], id), { status: "realizado", dataPagamento: data });
    fecharModal("modal-marcar-pago");
    pendingMarcarPago = null;
    mostrarToast(tipo === "despesa" ? "Marcado como pago." : "Marcado como recebido.");
  } catch (err) { mostrarErro(err.message); }
});

// Reverte um "marcar como pago" feito por engano — volta pra "esperado" e
// limpa a data de pagamento. Vale pra parcela, despesa e entrada, que
// compartilham o mesmo formato de status.
async function desmarcarPago(tipo, id) {
  const titulo = tituloParaMarcarPago(tipo, id);
  const acao = tipo === "despesa" ? "pago" : tipo === "entrada" ? "recebido" : "paga";
  if (!(await confirmarAcao(`Desfazer e marcar${titulo ? ` "${titulo}"` : ""} como não ${acao}?`, { textoConfirmar: "Desfazer", destrutivo: false }))) return;
  try {
    await updateDoc(doc(db, COLECAO_POR_TIPO_PAGO[tipo], id), { status: "esperado", dataPagamento: null });
    mostrarToast("Pagamento desfeito.");
  } catch (err) { mostrarErro(err.message); }
}

function editarParcela(id) {
  const p = STATE.parcelas.find((x) => x.id === id);
  if (!p) return;
  pendingParcelaId = id;
  document.getElementById("modal-parcela-titulo").textContent = `Editar parcela — ${p.clienteNome}`;
  document.getElementById("mp2-valor").value = String(p.valor || "").replace(".", ",");
  document.getElementById("mp2-vencimento").value = p.vencimento || "";
  document.getElementById("mp2-status").value = p.status || "esperado";
  document.getElementById("mp2-datapagamento").value = p.dataPagamento || "";
  abrirModal("modal-parcela");
}
document.getElementById("btn-salvar-parcela").addEventListener("click", async () => {
  if (!pendingParcelaId) return;
  const status = document.getElementById("mp2-status").value;
  try {
    await updateDoc(doc(db, "parcelas", pendingParcelaId), {
      valor: parseMoeda(document.getElementById("mp2-valor").value),
      vencimento: document.getElementById("mp2-vencimento").value,
      status, dataPagamento: status === "realizado" ? (document.getElementById("mp2-datapagamento").value || hojeStr()) : null
    });
    fecharModal("modal-parcela");
    pendingParcelaId = null;
    mostrarToast("Parcela atualizada.");
  } catch (err) { mostrarErro(err.message); }
});

async function excluirParcela(id) {
  if (!(await confirmarAcao("Excluir esta parcela? Isso NÃO ajusta o valor total do contrato — use com cuidado."))) return;
  try { await deleteDoc(doc(db, "parcelas", id)); } catch (err) { mostrarErro(err.message); }
}

function abrirDetalheParcela(id) {
  const p = STATE.parcelas.find((x) => x.id === id);
  if (!p) return;
  // Parcela não guarda clienteId direto — vem do contrato que a gerou.
  const contratoDaParcela = STATE.contratos.find((x) => x.id === p.contratoId);
  const clienteId = contratoDaParcela ? contratoDaParcela.clienteId : null;
  abrirDetalhe({
    titulo: `${p.clienteNome} — ${p.numero === 0 ? "Entrada" : "Parcela " + p.numero}`,
    campos: [
      ["Valor", esc(fmtMoeda(p.valor))],
      ["Vencimento", esc(fmtData(p.vencimento))],
      p.status === "realizado"
        ? ["Status", `Pago em ${esc(fmtData(p.dataPagamento))} <button class="btn-small" style="margin-left:8px;" onclick="window.__jm.desmarcarPago('parcela','${id}')">Desfazer</button>`]
        : ["Status", `Esperado <button class="btn-small" style="margin-left:8px;" onclick="window.__jm.abrirModalMarcarPago('parcela','${id}')">Marcar paga</button>`]
    ],
    onEditar: () => editarParcela(id),
    onExcluir: () => excluirParcela(id),
    cliente: clienteId ? { nome: p.clienteNome, onClick: () => abrirDetalheCliente(clienteId, () => abrirDetalheParcela(id)) } : null
  });
}

function renderFinanceiro() {
  // Chamado pelos listeners de contratos e parcelas, que a SDR também tem.
  // Sem esta guarda, o painel seria montado com despesas e entradas vazias
  // (as coleções que ela não lê) e mostraria lucro e saldo errados — numa
  // view escondida, mas errados. Melhor não calcular do que calcular torto.
  if (!podeVer("financeiro")) return;
  const periodo = STATE.periodoFinanceiro;

  const faturamentoPeriodo = STATE.contratos
    .filter((c) => dataContratoDe(c).slice(0, 7) === periodo)
    .reduce((s, c) => s + (Number(c.valorTotal) || 0), 0);

  const parcelasDoPeriodo = STATE.parcelas.filter((p) => (p.vencimento || "").slice(0, 7) === periodo);
  const entradasDoPeriodo = STATE.entradas.filter((e) => (e.data || "").slice(0, 7) === periodo);
  // Caixa esperado/realizado soma parcelas de contrato + entradas avulsas
  // (lançadas manualmente, sem vir de nenhum contrato) — as duas são
  // dinheiro entrando, só a origem é diferente.
  const fluxoEsperado = parcelasDoPeriodo.filter((p) => p.status === "esperado").reduce((s, p) => s + (Number(p.valor) || 0), 0)
    + entradasDoPeriodo.filter((e) => e.status === "esperado").reduce((s, e) => s + (Number(e.valor) || 0), 0);
  const fluxoRealizado = STATE.parcelas
    .filter((p) => p.status === "realizado" && (p.dataPagamento || "").slice(0, 7) === periodo)
    .reduce((s, p) => s + (Number(p.valor) || 0), 0)
    + STATE.entradas
      .filter((e) => e.status === "realizado" && (e.dataPagamento || "").slice(0, 7) === periodo)
      .reduce((s, e) => s + (Number(e.valor) || 0), 0);

  // Despesa não paga não some quando o mês vira: ela vaza pro período seguinte
  // (e pros depois dele, enquanto continuar pendente) e soma junto no KPI,
  // até ser marcada como paga. Pedido dele em 2026-09-05.
  //
  // Adiantamento é diferente: ele abate o total de outra despesa, então tem
  // que continuar abatendo mesmo depois de marcado como pago — senão marcar
  // "pago" no adiantamento faz a despesa do mês SUBIR (o abatimento some
  // junto), quando na real nada mudou sobre quanto ainda falta. Achado dele
  // em 2026-09-05, testando o caso do adiantamento do Igor Costa.
  const despesasVencidas = STATE.despesas
    .filter((d) => d.tipo === "despesa" && statusDespesa(d) === "esperado" && (d.data || "").slice(0, 7) < periodo)
    .sort((a, b) => (a.data || "").localeCompare(b.data || ""));
  const despesasQueContam = STATE.despesas.filter((d) => {
    if (d.tipo !== "despesa") return false;
    const mes = (d.data || "").slice(0, 7);
    if (mes === periodo) return true;
    return mes < periodo && (ehAdiantamento(d) || statusDespesa(d) === "esperado");
  });
  const despesasMes = despesasQueContam.reduce((s, d) => s + valorComSinal(d), 0);
  const outrosCustos = STATE.despesas.filter((d) => d.tipo === "outro_custo" && (d.data || "").slice(0, 7) === periodo).reduce((s, d) => s + valorComSinal(d), 0);
  const lucroOperacional = fluxoRealizado - despesasMes;
  const saldoEstimado = lucroOperacional - outrosCustos;

  document.getElementById("fin-kpis").innerHTML = `
    <div class="kpi-card"><div class="label">Faturamento do período</div><div class="value">${fmtMoeda(faturamentoPeriodo)}</div><div class="sub">venda fechada no mês</div></div>
    <div class="kpi-card"><div class="label">Caixa esperado</div><div class="value">${fmtMoeda(fluxoEsperado)}</div><div class="sub">parcelas + entradas a vencer no mês</div></div>
    <div class="kpi-card positive"><div class="label">Caixa realizado</div><div class="value">${fmtMoeda(fluxoRealizado)}</div><div class="sub">parcelas + entradas pagas no mês</div></div>
    <div class="kpi-card negative"><div class="label">Despesas do mês</div><div class="value">${fmtMoeda(despesasMes)}</div></div>
    <div class="kpi-card ${lucroOperacional >= 0 ? "positive" : "negative"}"><div class="label">Lucro operacional</div><div class="value">${fmtMoeda(lucroOperacional)}</div><div class="sub">caixa realizado − despesas</div></div>
    <div class="kpi-card negative"><div class="label">Outros custos</div><div class="value">${fmtMoeda(outrosCustos)}</div><div class="sub">impostos e taxas</div></div>
    <div class="kpi-card ${saldoEstimado >= 0 ? "positive" : "negative"}"><div class="label">Saldo estimado</div><div class="value">${fmtMoeda(saldoEstimado)}</div><div class="sub">lucro operacional − outros custos</div></div>
  `;

  const vencidas = STATE.parcelas.filter((p) => p.status === "esperado" && p.vencimento && p.vencimento < hojeStr()).sort((a, b) => a.vencimento.localeCompare(b.vencimento));
  document.getElementById("tabela-parcelas-vencidas").innerHTML = vencidas.map((p) => `<tr class="linha-clicavel" onclick="window.__jm.abrirDetalheParcela('${p.id}')">
    <td>${esc(p.clienteNome)}</td><td>${p.numero === 0 ? "Entrada" : "Parcela " + p.numero}</td>
    <td>${fmtData(p.vencimento)}</td><td class="num">${fmtMoeda(p.valor)}</td>
    <td><button class="btn-small" onclick="event.stopPropagation();window.__jm.abrirModalMarcarPago('parcela','${p.id}')">Marcar paga</button></td>
  </tr>`).join("") || `<tr><td colspan="5"><div class="empty">Nenhuma parcela vencida.</div></td></tr>`;

  document.getElementById("tabela-parcelas-periodo").innerHTML = parcelasDoPeriodo
    .slice().sort((a, b) => (a.vencimento || "").localeCompare(b.vencimento || ""))
    .map((p) => `<tr class="linha-clicavel" onclick="window.__jm.abrirDetalheParcela('${p.id}')">
      <td>${esc(p.clienteNome)}</td><td>${p.numero === 0 ? "Entrada" : "Parcela " + p.numero}</td>
      <td>${fmtData(p.vencimento)}</td><td class="num">${fmtMoeda(p.valor)}</td>
      <td><span class="stamp ${p.status}">${p.status === "realizado" ? "Pago" : "Esperado"}</span></td>
      <td>${p.status === "esperado"
        ? `<button class="btn-small" onclick="event.stopPropagation();window.__jm.abrirModalMarcarPago('parcela','${p.id}')">Marcar paga</button>`
        : `<button class="btn-small" onclick="event.stopPropagation();window.__jm.desmarcarPago('parcela','${p.id}')">Desfazer</button>`}</td>
    </tr>`).join("") || `<tr><td colspan="6"><div class="empty">Nenhuma parcela neste período.</div></td></tr>`;

  const seloAdiantamento = (d) => ehAdiantamento(d) ? ' <span class="stamp andamento">Adiantamento</span>' : "";
  document.getElementById("tabela-despesas-vencidas").innerHTML = despesasVencidas.map((d) => `<tr class="linha-clicavel" onclick="window.__jm.abrirDetalheDespesa('${d.id}')">
    <td>${esc(d.descricao)}${seloAdiantamento(d)}</td><td>${esc(d.categoria || "—")}</td>
    <td>${fmtData(d.data)}</td><td class="num">${fmtMoeda(Math.abs(Number(d.valor) || 0))}</td>
    <td><button class="btn-small" onclick="event.stopPropagation();window.__jm.abrirModalMarcarPago('despesa','${d.id}')">Marcar pago</button></td>
  </tr>`).join("") || `<tr><td colspan="5"><div class="empty">Nenhuma despesa vencida em aberto.</div></td></tr>`;

  const hoje = hojeStr();
  const despesasDoPeriodo = STATE.despesas
    .filter((d) => (d.data || "").slice(0, 7) === periodo)
    .sort((a, b) => (a.data || "").localeCompare(b.data || ""));
  document.getElementById("tabela-despesas-periodo").innerHTML = despesasDoPeriodo.map((d) => {
    const status = statusDespesa(d);
    const vencida = status === "esperado" && (d.data || "") <= hoje;
    return `<tr class="linha-clicavel" onclick="window.__jm.abrirDetalheDespesa('${d.id}')">
    <td>${esc(d.descricao)}${seloAdiantamento(d)}</td><td>${esc(d.categoria || "—")}</td>
    <td>${d.tipo === "despesa" ? "Despesa" : "Outro custo"}</td>
    <td class="num">${fmtMoeda(Math.abs(Number(d.valor) || 0))}</td><td>${fmtData(d.data)}</td>
    <td><span class="stamp ${status === "realizado" ? "realizado" : vencida ? "vencido" : "esperado"}">${status === "realizado" ? "Pago" : vencida ? "A pagar" : "Pendente"}</span></td>
    <td>${status === "realizado"
      ? `<button class="btn-small" onclick="event.stopPropagation();window.__jm.desmarcarPago('despesa','${d.id}')">Desfazer</button>`
      : `<button class="btn-small" onclick="event.stopPropagation();window.__jm.abrirModalMarcarPago('despesa','${d.id}')">Marcar pago</button>`}</td>
  </tr>`;
  }).join("") || `<tr><td colspan="7"><div class="empty">Nenhuma despesa lançada neste período.</div></td></tr>`;
}

/* ══════════════ DESPESAS & CUSTOS ══════════════ */

function abrirModalDespesa() {
  pendingDespesaId = null;
  document.getElementById("modal-despesa-titulo").textContent = "Nova despesa/custo";
  document.getElementById("md-descricao").value = "";
  document.getElementById("md-categoria").value = "";
  document.getElementById("md-valor").value = "";
  document.getElementById("md-data").value = hojeStr();
  document.getElementById("md-chavepix").value = "";
  document.getElementById("md-tipo").value = "despesa";
  document.getElementById("md-recorrente").checked = false;
  document.getElementById("md-adiantamento").checked = false;
  abrirModal("modal-despesa");
}
document.getElementById("btn-nova-despesa").addEventListener("click", abrirModalDespesa);
document.getElementById("btn-nova-despesa-2").addEventListener("click", abrirModalDespesa);

function editarDespesa(id) {
  const d = STATE.despesas.find((x) => x.id === id);
  if (!d) return;
  pendingDespesaId = id;
  document.getElementById("modal-despesa-titulo").textContent = `Editar — ${d.descricao}`;
  document.getElementById("md-descricao").value = d.descricao || "";
  document.getElementById("md-categoria").value = d.categoria || "";
  document.getElementById("md-valor").value = String(d.valor || "").replace(".", ",");
  document.getElementById("md-data").value = d.data || hojeStr();
  document.getElementById("md-chavepix").value = d.chavePix || "";
  document.getElementById("md-tipo").value = d.tipo || "despesa";
  document.getElementById("md-recorrente").checked = !!d.recorrente;
  document.getElementById("md-adiantamento").checked = !!d.adiantamento;
  abrirModal("modal-despesa");
}
document.getElementById("btn-salvar-despesa").addEventListener("click", async () => {
  const descricao = document.getElementById("md-descricao").value.trim();
  const valor = parseMoeda(document.getElementById("md-valor").value);
  const data = document.getElementById("md-data").value || hojeStr();
  if (!descricao) { mostrarErro("Informe a descrição."); return; }
  if (!valor) { mostrarErro("Informe o valor."); return; }
  const recorrente = document.getElementById("md-recorrente").checked;
  const adiantamento = document.getElementById("md-adiantamento").checked;
  const dados = {
    descricao, categoria: document.getElementById("md-categoria").value.trim(),
    // Adiantamento é digitado positivo e abate outra despesa; o sinal é
    // aplicado só na hora de somar (valorComSinal), nunca guardado no dado.
    // Só força positivo quando a chave está marcada, pra não inverter em
    // silêncio o valor de um lançamento antigo que já usava sinal negativo.
    tipo: document.getElementById("md-tipo").value, valor: adiantamento ? Math.abs(valor) : valor, data,
    chavePix: document.getElementById("md-chavepix").value.trim(),
    recorrente, diaVencimento: recorrente ? parseInt(data.split("-")[2], 10) : null,
    adiantamento
  };
  try {
    if (pendingDespesaId) {
      await updateDoc(doc(db, "despesas", pendingDespesaId), dados);
    } else {
      await addDoc(collection(db, "despesas"), {
        ...dados, ultimoMesLancado: recorrente ? data.slice(0, 7) : null,
        origemRecorrenteId: null, status: "esperado", dataPagamento: null, createdAt: serverTimestamp()
      });
    }
    fecharModal("modal-despesa");
    pendingDespesaId = null;
    mostrarToast("Lançamento salvo.");
  } catch (err) { mostrarErro(err.message); }
});

async function excluirDespesa(id) {
  if (!(await confirmarAcao("Excluir este lançamento?"))) return;
  try { await deleteDoc(doc(db, "despesas", id)); } catch (err) { mostrarErro(err.message); }
}

function abrirDetalheDespesa(id) {
  const d = STATE.despesas.find((x) => x.id === id);
  if (!d) return;
  abrirDetalhe({
    titulo: d.descricao,
    campos: [
      ["Categoria", esc(d.categoria || "—")],
      ["Tipo", d.tipo === "despesa" ? "Despesa" : "Outro custo"],
      ["Valor", esc(fmtMoeda(Math.abs(Number(d.valor) || 0)))],
      ["Adiantamento", ehAdiantamento(d) ? "Sim — abate outra despesa" : "—"],
      ["Data", esc(fmtData(d.data))],
      ["Chave PIX", esc(d.chavePix || "—")],
      ["Recorrente", d.recorrente ? `Sim (dia ${d.diaVencimento})` : "—"],
      d.status === "realizado"
        ? ["Status", `Pago em ${esc(fmtData(d.dataPagamento))} <button class="btn-small" style="margin-left:8px;" onclick="window.__jm.desmarcarPago('despesa','${id}')">Desfazer</button>`]
        : ["Status", `Pendente <button class="btn-small" style="margin-left:8px;" onclick="window.__jm.abrirModalMarcarPago('despesa','${id}')">Marcar pago</button>`]
    ],
    onEditar: () => editarDespesa(id),
    onExcluir: () => excluirDespesa(id)
  });
}

// Sem Cloud Functions, não existe "servidor" lançando as despesas
// recorrentes sozinho — a checagem roda no navegador de quem abrir o
// sistema, toda vez que a lista de despesas atualiza (idempotente: só cria
// uma instância nova se "ultimoMesLancado" do modelo ainda não é o mês
// atual).
async function lancarRecorrentesPendentes() {
  if (lancandoRecorrentes) return;
  lancandoRecorrentes = true;
  try {
    const mesAtual = hojeStr().slice(0, 7);
    for (const d of STATE.despesas) {
      if (!d.recorrente || d.ultimoMesLancado === mesAtual) continue;
      const dia = String(d.diaVencimento || 1).padStart(2, "0");
      await addDoc(collection(db, "despesas"), {
        descricao: d.descricao, categoria: d.categoria, tipo: d.tipo, valor: d.valor,
        chavePix: d.chavePix || "",
        data: `${mesAtual}-${dia}`, recorrente: false, diaVencimento: null,
        ultimoMesLancado: null, origemRecorrenteId: d.id,
        status: "esperado", dataPagamento: null, createdAt: serverTimestamp()
      });
      await updateDoc(doc(db, "despesas", d.id), { ultimoMesLancado: mesAtual });
    }
  } catch (err) {
    // Silencioso — não interrompe o uso do resto do app por causa disso.
    console.warn("Falha ao lançar recorrentes:", err);
  } finally {
    lancandoRecorrentes = false;
  }
}


document.getElementById("desp-periodo-de").value = STATE.periodoDespesasDe;
document.getElementById("desp-periodo-ate").value = STATE.periodoDespesasAte;
document.getElementById("desp-periodo-de").addEventListener("change", (e) => {
  STATE.periodoDespesasDe = e.target.value || "";
  renderTabelaDespesas();
});
document.getElementById("desp-periodo-ate").addEventListener("change", (e) => {
  STATE.periodoDespesasAte = e.target.value || "";
  renderTabelaDespesas();
});
document.getElementById("btn-desp-limpar-periodo").addEventListener("click", () => {
  STATE.periodoDespesasDe = "";
  STATE.periodoDespesasAte = "";
  document.getElementById("desp-periodo-de").value = "";
  document.getElementById("desp-periodo-ate").value = "";
  renderTabelaDespesas();
});
document.getElementById("desp-busca").addEventListener("input", (e) => {
  STATE.buscaDespesas = e.target.value || "";
  renderTabelaDespesas();
});

// "Status" de uma despesa: ausente = "esperado" (pendente) — despesas
// lançadas antes desse campo existir contam como pendentes por padrão,
// já que nunca foi registrado se foram pagas.
function statusDespesa(d) { return d.status === "realizado" ? "realizado" : "esperado"; }

// Adiantamento abate outra despesa em vez de somar — digitado positivo, o
// crédito é aplicado só na hora de somar. Cobre também lançamento antigo que
// já usava valor negativo pra representar a mesma ideia (sem o campo).
function ehAdiantamento(d) { return !!d.adiantamento || Number(d.valor) < 0; }
function valorComSinal(d) { return ehAdiantamento(d) ? -Math.abs(Number(d.valor) || 0) : (Number(d.valor) || 0); }

function renderTabelaDespesas() {
  const de = STATE.periodoDespesasDe, ate = STATE.periodoDespesasAte;
  const despesasDoPeriodo = STATE.despesas.filter((d) => {
    const data = d.data || "";
    return (!de || data >= de) && (!ate || data <= ate);
  });
  const hoje = hojeStr();

  // A busca filtra tanto a tabela quanto os KPIs em cima — digitar algo
  // restringe os dois juntos, pra "quanto isso que eu busquei soma" já
  // vir pronto sem precisar somar na mão.
  const termoBusca = STATE.buscaDespesas.trim().toLowerCase();
  const linhasVisiveis = !termoBusca ? despesasDoPeriodo : despesasDoPeriodo.filter((d) => {
    const status = statusDespesa(d);
    const vencida = status === "esperado" && (d.data || "") <= hoje;
    const statusLabel = status === "realizado" ? "pago" : vencida ? "a pagar" : "pendente";
    const alvo = [
      d.descricao, d.categoria, d.tipo === "despesa" ? "despesa" : "outro custo",
      ehAdiantamento(d) ? "adiantamento" : "",
      String(d.valor || ""), fmtMoeda(d.valor), fmtData(d.data), statusLabel, d.chavePix
    ].join(" ").toLowerCase();
    return alvo.includes(termoBusca);
  });

  // Adiantamento abate o total pendente esteja pago ou não — é crédito contra
  // outra despesa, não uma despesa nova. Só vira "pago" de verdade (soma
  // positivo em Total pago) quando ele mesmo é confirmado. Sem separar assim,
  // marcar "pago" no adiantamento fazia o Total pendente SUBIR (o abatimento
  // sumia da conta) e o Total pago ficar negativo. Achado dele em 2026-09-05,
  // testando com o adiantamento do Igor Costa.
  const naoAdiantamento = linhasVisiveis.filter((d) => !ehAdiantamento(d));
  const adiantamentos = linhasVisiveis.filter((d) => ehAdiantamento(d));
  const adiantamentosPagos = adiantamentos.filter((d) => statusDespesa(d) === "realizado");
  const pendentes = naoAdiantamento.filter((d) => statusDespesa(d) === "esperado");
  const pagas = naoAdiantamento.filter((d) => statusDespesa(d) === "realizado");
  const aPagarAteHoje = pendentes.filter((d) => (d.data || "") <= hoje);
  const somarBruto = (lista) => lista.reduce((s, d) => s + Math.abs(Number(d.valor) || 0), 0);
  const totalAdiantamentos = somarBruto(adiantamentos);
  const totalAPagarAteHoje = somarBruto(aPagarAteHoje) - totalAdiantamentos;
  const totalPendente = somarBruto(pendentes) - totalAdiantamentos;
  const totalPago = somarBruto(pagas) + somarBruto(adiantamentosPagos);

  const linhaLista = (d) => [esc(d.descricao) + (ehAdiantamento(d) ? " (adiantamento)" : ""), esc(d.categoria || "—"), fmtMoeda(Math.abs(Number(d.valor) || 0)), fmtData(d.data)];
  CACHE_LISTA_KPI.despesasAPagarHoje = { titulo: "A pagar até hoje", subtitulo: `${aPagarAteHoje.length + adiantamentos.length} lançamento(s)`, colunas: ["Descrição", "Categoria", "Valor", "Data"], linhas: aPagarAteHoje.concat(adiantamentos).map(linhaLista) };
  CACHE_LISTA_KPI.despesasPendentes = { titulo: "Total pendente", subtitulo: `${pendentes.length + adiantamentos.length} lançamento(s)`, colunas: ["Descrição", "Categoria", "Valor", "Data"], linhas: pendentes.concat(adiantamentos).map(linhaLista) };
  CACHE_LISTA_KPI.despesasPagas = { titulo: "Total pago", subtitulo: `${pagas.length + adiantamentosPagos.length} lançamento(s)`, colunas: ["Descrição", "Categoria", "Valor", "Data"], linhas: pagas.concat(adiantamentosPagos).map(linhaLista) };

  document.getElementById("despesas-kpis").innerHTML = `
    <div class="kpi-card negative"><div class="label">A pagar até hoje</div><div class="value clicavel" onclick="window.__jm.abrirListaKpi('despesasAPagarHoje')">${fmtMoeda(totalAPagarAteHoje)}</div><div class="sub">pendentes com data de hoje ou anterior</div></div>
    <div class="kpi-card"><div class="label">Total pendente</div><div class="value clicavel" onclick="window.__jm.abrirListaKpi('despesasPendentes')">${fmtMoeda(totalPendente)}</div><div class="sub">todas as não pagas do período (inclusive futuras)</div></div>
    <div class="kpi-card positive"><div class="label">Total pago</div><div class="value clicavel" onclick="window.__jm.abrirListaKpi('despesasPagas')">${fmtMoeda(totalPago)}</div><div class="sub">todas as pagas do período</div></div>
  `;

  document.getElementById("tabela-despesas").innerHTML = linhasVisiveis
    .slice().sort((a, b) => (b.data || "").localeCompare(a.data || ""))
    .map((d) => {
      const status = statusDespesa(d);
      const vencida = status === "esperado" && (d.data || "") <= hoje;
      return `<tr class="linha-clicavel" onclick="window.__jm.abrirDetalheDespesa('${d.id}')">
      <td>${esc(d.descricao)}${ehAdiantamento(d) ? ' <span class="stamp andamento">Adiantamento</span>' : ""}</td><td>${esc(d.categoria || "—")}</td>
      <td>${d.tipo === "despesa" ? "Despesa" : "Outro custo"}</td>
      <td class="num">${fmtMoeda(Math.abs(Number(d.valor) || 0))}</td><td>${fmtData(d.data)}</td>
      <td class="mono-select">${esc(d.chavePix || "—")}</td>
      <td>${d.recorrente ? "Sim (dia " + d.diaVencimento + ")" : "—"}</td>
      <td><span class="stamp ${status === "realizado" ? "realizado" : vencida ? "vencido" : "esperado"}">${status === "realizado" ? "Pago" : vencida ? "A pagar" : "Pendente"}</span></td>
      <td>${status === "realizado"
        ? `<button class="btn-small" onclick="event.stopPropagation();window.__jm.desmarcarPago('despesa','${d.id}')">Desfazer</button>`
        : `<button class="btn-small" onclick="event.stopPropagation();window.__jm.abrirModalMarcarPago('despesa','${d.id}')">Marcar pago</button>`}</td>
    </tr>`;
    }).join("") || `<tr><td colspan="9"><div class="empty">${termoBusca ? "Nenhuma despesa encontrada pra essa busca." : "Nenhuma despesa no período."}</div></td></tr>`;
}

/* ══════════════ ENTRADAS (recebimentos avulsos, fora de contrato) ══════════════
   Mesmo padrão de Despesas & Custos (status esperado/realizado, filtro de
   período, KPIs), só que do lado da receita — pra dinheiro que entra sem
   vir de uma parcela de contrato (venda avulsa, reembolso, etc). Entra
   junto com as parcelas no Caixa esperado/realizado do Painel Financeiro. */

function abrirModalEntrada() {
  pendingEntradaId = null;
  document.getElementById("modal-entrada-titulo").textContent = "Nova entrada";
  document.getElementById("me-descricao").value = "";
  document.getElementById("me-categoria").value = "";
  document.getElementById("me-valor").value = "";
  document.getElementById("me-data").value = hojeStr();
  abrirModal("modal-entrada");
}
document.getElementById("btn-nova-entrada").addEventListener("click", abrirModalEntrada);

function editarEntrada(id) {
  const e = STATE.entradas.find((x) => x.id === id);
  if (!e) return;
  pendingEntradaId = id;
  document.getElementById("modal-entrada-titulo").textContent = `Editar — ${e.descricao}`;
  document.getElementById("me-descricao").value = e.descricao || "";
  document.getElementById("me-categoria").value = e.categoria || "";
  document.getElementById("me-valor").value = String(e.valor || "").replace(".", ",");
  document.getElementById("me-data").value = e.data || hojeStr();
  abrirModal("modal-entrada");
}
document.getElementById("btn-salvar-entrada").addEventListener("click", async () => {
  const descricao = document.getElementById("me-descricao").value.trim();
  const valor = parseMoeda(document.getElementById("me-valor").value);
  const data = document.getElementById("me-data").value || hojeStr();
  if (!descricao) { mostrarErro("Informe a descrição."); return; }
  if (!valor) { mostrarErro("Informe o valor."); return; }
  const dados = { descricao, categoria: document.getElementById("me-categoria").value.trim(), valor, data };
  try {
    if (pendingEntradaId) {
      await updateDoc(doc(db, "entradas", pendingEntradaId), dados);
    } else {
      await addDoc(collection(db, "entradas"), { ...dados, status: "esperado", dataPagamento: null, createdAt: serverTimestamp() });
    }
    fecharModal("modal-entrada");
    pendingEntradaId = null;
    mostrarToast("Lançamento salvo.");
  } catch (err) { mostrarErro(err.message); }
});

async function excluirEntrada(id) {
  if (!(await confirmarAcao("Excluir este lançamento?"))) return;
  try { await deleteDoc(doc(db, "entradas", id)); } catch (err) { mostrarErro(err.message); }
}

function abrirDetalheEntrada(id) {
  const e = STATE.entradas.find((x) => x.id === id);
  if (!e) return;
  abrirDetalhe({
    titulo: e.descricao,
    campos: [
      ["Categoria", esc(e.categoria || "—")],
      ["Valor", esc(fmtMoeda(e.valor))],
      ["Data prevista", esc(fmtData(e.data))],
      e.status === "realizado"
        ? ["Status", `Recebido em ${esc(fmtData(e.dataPagamento))} <button class="btn-small" style="margin-left:8px;" onclick="window.__jm.desmarcarPago('entrada','${id}')">Desfazer</button>`]
        : ["Status", `Pendente <button class="btn-small" style="margin-left:8px;" onclick="window.__jm.abrirModalMarcarPago('entrada','${id}')">Marcar recebido</button>`]
    ],
    onEditar: () => editarEntrada(id),
    onExcluir: () => excluirEntrada(id)
  });
}

document.getElementById("entr-periodo-de").value = STATE.periodoEntradasDe;
document.getElementById("entr-periodo-ate").value = STATE.periodoEntradasAte;
document.getElementById("entr-periodo-de").addEventListener("change", (e) => {
  STATE.periodoEntradasDe = e.target.value || "";
  renderTabelaEntradas();
});
document.getElementById("entr-periodo-ate").addEventListener("change", (e) => {
  STATE.periodoEntradasAte = e.target.value || "";
  renderTabelaEntradas();
});
document.getElementById("btn-entr-limpar-periodo").addEventListener("click", () => {
  STATE.periodoEntradasDe = "";
  STATE.periodoEntradasAte = "";
  document.getElementById("entr-periodo-de").value = "";
  document.getElementById("entr-periodo-ate").value = "";
  renderTabelaEntradas();
});

function statusEntrada(e) { return e.status === "realizado" ? "realizado" : "esperado"; }

function renderTabelaEntradas() {
  const de = STATE.periodoEntradasDe, ate = STATE.periodoEntradasAte;
  const entradasFiltradas = STATE.entradas.filter((e) => {
    const data = e.data || "";
    return (!de || data >= de) && (!ate || data <= ate);
  });
  const hoje = hojeStr();
  const pendentes = entradasFiltradas.filter((e) => statusEntrada(e) === "esperado");
  const recebidas = entradasFiltradas.filter((e) => statusEntrada(e) === "realizado");
  const aReceberAteHoje = pendentes.filter((e) => (e.data || "") <= hoje);
  const somar = (lista) => lista.reduce((s, e) => s + (Number(e.valor) || 0), 0);

  const linhaLista = (e) => [esc(e.descricao), esc(e.categoria || "—"), fmtMoeda(e.valor), fmtData(e.data)];
  CACHE_LISTA_KPI.entradasAReceberHoje = { titulo: "A receber até hoje", subtitulo: `${aReceberAteHoje.length} lançamento(s)`, colunas: ["Descrição", "Categoria", "Valor", "Data"], linhas: aReceberAteHoje.map(linhaLista) };
  CACHE_LISTA_KPI.entradasPendentes = { titulo: "Total pendente", subtitulo: `${pendentes.length} lançamento(s)`, colunas: ["Descrição", "Categoria", "Valor", "Data"], linhas: pendentes.map(linhaLista) };
  CACHE_LISTA_KPI.entradasRecebidas = { titulo: "Total recebido", subtitulo: `${recebidas.length} lançamento(s)`, colunas: ["Descrição", "Categoria", "Valor", "Data"], linhas: recebidas.map(linhaLista) };

  document.getElementById("entradas-kpis").innerHTML = `
    <div class="kpi-card negative"><div class="label">A receber até hoje</div><div class="value clicavel" onclick="window.__jm.abrirListaKpi('entradasAReceberHoje')">${fmtMoeda(somar(aReceberAteHoje))}</div><div class="sub">pendentes com data de hoje ou anterior</div></div>
    <div class="kpi-card"><div class="label">Total pendente</div><div class="value clicavel" onclick="window.__jm.abrirListaKpi('entradasPendentes')">${fmtMoeda(somar(pendentes))}</div><div class="sub">todas as não recebidas do período (inclusive futuras)</div></div>
    <div class="kpi-card positive"><div class="label">Total recebido</div><div class="value clicavel" onclick="window.__jm.abrirListaKpi('entradasRecebidas')">${fmtMoeda(somar(recebidas))}</div><div class="sub">todas as recebidas do período</div></div>
  `;

  document.getElementById("tabela-entradas").innerHTML = entradasFiltradas
    .slice().sort((a, b) => (b.data || "").localeCompare(a.data || ""))
    .map((e) => {
      const status = statusEntrada(e);
      const vencida = status === "esperado" && (e.data || "") <= hoje;
      return `<tr class="linha-clicavel" onclick="window.__jm.abrirDetalheEntrada('${e.id}')">
      <td>${esc(e.descricao)}</td><td>${esc(e.categoria || "—")}</td>
      <td class="num">${fmtMoeda(e.valor)}</td><td>${fmtData(e.data)}</td>
      <td><span class="stamp ${status === "realizado" ? "realizado" : vencida ? "vencido" : "esperado"}">${status === "realizado" ? "Recebido" : vencida ? "A receber" : "Pendente"}</span></td>
      <td>${status === "realizado"
        ? `<button class="btn-small" onclick="event.stopPropagation();window.__jm.desmarcarPago('entrada','${e.id}')">Desfazer</button>`
        : `<button class="btn-small" onclick="event.stopPropagation();window.__jm.abrirModalMarcarPago('entrada','${e.id}')">Marcar recebido</button>`}</td>
    </tr>`;
    }).join("") || `<tr><td colspan="6"><div class="empty">Nenhuma entrada no período.</div></td></tr>`;
}

/* ══════════════ CLIENTES ══════════════ */

document.getElementById("btn-novo-cliente").addEventListener("click", () => {
  pendingClienteId = null;
  document.getElementById("modal-cliente-titulo").textContent = "Novo cliente";
  ["mc-nome", "mc-telefone", "mc-email", "mc-cpfcnpj", "mc-endereco-busca", "mc-representante-nome", "mc-representante-cpf", "mc-origem", "mc-obs"].forEach((id) => (document.getElementById(id).value = ""));
  atualizarBlocoRepresentanteCliente();
  abrirModal("modal-cliente");
});
function editarCliente(id) {
  const c = STATE.clientes.find((x) => x.id === id);
  if (!c) return;
  pendingClienteId = id;
  document.getElementById("modal-cliente-titulo").textContent = `Editar cliente — ${c.nome}`;
  document.getElementById("mc-nome").value = c.nome || "";
  document.getElementById("mc-telefone").value = c.telefone || "";
  document.getElementById("mc-email").value = c.email || "";
  document.getElementById("mc-cpfcnpj").value = c.cpfCnpj || "";
  document.getElementById("mc-endereco-busca").value = c.endereco || "";
  document.getElementById("mc-representante-nome").value = c.representanteNome || "";
  document.getElementById("mc-representante-cpf").value = c.representanteCpf || "";
  atualizarBlocoRepresentanteCliente();
  document.getElementById("mc-origem").value = c.origem || "";
  document.getElementById("mc-obs").value = c.observacoes || "";
  abrirModal("modal-cliente");
}
// Abre o cadastro de cliente "por cima" de outro modal já aberto (o
// combobox de qualquer funil usa isso pra "+ Criar cliente"; o botão
// "Editar cliente" dentro do Agendamento/Vendas usa pra corrigir
// contato de um cliente já existente sem sair do que estava fazendo).
// Contato (telefone/e-mail) só é preenchido/editado aqui — em nenhum
// outro modal — por isso não pede nada além do nome pra criar.
function abrirClienteEmbutido(onSalvar, { clienteId, nomeInicial } = {}) {
  const modaisAtivos = [...document.querySelectorAll(".modal-overlay.active")].map((m) => m.id);
  modaisAtivos.forEach((id) => fecharModal(id));
  pendingClienteRetornoCallback = onSalvar;
  pendingClienteRetornoModais = modaisAtivos;
  if (clienteId) {
    editarCliente(clienteId);
  } else {
    pendingClienteId = null;
    document.getElementById("modal-cliente-titulo").textContent = "Novo cliente";
    ["mc-nome", "mc-telefone", "mc-email", "mc-cpfcnpj", "mc-endereco-busca", "mc-representante-nome", "mc-representante-cpf", "mc-origem", "mc-obs"].forEach((id) => (document.getElementById(id).value = ""));
  atualizarBlocoRepresentanteCliente();
    if (nomeInicial) document.getElementById("mc-nome").value = nomeInicial;
    abrirModal("modal-cliente");
  }
}
document.getElementById("btn-cancelar-cliente").addEventListener("click", () => {
  if (!pendingClienteRetornoModais.length && !pendingClienteRetornoCallback) return;
  const modais = pendingClienteRetornoModais;
  pendingClienteRetornoCallback = null;
  pendingClienteRetornoModais = [];
  modais.forEach((id) => abrirModal(id));
});
document.getElementById("btn-salvar-cliente").addEventListener("click", async () => {
  const nome = document.getElementById("mc-nome").value.trim();
  if (!nome) { mostrarErro("Informe o nome."); return; }
  const dados = {
    nome, telefone: document.getElementById("mc-telefone").value.trim(),
    email: document.getElementById("mc-email").value.trim(),
    cpfCnpj: document.getElementById("mc-cpfcnpj").value.trim(),
    endereco: document.getElementById("mc-endereco-busca").value.trim(),
    representanteNome: document.getElementById("mc-representante-nome").value.trim(),
    representanteCpf: document.getElementById("mc-representante-cpf").value.trim(),
    origem: document.getElementById("mc-origem").value.trim(),
    observacoes: document.getElementById("mc-obs").value.trim()
  };
  try {
    let clienteId = pendingClienteId;
    if (clienteId) await updateDoc(doc(db, "clientes", clienteId), dados);
    else clienteId = (await addDoc(collection(db, "clientes"), { ...dados, createdAt: serverTimestamp() })).id;
    fecharModal("modal-cliente");
    pendingClienteId = null;
    mostrarToast("Cliente salvo.");
    if (pendingClienteRetornoCallback || pendingClienteRetornoModais.length) {
      const cb = pendingClienteRetornoCallback, modais = pendingClienteRetornoModais;
      pendingClienteRetornoCallback = null;
      pendingClienteRetornoModais = [];
      modais.forEach((id) => abrirModal(id));
      if (cb) cb({ id: clienteId, ...dados });
    }
  } catch (err) { mostrarErro(err.message); }
});

async function excluirCliente(id) {
  if (!(await confirmarAcao("Excluir este cliente? (Os registros já vinculados a ele nos funis não são apagados.)"))) return;
  try { await deleteDoc(doc(db, "clientes", id)); } catch (err) { mostrarErro(err.message); }
}

// "aoFechar" (opcional) — quando a ficha do cliente é aberta "por cima" de
// outro detalhe (parcela/contrato/card do funil, via o campo "Cliente"
// clicável), reabre esse detalhe de origem quando a ficha é fechada por
// qualquer caminho, simulando um "voltar" no mesmo modal reaproveitado.
function abrirDetalheCliente(id, aoFechar) {
  const c = STATE.clientes.find((x) => x.id === id);
  if (!c) return;
  pendingDetalheAoFechar = aoFechar || null;
  abrirDetalhe({
    titulo: c.nome,
    campos: [
      ["Telefone", esc(c.telefone || "—")],
      ["E-mail", esc(c.email || "—")],
      ["CPF/CNPJ", esc(c.cpfCnpj || "—")],
      ["Endereço", esc(c.endereco || "—")],
      ...(apenasDigitos(c.cpfCnpj).length > 11 ? [
        ["Representante legal", esc(c.representanteNome || "—")],
        ["CPF do representante", esc(c.representanteCpf || "—")]
      ] : []),
      ["Origem", esc(c.origem || "—")],
      ["Observações", esc(c.observacoes || "—")]
    ],
    onEditar: () => editarCliente(id),
    onExcluir: () => excluirCliente(id)
  });
}

document.getElementById("cli-busca").addEventListener("input", (e) => {
  STATE.buscaClientes = e.target.value || "";
  renderTabelaClientes();
});

function renderTabelaClientes() {
  const termoBusca = STATE.buscaClientes.trim().toLowerCase();
  const clientesVisiveis = !termoBusca ? STATE.clientes : STATE.clientes.filter((c) => {
    const alvo = [c.nome, c.telefone, c.email, c.origem].join(" ").toLowerCase();
    return alvo.includes(termoBusca);
  });

  const idsComContratoAtivo = new Set(
    STATE.contratos.filter((c) => statusContrato(c) === "ativo" && c.clienteId).map((c) => c.clienteId)
  );
  const clientesComContratoAtivo = clientesVisiveis.filter((c) => idsComContratoAtivo.has(c.id));
  const clientesSemContrato = clientesVisiveis.filter((c) => !idsComContratoAtivo.has(c.id));
  const comContratoAtivo = clientesComContratoAtivo.length;

  const linhaListaCliente = (c) => [esc(c.nome), esc(c.telefone || "—"), esc(c.email || "—"), esc(c.origem || "—")];
  CACHE_LISTA_KPI.clientesTotal = { titulo: "Total de clientes", subtitulo: `${clientesVisiveis.length} cliente(s)`, colunas: ["Nome", "Telefone", "E-mail", "Origem"], linhas: clientesVisiveis.map(linhaListaCliente) };
  CACHE_LISTA_KPI.clientesComContrato = { titulo: "Com contrato ativo", subtitulo: `${comContratoAtivo} cliente(s)`, colunas: ["Nome", "Telefone", "E-mail", "Origem"], linhas: clientesComContratoAtivo.map(linhaListaCliente) };
  CACHE_LISTA_KPI.clientesSemContrato = { titulo: "Sem contrato", subtitulo: `${clientesSemContrato.length} cliente(s)`, colunas: ["Nome", "Telefone", "E-mail", "Origem"], linhas: clientesSemContrato.map(linhaListaCliente) };

  document.getElementById("clientes-kpis").innerHTML = `
    <div class="kpi-card"><div class="label">Total de clientes</div><div class="value clicavel" onclick="window.__jm.abrirListaKpi('clientesTotal')">${clientesVisiveis.length}</div><div class="sub">cadastrados${termoBusca ? " (com essa busca)" : ""}</div></div>
    <div class="kpi-card positive"><div class="label">Com contrato ativo</div><div class="value clicavel" onclick="window.__jm.abrirListaKpi('clientesComContrato')">${comContratoAtivo}</div><div class="sub">já viraram contrato</div></div>
    <div class="kpi-card"><div class="label">Sem contrato</div><div class="value clicavel" onclick="window.__jm.abrirListaKpi('clientesSemContrato')">${clientesSemContrato.length}</div><div class="sub">ainda não converteram</div></div>
  `;

  document.getElementById("tabela-clientes").innerHTML = clientesVisiveis.map((c) => `<tr class="linha-clicavel" onclick="window.__jm.abrirDetalheCliente('${c.id}')">
    <td>${esc(c.nome)}</td><td>${esc(c.telefone || "—")}</td><td>${esc(c.email || "—")}</td><td>${esc(c.origem || "—")}</td>
  </tr>`).join("") || `<tr><td colspan="4"><div class="empty">${termoBusca ? "Nenhum cliente encontrado pra essa busca." : "Nenhum cliente cadastrado."}</div></td></tr>`;
}

/* ══════════════ CONFIGURAÇÕES — ETAPAS DOS FUNIS ══════════════ */
// Os 3 funis seguem o mesmo padrão de configuração: nome, ordem, e um SLA
// (verde/amarelo/vermelho) contado em horas ou dias a partir do momento em
// que o card entrou na etapa. Cada modal tem os campos extras específicos
// do seu funil (entraFunilVendas/perda em Agendamento, fechamento/perda em
// Vendas). Os 3 suportam criar E editar — abrir o modal com um id pendente
// faz o botão "Salvar" atualizar em vez de criar.

function lerCamposSla(prefixo) {
  return {
    slaUnidade: document.getElementById(`${prefixo}-sla-unidade`).value,
    slaAmarelo: parseFloat(document.getElementById(`${prefixo}-sla-amarelo`).value) || 0,
    slaVermelho: parseFloat(document.getElementById(`${prefixo}-sla-vermelho`).value) || 0
  };
}
function preencherCamposSla(prefixo, etapa) {
  document.getElementById(`${prefixo}-sla-unidade`).value = (etapa && etapa.slaUnidade) || "dias";
  document.getElementById(`${prefixo}-sla-amarelo`).value = etapa && etapa.slaAmarelo != null ? etapa.slaAmarelo : 1;
  document.getElementById(`${prefixo}-sla-vermelho`).value = etapa && etapa.slaVermelho != null ? etapa.slaVermelho : 3;
}

// ── Agendamento ──
document.getElementById("btn-nova-etapa-agendamento").addEventListener("click", () => {
  pendingEtapaAgendamentoId = null;
  document.getElementById("modal-etapa-agendamento-titulo").textContent = "Etapa do Funil de Agendamento";
  document.getElementById("mea2-nome").value = "";
  document.getElementById("mea2-ordem").value = STATE.etapasAgendamento.length + 1;
  document.getElementById("mea2-entra-vendas").checked = false;
  document.getElementById("mea2-exige-contato").checked = false;
  document.getElementById("mea2-exige-qualificacao").checked = false;
  document.getElementById("mea2-perda").checked = false;
  preencherCamposSla("mea2", null);
  abrirModal("modal-etapa-agendamento");
});
function editarEtapaAgendamento(id) {
  const e = STATE.etapasAgendamento.find((x) => x.id === id);
  if (!e) return;
  pendingEtapaAgendamentoId = id;
  document.getElementById("modal-etapa-agendamento-titulo").textContent = `Editar etapa — ${e.nome}`;
  document.getElementById("mea2-nome").value = e.nome;
  document.getElementById("mea2-ordem").value = e.ordem;
  document.getElementById("mea2-entra-vendas").checked = !!e.entraFunilVendas;
  document.getElementById("mea2-exige-contato").checked = !!e.exigeContato;
  document.getElementById("mea2-exige-qualificacao").checked = !!e.exigeQualificacao;
  document.getElementById("mea2-perda").checked = !!e.perda;
  preencherCamposSla("mea2", e);
  abrirModal("modal-etapa-agendamento");
}
document.getElementById("btn-salvar-etapa-agendamento").addEventListener("click", async () => {
  const nome = document.getElementById("mea2-nome").value.trim();
  if (!nome) { mostrarErro("Informe o nome da etapa."); return; }
  const dados = {
    nome, ordem: parseInt(document.getElementById("mea2-ordem").value, 10) || (STATE.etapasAgendamento.length + 1),
    entraFunilVendas: document.getElementById("mea2-entra-vendas").checked,
    exigeContato: document.getElementById("mea2-exige-contato").checked,
    exigeQualificacao: document.getElementById("mea2-exige-qualificacao").checked,
    perda: document.getElementById("mea2-perda").checked,
    ...lerCamposSla("mea2")
  };
  try {
    if (pendingEtapaAgendamentoId) await updateDoc(doc(db, "etapasAgendamentoConfig", pendingEtapaAgendamentoId), dados);
    else await addDoc(collection(db, "etapasAgendamentoConfig"), dados);
    fecharModal("modal-etapa-agendamento");
    pendingEtapaAgendamentoId = null;
  } catch (err) { mostrarErro(err.message); }
});
async function excluirEtapaAgendamento(id) {
  if (!(await confirmarAcao("Excluir esta etapa? Agendamentos nela ficarão sem coluna visível até serem movidos."))) return;
  try { await deleteDoc(doc(db, "etapasAgendamentoConfig", id)); } catch (err) { mostrarErro(err.message); }
}

// ── Vendas ──
document.getElementById("btn-nova-etapa-venda").addEventListener("click", () => {
  pendingEtapaVendaId = null;
  document.getElementById("modal-etapa-venda-titulo").textContent = "Etapa do Funil de Vendas";
  document.getElementById("mev-nome").value = "";
  document.getElementById("mev-ordem").value = STATE.etapasVenda.length + 1;
  document.getElementById("mev-fechamento").checked = false;
  document.getElementById("mev-perda").checked = false;
  preencherCamposSla("mev", null);
  abrirModal("modal-etapa-venda");
});
function editarEtapaVenda(id) {
  const e = STATE.etapasVenda.find((x) => x.id === id);
  if (!e) return;
  pendingEtapaVendaId = id;
  document.getElementById("modal-etapa-venda-titulo").textContent = `Editar etapa — ${e.nome}`;
  document.getElementById("mev-nome").value = e.nome;
  document.getElementById("mev-ordem").value = e.ordem;
  document.getElementById("mev-fechamento").checked = !!e.fechamento;
  document.getElementById("mev-perda").checked = !!e.perda;
  preencherCamposSla("mev", e);
  abrirModal("modal-etapa-venda");
}
document.getElementById("btn-salvar-etapa-venda").addEventListener("click", async () => {
  const nome = document.getElementById("mev-nome").value.trim();
  if (!nome) { mostrarErro("Informe o nome da etapa."); return; }
  const dados = {
    nome, ordem: parseInt(document.getElementById("mev-ordem").value, 10) || (STATE.etapasVenda.length + 1),
    fechamento: document.getElementById("mev-fechamento").checked,
    perda: document.getElementById("mev-perda").checked,
    ...lerCamposSla("mev")
  };
  try {
    if (pendingEtapaVendaId) await updateDoc(doc(db, "etapasVendaConfig", pendingEtapaVendaId), dados);
    else await addDoc(collection(db, "etapasVendaConfig"), dados);
    fecharModal("modal-etapa-venda");
    pendingEtapaVendaId = null;
  } catch (err) { mostrarErro(err.message); }
});
async function excluirEtapaVenda(id) {
  if (!(await confirmarAcao("Excluir esta etapa? Oportunidades nela ficarão sem coluna visível até serem movidas."))) return;
  try { await deleteDoc(doc(db, "etapasVendaConfig", id)); } catch (err) { mostrarErro(err.message); }
}

// ── Administrativo ──
document.getElementById("btn-nova-etapa-admin").addEventListener("click", () => {
  pendingEtapaAdminId = null;
  document.getElementById("modal-etapa-admin-titulo").textContent = "Etapa do Funil Administrativo";
  document.getElementById("mea-nome").value = "";
  document.getElementById("mea-ordem").value = STATE.etapasAdmin.length + 1;
  preencherCamposSla("mea", null);
  abrirModal("modal-etapa-admin");
});
function editarEtapaAdmin(id) {
  const e = STATE.etapasAdmin.find((x) => x.id === id);
  if (!e) return;
  pendingEtapaAdminId = id;
  document.getElementById("modal-etapa-admin-titulo").textContent = `Editar etapa — ${e.nome}`;
  document.getElementById("mea-nome").value = e.nome;
  document.getElementById("mea-ordem").value = e.ordem;
  preencherCamposSla("mea", e);
  abrirModal("modal-etapa-admin");
}
document.getElementById("btn-salvar-etapa-admin").addEventListener("click", async () => {
  const nome = document.getElementById("mea-nome").value.trim();
  if (!nome) { mostrarErro("Informe o nome da etapa."); return; }
  const dados = {
    nome, ordem: parseInt(document.getElementById("mea-ordem").value, 10) || (STATE.etapasAdmin.length + 1),
    ...lerCamposSla("mea")
  };
  try {
    if (pendingEtapaAdminId) await updateDoc(doc(db, "etapasAdminConfig", pendingEtapaAdminId), dados);
    else await addDoc(collection(db, "etapasAdminConfig"), dados);
    fecharModal("modal-etapa-admin");
    pendingEtapaAdminId = null;
  } catch (err) { mostrarErro(err.message); }
});
async function excluirEtapaAdmin(id) {
  if (!(await confirmarAcao("Excluir esta etapa? Cards nela ficarão sem coluna visível até serem movidos."))) return;
  try { await deleteDoc(doc(db, "etapasAdminConfig", id)); } catch (err) { mostrarErro(err.message); }
}

function fmtSla(e) {
  const unidade = e.slaUnidade === "horas" ? "h" : "d";
  if (!e.slaAmarelo && !e.slaVermelho) return "—";
  return `<span class="dot dot-amarelo"></span> ${e.slaAmarelo || 0}${unidade} · <span class="dot dot-vermelho"></span> ${e.slaVermelho || 0}${unidade}`;
}

function renderConfigEtapasAgendamento() {
  document.getElementById("tabela-etapas-agendamento").innerHTML = [...STATE.etapasAgendamento].sort((a, b) => a.ordem - b.ordem).map((e) => `<tr class="linha-clicavel" onclick="window.__jm.abrirDetalheEtapaAgendamento('${e.id}')">
    <td>${e.ordem}</td><td>${esc(e.nome)}</td><td>${e.entraFunilVendas ? "Sim" : "—"}</td><td>${e.exigeContato ? "Sim" : "—"}</td><td>${e.exigeQualificacao ? "Sim" : "—"}</td><td>${e.perda ? "Sim" : "—"}</td><td>${fmtSla(e)}</td>
  </tr>`).join("") || `<tr><td colspan="7"><div class="empty">Nenhuma etapa cadastrada.</div></td></tr>`;
}
function renderConfigEtapasVenda() {
  document.getElementById("tabela-etapas-venda").innerHTML = [...STATE.etapasVenda].sort((a, b) => a.ordem - b.ordem).map((e) => `<tr class="linha-clicavel" onclick="window.__jm.abrirDetalheEtapaVenda('${e.id}')">
    <td>${e.ordem}</td><td>${esc(e.nome)}</td><td>${e.fechamento ? "Sim" : "—"}</td><td>${e.perda ? "Sim" : "—"}</td><td>${fmtSla(e)}</td>
  </tr>`).join("") || `<tr><td colspan="5"><div class="empty">Nenhuma etapa cadastrada.</div></td></tr>`;
}
function renderConfigEtapasAdmin() {
  document.getElementById("tabela-etapas-admin").innerHTML = [...STATE.etapasAdmin].sort((a, b) => a.ordem - b.ordem).map((e) => `<tr class="linha-clicavel" onclick="window.__jm.abrirDetalheEtapaAdmin('${e.id}')">
    <td>${e.ordem}</td><td>${esc(e.nome)}</td><td>${fmtSla(e)}</td>
  </tr>`).join("") || `<tr><td colspan="3"><div class="empty">Nenhuma etapa cadastrada.</div></td></tr>`;
}

function abrirDetalheEtapaAgendamento(id) {
  const e = STATE.etapasAgendamento.find((x) => x.id === id);
  if (!e) return;
  abrirDetalhe({
    titulo: e.nome,
    campos: [
      ["Ordem", String(e.ordem)],
      ["Entra automaticamente em Vendas?", e.entraFunilVendas ? "Sim" : "Não"],
      ["Exige contato (telefone/e-mail/origem/data)?", e.exigeContato ? "Sim" : "Não"],
      ["Exige dados de qualificação?", e.exigeQualificacao ? "Sim" : "Não"],
      ["É a etapa de perda?", e.perda ? "Sim" : "Não"],
      ["SLA", fmtSla(e)]
    ],
    onEditar: () => editarEtapaAgendamento(id),
    onExcluir: () => excluirEtapaAgendamento(id)
  });
}
function abrirDetalheEtapaVenda(id) {
  const e = STATE.etapasVenda.find((x) => x.id === id);
  if (!e) return;
  abrirDetalhe({
    titulo: e.nome,
    campos: [
      ["Ordem", String(e.ordem)],
      ["Etapa de fechamento?", e.fechamento ? "Sim" : "Não"],
      ["É a etapa de perda?", e.perda ? "Sim" : "Não"],
      ["SLA", fmtSla(e)]
    ],
    onEditar: () => editarEtapaVenda(id),
    onExcluir: () => excluirEtapaVenda(id)
  });
}
function abrirDetalheEtapaAdmin(id) {
  const e = STATE.etapasAdmin.find((x) => x.id === id);
  if (!e) return;
  abrirDetalhe({
    titulo: e.nome,
    campos: [
      ["Ordem", String(e.ordem)],
      ["SLA", fmtSla(e)]
    ],
    onEditar: () => editarEtapaAdmin(id),
    onExcluir: () => excluirEtapaAdmin(id)
  });
}

/* ══════════════ CONFIGURAÇÕES — CALENDÁRIO DO GOOGLE AGENDA ══════════════ */

async function carregarListaCalendarios() {
  const select = document.getElementById("cfg-calendario-select");
  select.innerHTML = `<option value="">Carregando...</option>`;
  try {
    const resp = await chamarAppsScript("listarCalendarios", {});
    const calendarios = resp.calendarios || [];
    const atual = STATE.config.calendarioAgendaId || "";
    select.innerHTML = calendarios.map((c) => (
      `<option value="${esc(c.id)}" ${c.id === atual ? "selected" : ""}>${esc(c.nome)}</option>`
    )).join("") || `<option value="">Nenhum calendário encontrado</option>`;
  } catch (err) {
    select.innerHTML = `<option value="">Erro ao carregar</option>`;
    mostrarErro("Não foi possível listar os calendários: " + err.message);
  }
}
document.getElementById("btn-recarregar-calendarios").addEventListener("click", carregarListaCalendarios);

document.getElementById("btn-salvar-calendario").addEventListener("click", async () => {
  const select = document.getElementById("cfg-calendario-select");
  const calendarioAgendaId = select.value || null;
  const nomeEscolhido = select.options[select.selectedIndex] ? select.options[select.selectedIndex].textContent : "";
  try {
    await setDoc(doc(db, "config", "geral"), { calendarioAgendaId, calendarioAgendaNome: nomeEscolhido }, { merge: true });
    mostrarToast("Calendário salvo. A próxima sincronização já usa esse calendário.");
  } catch (err) { mostrarErro(err.message); }
});

function renderConfigCalendario() {
  document.getElementById("cfg-calendario-atual").textContent = STATE.config.calendarioAgendaId
    ? `Calendário atual: ${STATE.config.calendarioAgendaNome || STATE.config.calendarioAgendaId}`
    : "Nenhum calendário salvo ainda — sincronizando com o principal da conta que implantou o Code.gs.";
}

/* ══════════════ LISTENERS EM TEMPO REAL ══════════════ */

// Defaults ajustáveis em Configurações a qualquer momento — servem só de
// ponto de partida. SLA padrão de 1 dia (amarelo) / 3 dias (vermelho) pra
// todas, exceto onde comentado.
// Funil comum: transita livremente entre todas as etapas (arrastar), sem
// nenhuma trava. A ÚNICA automação é "entraFunilVendas" — só a etapa
// "Agendado" tem essa flag, então só ela dispara o evento na Google
// Agenda (e a conversão em oportunidade). "Reagendar" e as demais são só
// etapas normais de acompanhamento, sem nenhum efeito automático.
const DEFAULT_ETAPAS_AGENDAMENTO = [
  { nome: "Novo Lead", ordem: 1, entraFunilVendas: false, exigeContato: false, exigeQualificacao: false, perda: false, slaUnidade: "dias", slaAmarelo: 1, slaVermelho: 2 },
  { nome: "Tentativa de Contato", ordem: 2, entraFunilVendas: false, exigeContato: false, exigeQualificacao: false, perda: false, slaUnidade: "dias", slaAmarelo: 1, slaVermelho: 3 },
  { nome: "Retomar Contato", ordem: 3, entraFunilVendas: false, exigeContato: false, exigeQualificacao: false, perda: false, slaUnidade: "dias", slaAmarelo: 1, slaVermelho: 3 },
  { nome: "Qualificação", ordem: 4, entraFunilVendas: false, exigeContato: false, exigeQualificacao: true, perda: false, slaUnidade: "dias", slaAmarelo: 1, slaVermelho: 3 },
  { nome: "Agendado", ordem: 5, entraFunilVendas: true, exigeContato: true, exigeQualificacao: true, perda: false, slaUnidade: "dias", slaAmarelo: 1, slaVermelho: 3 },
  { nome: "Reagendar", ordem: 6, entraFunilVendas: false, exigeContato: true, exigeQualificacao: true, perda: false, slaUnidade: "dias", slaAmarelo: 1, slaVermelho: 3 },
  { nome: "Perdido", ordem: 7, entraFunilVendas: false, exigeContato: false, exigeQualificacao: false, perda: true, slaUnidade: "dias", slaAmarelo: 0, slaVermelho: 0 }
];
const DEFAULT_ETAPAS_VENDA = [
  { nome: "Reunião Agendada", ordem: 1, fechamento: false, perda: false, slaUnidade: "dias", slaAmarelo: 1, slaVermelho: 3 },
  { nome: "Follow Up", ordem: 2, fechamento: false, perda: false, slaUnidade: "dias", slaAmarelo: 1, slaVermelho: 3 },
  { nome: "Negociação", ordem: 3, fechamento: false, perda: false, slaUnidade: "dias", slaAmarelo: 2, slaVermelho: 5 },
  { nome: "Fechado", ordem: 4, fechamento: true, perda: false, slaUnidade: "dias", slaAmarelo: 0, slaVermelho: 0 },
  { nome: "Perdido", ordem: 5, fechamento: false, perda: true, slaUnidade: "dias", slaAmarelo: 0, slaVermelho: 0 }
];
const DEFAULT_ETAPAS_ADMIN = [
  { nome: "Recebimento da Entrada", ordem: 1, slaUnidade: "dias", slaAmarelo: 2, slaVermelho: 5 },
  { nome: "Criação do Grupo", ordem: 2, slaUnidade: "dias", slaAmarelo: 1, slaVermelho: 2 },
  { nome: "Envio do Contrato", ordem: 3, slaUnidade: "dias", slaAmarelo: 1, slaVermelho: 2 },
  { nome: "Enviado para Mentoria", ordem: 4, slaUnidade: "dias", slaAmarelo: 3, slaVermelho: 7 }
];

// Cria as etapas padrão de uma coleção SÓ se ela estiver mesmo vazia no
// servidor — usa getDocsFromServer (nunca cache) porque essa checagem
// rodava antes dentro do onSnapshot, olhando pro 1º snapshot entregue, e
// em pelo menos duas vezes esse 1º snapshot chegou vazio antes do
// snapshot "de verdade" (uma característica observada do SDK, não um bug
// deste código) — cada vez que isso acontecia, semeava um conjunto NOVO
// de etapas, duplicando tudo. Rodar isso separado, uma única vez, ANTES
// de qualquer listener existir, elimina essa corrida inteira.
async function seedEtapasSeVazio_(colecao, defaults) {
  const snap = await getDocsFromServer(query(collection(db, colecao), orderBy("ordem")));
  if (snap.empty) {
    for (const e of defaults) await addDoc(collection(db, colecao), e);
  }
}

/* ══════════════ INDICADOR DE SINCRONIZAÇÃO (bolinha verde/amarelo) ══════════════
   Nasceu de um risco real: com escrita otimista, a tela renderiza igual
   sincronizado ou não — sem esse indicador, ninguém percebe se os dados
   realmente chegaram no Firestore (ex: config apontando pro projeto errado)
   até ser tarde demais. Verde = tudo confirmado pelo servidor; amarelo = há
   documento com escrita pendente (hasPendingWrites) — passa o mouse ou
   clica pra ver exatamente o quê. Só a bolinha, sem texto/pill ao lado
   (regra de UI: não pode competir com o conteúdo real da tela). */
const syncPendentes = {};

function resumoRegistro_(d) {
  return d.nome || d.clienteNome || d.descricao || "registro";
}

function atualizarBadgeSincronizacao() {
  const pendentesLista = [];
  Object.keys(syncPendentes).forEach((colecao) => {
    Object.values(syncPendentes[colecao]).forEach((resumo) => pendentesLista.push({ colecao, resumo }));
  });
  const bolinha = document.getElementById("sync-bolinha");
  if (!bolinha) return;
  bolinha.classList.toggle("sync-amarelo", pendentesLista.length > 0);
  bolinha.title = pendentesLista.length
    ? `${pendentesLista.length} pendente(s) de confirmar no servidor`
    : "Tudo sincronizado";
  document.getElementById("sync-painel-lista").innerHTML = pendentesLista.length
    ? pendentesLista.map((p) => `<div class="sync-item">${esc(p.colecao)} — ${esc(p.resumo)}</div>`).join("")
    : `<div class="sync-item">Tudo sincronizado.</div>`;
}

// Atualiza o mapa de pendências de UMA coleção (a partir do snapshot de
// uma query) e recalcula o indicador geral. Precisa que o onSnapshot
// correspondente tenha sido chamado com {includeMetadataChanges:true} —
// sem isso o listener só dispara quando o DADO muda, nunca quando ele
// deixa de estar pendente.
function rastrearSincronizacao(colecaoNome, snap) {
  const pendentes = {};
  snap.docs.forEach((d) => {
    if (d.metadata.hasPendingWrites) pendentes[d.id] = resumoRegistro_(d.data());
  });
  syncPendentes[colecaoNome] = pendentes;
  atualizarBadgeSincronizacao();
}

document.getElementById("sync-bolinha").addEventListener("click", () => {
  document.getElementById("sync-painel").classList.toggle("active");
});
document.addEventListener("click", (e) => {
  const painel = document.getElementById("sync-painel");
  if (!painel.contains(e.target) && e.target !== document.getElementById("sync-bolinha")) painel.classList.remove("active");
});

async function iniciarListeners() {
  // O seed das etapas padrão é escrita em coleção de configuração, que só a
  // gestão pode fazer. Numa base já em uso ele não escreve nada de qualquer
  // jeito (checa se está vazia antes), mas deixar uma SDR tentar seria pedir
  // erro de permissão à toa no primeiro carregamento dela.
  //
  // O try/catch não é decoração. Sem ele, um erro aqui derruba a função
  // inteira e NENHUM listener chega a ser registrado: a tela abre vazia, sem
  // erro visível, só um "uncaught" no console. Aconteceu de verdade em
  // 2026-09-02, no primeiro teste depois de ligar o Auth. O seed é um
  // conforto de primeira execução, nunca pré-requisito pra ler dado.
  if (podeVer("config")) {
    try {
      await Promise.all([
        seedEtapasSeVazio_("etapasAgendamentoConfig", DEFAULT_ETAPAS_AGENDAMENTO),
        seedEtapasSeVazio_("etapasVendaConfig", DEFAULT_ETAPAS_VENDA),
        seedEtapasSeVazio_("etapasAdminConfig", DEFAULT_ETAPAS_ADMIN)
      ]);
    } catch (err) {
      console.warn("[etapas] seed padrão não rodou:", err.message);
    }
  }

  onSnapshot(doc(db, "config", "geral"), { includeMetadataChanges: true }, (snap) => {
    STATE.config = snap.exists() ? snap.data() : {};
    renderConfigCalendario();
    syncPendentes.config = snap.metadata.hasPendingWrites ? { geral: "Configurações" } : {};
    atualizarBadgeSincronizacao();
  }, (err) => mostrarErro("Erro de conexão (config): " + err.message));

  onSnapshot(query(collection(db, "clientes"), orderBy("createdAt", "desc")), { includeMetadataChanges: true }, (snap) => {
    STATE.clientes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderTabelaClientes();
    rastrearSincronizacao("clientes", snap);
  }, (err) => mostrarErro("Erro de conexão (clientes): " + err.message));

  onSnapshot(query(collection(db, "etapasAgendamentoConfig"), orderBy("ordem")), { includeMetadataChanges: true }, (snap) => {
    STATE.etapasAgendamento = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderKanbanAgendamento();
    renderConfigEtapasAgendamento();
    rastrearSincronizacao("etapasAgendamentoConfig", snap);
  }, (err) => mostrarErro("Erro de conexão (etapas de agendamento): " + err.message));

  onSnapshot(query(collection(db, "agendamentos"), orderBy("createdAt", "desc")), { includeMetadataChanges: true }, (snap) => {
    STATE.agendamentos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderKanbanAgendamento();
    rastrearSincronizacao("agendamentos", snap);
  }, (err) => mostrarErro("Erro de conexão (agendamentos): " + err.message));

  onSnapshot(query(collection(db, "etapasVendaConfig"), orderBy("ordem")), { includeMetadataChanges: true }, (snap) => {
    STATE.etapasVenda = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderKanbanVendas();
    renderConfigEtapasVenda();
    rastrearSincronizacao("etapasVendaConfig", snap);
  }, (err) => mostrarErro("Erro de conexão (etapas de venda): " + err.message));

  onSnapshot(query(collection(db, "oportunidades"), orderBy("createdAt", "desc")), { includeMetadataChanges: true }, (snap) => {
    STATE.oportunidades = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderKanbanVendas();
    rastrearSincronizacao("oportunidades", snap);
  }, (err) => mostrarErro("Erro de conexão (oportunidades): " + err.message));

  onSnapshot(query(collection(db, "contratos"), orderBy("dataGeracao", "desc")), { includeMetadataChanges: true }, (snap) => {
    STATE.contratos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderTabelaContratos();
    renderTabelaClientes();
    renderFinanceiro();
    rastrearSincronizacao("contratos", snap);
  }, (err) => mostrarErro("Erro de conexão (contratos): " + err.message));

  onSnapshot(query(collection(db, "parcelas"), orderBy("vencimento")), { includeMetadataChanges: true }, (snap) => {
    STATE.parcelas = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderTabelaContratos();
    renderFinanceiro();
    rastrearSincronizacao("parcelas", snap);
  }, (err) => mostrarErro("Erro de conexão (parcelas): " + err.message));

  // Despesas e entradas são o que a SDR não pode ver. As regras já barram do
  // lado do servidor; não abrir a escuta aqui evita o erro de permissão em
  // loop e economiza leitura de quota pra quem não usa esses dados.
  if (podeVer("despesas")) {
    onSnapshot(query(collection(db, "despesas"), orderBy("createdAt", "desc")), { includeMetadataChanges: true }, (snap) => {
      STATE.despesas = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderTabelaDespesas();
      renderFinanceiro();
      lancarRecorrentesPendentes();
      rastrearSincronizacao("despesas", snap);
    }, (err) => mostrarErro("Erro de conexão (despesas): " + err.message));
  }

  if (podeVer("entradas")) {
    onSnapshot(query(collection(db, "entradas"), orderBy("createdAt", "desc")), { includeMetadataChanges: true }, (snap) => {
      STATE.entradas = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderTabelaEntradas();
      renderFinanceiro();
      rastrearSincronizacao("entradas", snap);
    }, (err) => mostrarErro("Erro de conexão (entradas): " + err.message));
  }

  onSnapshot(query(collection(db, "etapasAdminConfig"), orderBy("ordem")), { includeMetadataChanges: true }, (snap) => {
    STATE.etapasAdmin = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderKanbanAdministrativo();
    renderConfigEtapasAdmin();
    rastrearSincronizacao("etapasAdminConfig", snap);
  }, (err) => mostrarErro("Erro de conexão (etapas administrativas): " + err.message));

  onSnapshot(query(collection(db, "cardsAdmin"), orderBy("createdAt", "desc")), { includeMetadataChanges: true }, (snap) => {
    STATE.cardsAdmin = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderKanbanAdministrativo();
    rastrearSincronizacao("cardsAdmin", snap);
  }, (err) => mostrarErro("Erro de conexão (funil administrativo): " + err.message));
}

// Funções chamadas a partir de HTML gerado por string (onclick inline) —
// só assim dá pra referenciá-las de dentro de innerHTML num ES module.
window.__jm = {
  abrirModalMarcarPago, desmarcarPago,
  abrirDetalheCliente, abrirDetalheDespesa, abrirDetalheContrato, abrirDetalheParcela, abrirDetalheEntrada,
  abrirDetalheEtapaAgendamento, abrirDetalheEtapaVenda, abrirDetalheEtapaAdmin,
  gerarPdfContratoExistente, enviarContratoParaAssinatura,
  abrirListaKpi, onCardClick, copiarTelefone,
  abrirDetalheUsuario, alternarSituacaoUsuario
};

/* ══════════════ CONTAS DE ACESSO (só admin) ══════════════ */

let pendingUsuarioId = null;

function iniciarListenerUsuarios() {
  assinarUsuarios(
    (lista) => { STATE.usuarios = lista; renderTabelaUsuarios(); },
    (err) => mostrarErro("Erro de conexão (contas de acesso): " + err.message)
  );
}

function renderTabelaUsuarios() {
  const lista = STATE.usuarios;
  const ativos = lista.filter((u) => u.ativo !== false);
  const aguardando = ativos.filter((u) => u.precisaTrocarSenha);

  document.getElementById("usuarios-kpis").innerHTML = `
    <div class="kpi-card positive"><div class="label">Contas ativas</div><div class="value">${ativos.length}</div><div class="sub">de ${lista.length} cadastradas</div></div>
    <div class="kpi-card"><div class="label">Aguardando 1º acesso</div><div class="value">${aguardando.length}</div><div class="sub">ainda com a senha temporária</div></div>
    <div class="kpi-card negative"><div class="label">Suspensas</div><div class="value">${lista.length - ativos.length}</div><div class="sub">não entram, histórico preservado</div></div>
  `;

  document.getElementById("tabela-usuarios").innerHTML = lista.map((u) => {
    const suspensa = u.ativo === false;
    const situacao = suspensa
      ? `<span class="stamp vencido">Suspensa</span>`
      : u.precisaTrocarSenha
        ? `<span class="stamp esperado">Aguardando 1º acesso</span>`
        : `<span class="stamp realizado">Ativa</span>`;
    const souEu = u.id === AUTH.user?.uid;
    return `<tr class="linha-clicavel" onclick="window.__jm.abrirDetalheUsuario('${u.id}')">
      <td>${esc(u.nome || "—")}${souEu ? ' <span class="sublabel">(você)</span>' : ""}</td>
      <td>${esc(u.email || "—")}</td>
      <td>${esc(u.telefone || "—")}</td>
      <td>${esc(PAPEIS[u.papel] || u.papel || "—")}</td>
      <td>${situacao}</td>
      <td>${souEu ? "" : `<button class="btn-small" onclick="event.stopPropagation();window.__jm.alternarSituacaoUsuario('${u.id}')">${suspensa ? "Reativar" : "Suspender"}</button>`}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="6"><div class="empty">Nenhuma conta cadastrada.</div></td></tr>`;
}

function abrirDetalheUsuario(uid) {
  const u = STATE.usuarios.find((x) => x.id === uid);
  if (!u) return;
  const souEu = uid === AUTH.user?.uid;
  abrirDetalhe({
    titulo: u.nome || u.email,
    campos: [
      ["E-mail", esc(u.email || "—")],
      ["Telefone", esc(u.telefone || "—")],
      ["Papel", esc(PAPEIS[u.papel] || u.papel || "—")],
      ["Situação", u.ativo === false ? "Suspensa" : "Ativa"],
      ["Primeiro acesso", u.precisaTrocarSenha ? "Ainda não trocou a senha temporária" : "Concluído"],
      ["Criada em", esc(fmtDataHora(u.createdAt))],
      ...(souEu ? [["Observação", "Esta é a sua própria conta: o papel e a situação dela não podem ser alterados aqui."]] : []),
    ],
    onEditar: () => editarUsuario(uid),
    // Excluir só remove o vínculo; a conta segue no Firebase Auth (apagar
    // conta de outra pessoa exigiria Admin SDK). Sem vínculo, ela loga e cai
    // em "acesso não liberado".
    onExcluir: souEu ? null : () => excluirUsuario(uid),
  });
}

function abrirModalUsuario() {
  pendingUsuarioId = null;
  document.getElementById("mu-form").classList.remove("hidden");
  document.getElementById("mu-sucesso").classList.add("hidden");
  document.getElementById("modal-usuario-titulo").textContent = "Nova conta de acesso";
  document.getElementById("mu-nome").value = "";
  document.getElementById("mu-email").value = "";
  document.getElementById("mu-email").disabled = false;
  document.getElementById("mu-telefone").value = "";
  document.getElementById("mu-papel").value = "sdr";
  document.getElementById("mu-papel").disabled = false;
  document.getElementById("mu-bloco-ativo").style.display = "none";
  document.getElementById("mu-aviso-senha").classList.remove("hidden");
  abrirModal("modal-usuario");
}
document.getElementById("btn-novo-usuario").addEventListener("click", abrirModalUsuario);

function editarUsuario(uid) {
  const u = STATE.usuarios.find((x) => x.id === uid);
  if (!u) return;
  const souEu = uid === AUTH.user?.uid;
  pendingUsuarioId = uid;
  document.getElementById("mu-form").classList.remove("hidden");
  document.getElementById("mu-sucesso").classList.add("hidden");
  document.getElementById("modal-usuario-titulo").textContent = `Editar — ${u.nome || u.email}`;
  document.getElementById("mu-nome").value = u.nome || "";
  document.getElementById("mu-email").value = u.email || "";
  document.getElementById("mu-email").disabled = true;
  document.getElementById("mu-telefone").value = u.telefone || "";
  document.getElementById("mu-papel").value = u.papel || "sdr";
  document.getElementById("mu-aviso-senha").classList.add("hidden");
  document.getElementById("mu-bloco-ativo").style.display = "";
  document.getElementById("mu-ativo").value = u.ativo === false ? "nao" : "sim";
  // Bloqueio por estado, não por papel: aqui vale a regra de desabilitar com
  // aviso em vez de esconder, pra ficar claro por que não dá.
  document.getElementById("mu-papel").disabled = souEu;
  document.getElementById("mu-ativo").disabled = souEu;
  document.getElementById("mu-papel").title = souEu ? "Você não pode mudar o próprio papel" : "";
  document.getElementById("mu-ativo").title = souEu ? "Você não pode suspender a própria conta" : "";
  abrirModal("modal-usuario");
}

document.getElementById("btn-salvar-usuario").addEventListener("click", async () => {
  const nome = document.getElementById("mu-nome").value.trim();
  const telefone = document.getElementById("mu-telefone").value.trim();
  const papel = document.getElementById("mu-papel").value;
  if (!nome) { mostrarErro("Informe o nome."); return; }

  const btn = document.getElementById("btn-salvar-usuario");
  btn.disabled = true;
  try {
    if (pendingUsuarioId) {
      await atualizarUsuario(pendingUsuarioId, {
        nome, telefone, papel, ativo: document.getElementById("mu-ativo").value !== "nao",
      });
      mostrarToast("Conta atualizada.");
      fecharModal("modal-usuario");
      pendingUsuarioId = null;
    } else {
      const email = document.getElementById("mu-email").value.trim();
      if (!email) { mostrarErro("Informe o e-mail."); return; }
      await criarUsuario({ nome, email, telefone, papel });
      // Mostra a senha de primeiro acesso em vez de fechar o modal: quem
      // cadastrou precisa repassar essa senha, e é aqui que ela aparece.
      document.getElementById("mu-sucesso-texto").textContent = `${nome} já pode entrar no sistema.`;
      document.getElementById("mu-sucesso-senha").textContent = SENHA_PRIMEIRO_ACESSO;
      document.getElementById("mu-form").classList.add("hidden");
      document.getElementById("mu-sucesso").classList.remove("hidden");
    }
  } catch (err) {
    mostrarErro(mensagemErroAuth(err));
  } finally {
    btn.disabled = false;
  }
});

async function alternarSituacaoUsuario(uid) {
  const u = STATE.usuarios.find((x) => x.id === uid);
  if (!u) return;
  const suspendendo = u.ativo !== false;
  const ok = await confirmarAcao(
    suspendendo
      ? `Suspender o acesso de ${u.nome}? Ela não consegue mais entrar, e o histórico dela fica.`
      : `Reativar o acesso de ${u.nome}?`,
    { textoConfirmar: suspendendo ? "Suspender" : "Reativar", destrutivo: suspendendo }
  );
  if (!ok) return;
  try {
    await atualizarUsuario(uid, { nome: u.nome, papel: u.papel, ativo: !suspendendo });
    mostrarToast(suspendendo ? "Acesso suspenso." : "Acesso reativado.");
  } catch (err) { mostrarErro(mensagemErroAuth(err)); }
}

async function excluirUsuario(uid) {
  const u = STATE.usuarios.find((x) => x.id === uid);
  if (!u) return;
  const ok = await confirmarAcao(
    `Excluir a conta de ${u.nome}? O login dela continua existindo no Firebase, mas sem acesso a nada aqui. Pra manter o histórico de quem era, prefira suspender.`
  );
  if (!ok) return;
  try {
    await removerVinculoUsuario(uid);
    mostrarToast("Conta removida.");
  } catch (err) { mostrarErro(mensagemErroAuth(err)); }
}

/* ══════════════ ACESSO (login, papéis e primeiro admin) ══════════════
   O app não abre nenhuma escuta antes de saber quem está logado e qual o
   papel. Isso não é só estética: com as regras novas, um listener de
   `despesas` aberto por uma SDR só produziria erro de permissão em loop. */

let listenersIniciados = false;
let listenerUsuariosIniciado = false;
let papelDosListeners = null;

function mostrarPassoAcesso(id) {
  document.querySelectorAll("#acesso-overlay .acesso-passo").forEach((p) => p.classList.add("hidden"));
  if (id) document.getElementById(id).classList.remove("hidden");
  document.getElementById("acesso-overlay").classList.toggle("hidden", !id);
}

function mostrarErroAcesso(id, texto) {
  const el = document.getElementById(id);
  el.textContent = texto;
  el.classList.toggle("hidden", !texto);
}

/**
 * Esconde do menu e das views tudo que o papel não alcança.
 *
 * A crença 16 pede botão desabilitado com aviso em vez de escondido, mas ela
 * fala de ação bloqueada por ESTADO (falta um dado pra concluir). Pra
 * permissão, o Felipe decidiu em 2026-09-02 esconder: a SDR não precisa
 * saber que existe um Painel Financeiro que ela não abre.
 */
function aplicarPermissoes() {
  document.querySelectorAll(".sidebar a[data-view]").forEach((a) => {
    a.classList.toggle("hidden", !podeVer(a.dataset.view));
  });
  document.getElementById("card-usuarios").classList.toggle("hidden", !podeVer("usuarios"));

  // Se a view ativa virou proibida (troca de papel com a sessão aberta),
  // manda pra primeira permitida em vez de deixar a tela em branco.
  const ativa = document.querySelector(".view.active");
  if (!ativa || !podeVer(ativa.id.replace("view-", ""))) {
    const primeiro = document.querySelector(".sidebar a[data-view]:not(.hidden)");
    if (primeiro) primeiro.click();
  }

  document.getElementById("sessao-nome").textContent = AUTH.usuario?.nome || "";
  document.getElementById("sessao-papel").textContent = PAPEIS[papelAtual()] || "";
}

iniciarAuth(async (estado) => {
  if (!estado.pronto) return;

  if (!estado.user) {
    mostrarPassoAcesso(await bootstrapNecessario() ? "acesso-primeiro-admin" : "acesso-login");
    return;
  }
  if (!estado.usuario) {
    mostrarPassoAcesso("acesso-sem-permissao");
    return;
  }
  if (estado.usuario.ativo === false) {
    document.getElementById("sem-permissao-msg").textContent =
      "Esta conta está suspensa. Fale com o administrador para reativar.";
    mostrarPassoAcesso("acesso-sem-permissao");
    return;
  }
  if (estado.usuario.precisaTrocarSenha) {
    mostrarPassoAcesso("acesso-trocar-senha");
    return;
  }

  // Papel trocado com a sessão aberta (o admin rebaixou alguém enquanto a
  // pessoa usava o sistema): as escutas já abertas passariam a bater em
  // regra que não permite mais, então recomeça do zero em vez de tentar
  // desmontar escuta por escuta.
  if (listenersIniciados && papelDosListeners !== papelAtual()) {
    location.reload();
    return;
  }

  aplicarPermissoes();
  mostrarPassoAcesso(null);
  if (isAdmin()) garantirBootstrapFechado();
  if (!listenersIniciados) {
    listenersIniciados = true;
    papelDosListeners = papelAtual();
    iniciarListeners();
  }
  if (podeVer("usuarios") && !listenerUsuariosIniciado) {
    listenerUsuariosIniciado = true;
    iniciarListenerUsuarios();
  }
});

document.getElementById("acesso-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("btn-entrar");
  btn.disabled = true;
  mostrarErroAcesso("login-erro", "");
  try {
    await login(document.getElementById("login-email").value, document.getElementById("login-senha").value);
    document.getElementById("login-senha").value = "";
  } catch (err) {
    mostrarErroAcesso("login-erro", mensagemErroAuth(err));
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("btn-esqueci-senha").addEventListener("click", async () => {
  const email = document.getElementById("login-email").value.trim();
  if (!email) { mostrarErroAcesso("login-erro", "Escreva seu e-mail no campo acima primeiro."); return; }
  try {
    await enviarResetSenha(email);
    mostrarErroAcesso("login-erro", "Enviamos um link de redefinição para " + email + ". Confira também o spam.");
  } catch (err) {
    mostrarErroAcesso("login-erro", mensagemErroAuth(err));
  }
});

document.getElementById("acesso-primeiro-admin").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("btn-criar-primeiro-admin");
  btn.disabled = true;
  mostrarErroAcesso("pa-erro", "");
  try {
    await criarPrimeiroAdmin({
      nome: document.getElementById("pa-nome").value.trim(),
      email: document.getElementById("pa-email").value,
      senha: document.getElementById("pa-senha").value,
    });
    // Recarrega em vez de seguir direto. A sessão já tinha começado no
    // instante em que a conta nasceu no Auth, ou seja, ANTES do vínculo
    // usuarios/{uid} existir no servidor — e as regras leem esse vínculo pra
    // liberar qualquer coleção. Escuta negada no Firestore não tenta de novo
    // sozinha, então a tela abriria vazia pra sempre. Isso acontece uma vez
    // na vida do sistema, e recarregar resolve de forma determinística.
    location.reload();
    return;
  } catch (err) {
    mostrarErroAcesso("pa-erro", mensagemErroAuth(err));
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("acesso-trocar-senha").addEventListener("submit", async (e) => {
  e.preventDefault();
  const senha = document.getElementById("ts-senha").value;
  const senha2 = document.getElementById("ts-senha2").value;
  if (senha !== senha2) { mostrarErroAcesso("ts-erro", "As duas senhas não são iguais."); return; }
  const btn = document.getElementById("btn-trocar-senha");
  btn.disabled = true;
  mostrarErroAcesso("ts-erro", "");
  try {
    await alterarMinhaSenha(senha);
  } catch (err) {
    mostrarErroAcesso("ts-erro", mensagemErroAuth(err));
  } finally {
    btn.disabled = false;
  }
});

// Sair recarrega a página de propósito: com listeners abertos, a sessão que
// some faz cada um deles começar a devolver erro de permissão. Recarregar é
// mais simples e mais confiável do que desmontar doze escutas na mão.
async function sairDoSistema() {
  await logout().catch(() => {});
  location.reload();
}
document.getElementById("btn-sair").addEventListener("click", sairDoSistema);
document.getElementById("btn-sair-troca").addEventListener("click", sairDoSistema);
document.getElementById("btn-sair-sem-permissao").addEventListener("click", sairDoSistema);

// As cores do badge de SLA (verde/amarelo/vermelho) dependem só do relógio
// — sem isso, um card ficaria "verde" pra sempre até a próxima escrita no
// Firestore. Reaplica o render dos 3 kanbans a cada minuto pra refletir o
// tempo passando, mesmo sem ninguém mexer em nada.
setInterval(() => {
  renderKanbanAgendamento();
  renderKanbanVendas();
  renderKanbanAdministrativo();
}, 60000);

/* ══════════════ BANNER DE INSTALAÇÃO DO PWA ══════════════
   O navegador não mostra sozinho nenhum prompt vistoso de instalação —
   capturamos o "beforeinstallprompt" e desenhamos nosso próprio banner, no
   visual do resto do app. iOS Safari nunca dispara esse evento (não existe
   API de instalação lá); a única forma é instrução manual (Compartilhar →
   Adicionar à Tela de Início), então detectamos a plataforma e trocamos o
   conteúdo do mesmo banner em vez de duplicar o componente. */
let pwaDeferredPrompt = null;

function pwaJaInstalado() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}
function pwaEhIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
}
function pwaFoiDispensadoRecentemente() {
  const ts = Number(localStorage.getItem("jm_pwa_dispensado_em") || 0);
  return ts && (Date.now() - ts) < 14 * 24 * 60 * 60 * 1000; // não insiste de novo por 14 dias
}
function mostrarBannerPwa() {
  if (pwaJaInstalado() || pwaFoiDispensadoRecentemente()) return;
  const banner = document.getElementById("pwa-banner");
  const btnInstalar = document.getElementById("pwa-banner-instalar");
  const sub = document.getElementById("pwa-banner-sub");
  if (pwaEhIOS()) {
    btnInstalar.style.display = "none";
    sub.textContent = 'Toque em Compartilhar e depois em "Adicionar à Tela de Início".';
  } else if (pwaDeferredPrompt) {
    btnInstalar.style.display = "";
    sub.textContent = "Acesso rápido, tela cheia, sem precisar abrir o navegador toda vez.";
  } else {
    return; // navegador não ofereceu instalação — sem instrução genérica, pra não confundir
  }
  banner.classList.add("active");
}
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  pwaDeferredPrompt = e;
  setTimeout(mostrarBannerPwa, 3000);
});
document.getElementById("pwa-banner-instalar").addEventListener("click", async () => {
  document.getElementById("pwa-banner").classList.remove("active");
  if (!pwaDeferredPrompt) return;
  pwaDeferredPrompt.prompt();
  await pwaDeferredPrompt.userChoice;
  pwaDeferredPrompt = null;
});
document.getElementById("pwa-banner-fechar").addEventListener("click", () => {
  document.getElementById("pwa-banner").classList.remove("active");
  localStorage.setItem("jm_pwa_dispensado_em", String(Date.now()));
});
// iOS não tem "beforeinstallprompt" pra escutar — mostra a instrução manual
// direto, com um atraso pra não competir com o carregamento inicial.
setTimeout(() => { if (pwaEhIOS()) mostrarBannerPwa(); }, 3000);
