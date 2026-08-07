// Jornada do Milhão — lógica do app. Firestore em tempo real (onSnapshot),
// sem Cloud Functions. Ver README.md para as decisões tomadas nas perguntas
// em aberto do plano original (plano_financeiro_funil.md).

import { db, APPS_SCRIPT_PROXY_URL } from "./firebase-init.js";
import {
  collection, addDoc, updateDoc, deleteDoc, doc, setDoc, getDocs,
  onSnapshot, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

const STATE = {
  clientes: [],
  agendamentos: [],
  etapasAgendamento: [],
  etapasVenda: [],
  oportunidades: [],
  contratos: [],
  parcelas: [],
  despesas: [],
  etapasAdmin: [],
  cardsAdmin: [],
  config: {},
  periodoFinanceiro: new Date().toISOString().slice(0, 7),
  periodoDespesasDe: primeiroDiaMes(),
  periodoDespesasAte: ultimoDiaMes()
};

let pendingContratoOportunidadeId = null;
let pendingContratoEtapaFechamentoId = null;
// Perda é genérica pros dois funis que têm etapa marcada como "perda"
// (Agendamento e Vendas) — guarda qual coleção/id está pendente.
let pendingPerda = null; // { colecao: "agendamentos"|"oportunidades", id }
let pendingEtapaAgendamentoId = null;
let pendingEtapaVendaId = null;
let pendingEtapaAdminId = null;
let pendingClienteId = null;
// Quando o cadastro de cliente é aberto "por cima" de outro modal (via
// "+ Criar cliente" no combobox, ou "✏️ Editar cliente" dentro do
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
// Quando arrastar pra uma etapa "entraFunilVendas" sem telefone, o modal
// de edição abre pedindo o telefone; isso guarda pra onde o card deveria
// ter ido, pra completar o movimento só depois de salvar com telefone.
let pendingAgendamentoMoveEtapa = null;
let lancandoRecorrentes = false;
let etapasAgendamentoSeeded = false;
let etapasVendaSeeded = false;
let etapasAdminSeeded = false;

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

function fmtDataHora(timestamp) {
  if (!timestamp) return "—";
  const d = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("pt-BR") + " " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function hojeStr() {
  return new Date().toISOString().slice(0, 10);
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
function fecharModal(id) { document.getElementById(id).classList.remove("active"); }

document.querySelectorAll("[data-fechar-modal]").forEach((btn) => {
  btn.addEventListener("click", () => fecharModal(btn.dataset.fecharModal));
});

// Modal de detalhe genérico — toda linha de tabela e todo card de kanban
// abre isto primeiro (só leitura). "onEditar"/"onExcluir" ficam atrás dos
// botões ✏️/🗑 lá dentro; passar null esconde o botão correspondente
// (usado por entidades sem edição, ex: cardAdmin sem link pra excluir
// direto). "campos" é um array de [label, valorHtmlJaEscapado].
let detalheAtual = null;
function abrirDetalhe({ titulo, campos, onEditar, onExcluir }) {
  document.getElementById("mdt-titulo").textContent = titulo;
  document.getElementById("mdt-corpo").innerHTML = campos.map(([label, valor]) => (
    `<div class="detalhe-campo"><span class="detalhe-label">${esc(label)}</span><span class="detalhe-valor">${valor}</span></div>`
  )).join("");
  detalheAtual = { onEditar, onExcluir };
  document.getElementById("mdt-btn-editar").style.display = onEditar ? "" : "none";
  document.getElementById("mdt-btn-excluir").style.display = onExcluir ? "" : "none";
  abrirModal("modal-detalhe");
}
document.getElementById("mdt-btn-editar").addEventListener("click", () => {
  if (detalheAtual && detalheAtual.onEditar) { fecharModal("modal-detalhe"); detalheAtual.onEditar(); }
});
document.getElementById("mdt-btn-excluir").addEventListener("click", () => {
  if (detalheAtual && detalheAtual.onExcluir) { fecharModal("modal-detalhe"); detalheAtual.onExcluir(); }
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

// Nível de interesse do lead/oportunidade — escala fixa de 5 pontos com
// emoji, tratada como "tag" visual nos cards e tabelas (não é uma lista
// que cresce, então não entra na regra de combobox filtrável — é um
// seletor de 5 botões fixos, tipo avaliação por estrelas).
const NIVEL_INTERESSE = {
  1: { emoji: "😠", label: "Muito desinteressado" },
  2: { emoji: "🙁", label: "Interesse moderadamente baixo" },
  3: { emoji: "😐", label: "Interesse médio" },
  4: { emoji: "🙂", label: "Interesse moderadamente alto" },
  5: { emoji: "🤩", label: "Muito interessado" }
};
function emojiNivelInteresse(n) { return n && NIVEL_INTERESSE[n] ? NIVEL_INTERESSE[n].emoji : ""; }
function labelNivelInteresse(n) { return n && NIVEL_INTERESSE[n] ? `${NIVEL_INTERESSE[n].emoji} ${NIVEL_INTERESSE[n].label}` : "—"; }

function criarPickerNivelInteresse(containerId) {
  const el = document.getElementById(containerId);
  el.innerHTML = Object.keys(NIVEL_INTERESSE).map((n) => (
    `<button type="button" class="nivel-btn" data-nivel="${n}" title="${esc(NIVEL_INTERESSE[n].label)}">${NIVEL_INTERESSE[n].emoji}</button>`
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
    <div class="kcard-nome">${esc(a.clienteNome)}${a.nivelInteresse ? ` <span class="kcard-nivel" title="${esc(labelNivelInteresse(a.nivelInteresse))}">${emojiNivelInteresse(a.nivelInteresse)}</span>` : ""}</div>
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
  renderKanban("kanban-agendamento", "agendamento", colunasAgendamento(), STATE.agendamentos, (a) => a.etapa, renderCardAgendamento);
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

  // Telefone e e-mail são obrigatórios só quando o lead chega numa etapa
  // que dispara a Agenda ("Agendado") — e vêm do CADASTRO DO CLIENTE, não
  // de um campo digitado aqui (contato só se edita na ficha do cliente).
  // Data/hora continuam sendo específicas do agendamento. Sem isso tudo
  // preenchido, abre o modal pedindo antes de completar o movimento; em
  // qualquer outra etapa o card transita livre, sem pedir nada.
  const clienteDoLead = STATE.clientes.find((c) => c.id === ag.clienteId);
  if (etapaCfg && etapaCfg.entraFunilVendas && (!clienteDoLead?.telefone || !clienteDoLead?.email || !ag.data)) {
    mostrarErro(`Telefone e e-mail (no cadastro do cliente) e data/hora são obrigatórios pra mover pra "${etapaCfg.nome}" — preencha e salve pra continuar.`);
    pendingAgendamentoMoveEtapa = novaEtapa;
    editarAgendamento(id, { confirmarAgendamento: true });
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
// botão "✏️ Editar cliente" conforme tem alguém selecionado ou não.
function atualizarContatoAgendamento(cliente) {
  const el = document.getElementById("ma-contato-cliente");
  const btn = document.getElementById("ma-btn-editar-cliente");
  if (!cliente) { el.textContent = "Selecione um cliente."; btn.disabled = true; return; }
  btn.disabled = false;
  el.textContent = `Tel: ${cliente.telefone || "não cadastrado"} · E-mail: ${cliente.email || "não cadastrado"}`;
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

async function excluirAgendamento(id) {
  if (!confirm("Excluir este agendamento?")) return;
  try { await deleteDoc(doc(db, "agendamentos", id)); } catch (err) { mostrarErro(err.message); }
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
// preencher agora. Fora disso (editar um lead comum, ou o ✏️ do modal de
// detalhe) o bloco só aparece se o lead já tiver data salva.
function editarAgendamento(id, opts = {}) {
  const a = STATE.agendamentos.find((x) => x.id === id);
  if (!a) return;
  pendingAgendamentoEditId = id;
  if (!opts.confirmarAgendamento) pendingAgendamentoMoveEtapa = null;
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
  document.getElementById("ma-campos-agendamento").style.display = (opts.confirmarAgendamento || a.data) ? "" : "none";
  abrirModal("modal-agendamento");
}
document.getElementById("btn-salvar-agendamento").addEventListener("click", async () => {
  const cliente = comboAgendamento.clienteSelecionado;
  if (!cliente) { mostrarErro("Selecione um cliente da lista, ou clique em \"+ Criar cliente\" pra cadastrar um novo."); return; }

  if (pendingAgendamentoEditId) {
    const dataEditada = document.getElementById("ma-data").value || "";
    const nivelEditado = pickerNivelAgendamento.valor;
    if (pendingAgendamentoMoveEtapa) {
      if (!cliente.telefone) { mostrarErro("Telefone é obrigatório no cadastro do cliente — clique em \"✏️ Editar cliente\" pra preencher."); return; }
      if (!cliente.email) { mostrarErro("E-mail é obrigatório no cadastro do cliente — clique em \"✏️ Editar cliente\" pra preencher."); return; }
      if (!dataEditada) { mostrarErro("Data é obrigatória pra continuar."); return; }
    }
    try {
      const agendamentoOriginal = STATE.agendamentos.find((a) => a.id === pendingAgendamentoEditId);
      await updateDoc(doc(db, "agendamentos", pendingAgendamentoEditId), {
        clienteId: cliente.id, clienteNome: cliente.nome,
        telefone: cliente.telefone || "",
        email: cliente.email || "",
        nivelInteresse: nivelEditado,
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
  // Normalmente a 1ª etapa é "Novo Lead" (sem entraFunilVendas), então um
  // lead novo não pede telefone/e-mail/data — só se alguém configurar o
  // funil pra já nascer direto em "Agendado".
  if (primeiraEtapa.entraFunilVendas) {
    if (!cliente.telefone) { mostrarErro(`Telefone é obrigatório no cadastro do cliente pra criar direto em "${primeiraEtapa.nome}".`); return; }
    if (!cliente.email) { mostrarErro(`E-mail é obrigatório no cadastro do cliente pra criar direto em "${primeiraEtapa.nome}".`); return; }
    if (!dataNova) { mostrarErro(`Data é obrigatória pra criar direto em "${primeiraEtapa.nome}".`); return; }
  }
  const dados = {
    clienteId: cliente.id, clienteNome: cliente.nome,
    telefone: cliente.telefone || "",
    email: cliente.email || "",
    nivelInteresse: pickerNivelAgendamento.valor,
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
  abrirDetalhe({
    titulo: a.clienteNome,
    campos: [
      ["Telefone", esc(a.telefone || "—")],
      ["E-mail", esc(a.email || "—")],
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
    onExcluir: () => excluirAgendamento(id)
  });
}

/* ══════════════ FUNIL DE VENDAS ══════════════ */

function colunasVendas() {
  return [...STATE.etapasVenda].sort((a, b) => a.ordem - b.ordem).map((e) => ({ id: e.id, nome: e.nome }));
}

function renderCardOportunidade(o) {
  const etapaCfg = STATE.etapasVenda.find((e) => e.id === o.etapa);
  return `
    <div class="kcard-nome">${esc(o.clienteNome)}${o.nivelInteresse ? ` <span class="kcard-nivel" title="${esc(labelNivelInteresse(o.nivelInteresse))}">${emojiNivelInteresse(o.nivelInteresse)}</span>` : ""}</div>
    <div class="kcard-sub">${esc(o.telefone || "")}${o.data ? ` · ${fmtData(o.data)} ${esc(o.hora || "")}` : ""}</div>
    <div class="kcard-foot">
      <span class="kcard-valor">${fmtMoeda(o.valorProposto)}</span>
      ${renderBadgeSla(o.dataEntrouEtapa, etapaCfg)}
    </div>
    ${o.perdida && o.motivoPerda ? `<div class="sublabel" style="margin-top:6px;">Motivo: ${esc(o.motivoPerda)}</div>` : ""}
  `;
}

function renderKanbanVendas() {
  renderKanban("kanban-vendas", "vendas", colunasVendas(), STATE.oportunidades, (o) => o.etapa, renderCardOportunidade);
  const ativas = STATE.oportunidades.filter((o) => !o.perdida);
  const valorTotal = ativas.reduce((s, o) => s + (Number(o.valorProposto) || 0), 0);
  document.getElementById("vendas-kpis").innerHTML = `
    <div class="funil-kpi"><div class="tag">Oportunidades ativas</div><div class="num">${ativas.length}</div></div>
    <div class="funil-kpi"><div class="tag">Valor em negociação</div><div class="num">${fmtMoeda(valorTotal)}</div></div>
  `;
}

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
  if (!confirm("Excluir esta oportunidade?")) return;
  try { await deleteDoc(doc(db, "oportunidades", id)); } catch (err) { mostrarErro(err.message); }
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
    onExcluir: () => excluirOportunidade(id)
  });
}

/* ══════════════ GERADOR DE CONTRATO ══════════════ */

function calcularParcelas(valorTotal, forma, valorEntrada, numParcelas, diaVencimento, dataPrimeira) {
  if (forma === "avista") {
    return [{ numero: 1, valor: valorTotal, vencimento: dataPrimeira }];
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

function lerFormularioContrato() {
  return {
    valorTotal: parseMoeda(document.getElementById("mct-valor").value),
    forma: document.getElementById("mct-forma").value,
    valorEntrada: parseMoeda(document.getElementById("mct-entrada").value),
    numParcelas: parseInt(document.getElementById("mct-numparcelas").value, 10) || 1,
    diaVencimento: parseInt(document.getElementById("mct-diavencimento").value, 10) || 10,
    dataPrimeira: document.getElementById("mct-primeiraparcela").value || hojeStr()
  };
}

function atualizarPreviewParcelas() {
  const f = lerFormularioContrato();
  if (!f.valorTotal) { document.getElementById("mct-preview-parcelas").textContent = ""; return; }
  const parcelas = calcularParcelas(f.valorTotal, f.forma, f.valorEntrada, f.numParcelas, f.diaVencimento, f.dataPrimeira);
  const texto = f.forma === "avista"
    ? `À vista: ${fmtMoeda(parcelas[0].valor)} em ${fmtData(parcelas[0].vencimento)}.`
    : `Entrada de ${fmtMoeda(parcelas[0].valor)} em ${fmtData(parcelas[0].vencimento)} + ${f.numParcelas}x de ~${fmtMoeda(parcelas[1] ? parcelas[1].valor : 0)}, todo dia ${f.diaVencimento}.`;
  document.getElementById("mct-preview-parcelas").textContent = texto;
}
["mct-valor", "mct-forma", "mct-entrada", "mct-numparcelas", "mct-diavencimento", "mct-primeiraparcela"].forEach((id) => {
  document.getElementById(id).addEventListener("input", atualizarPreviewParcelas);
  document.getElementById(id).addEventListener("change", atualizarPreviewParcelas);
});
document.getElementById("mct-forma").addEventListener("change", (e) => {
  document.getElementById("mct-linha-parcelamento").style.display = e.target.value === "avista" ? "none" : "flex";
});

function limparFormularioContrato() {
  ["mct-valor", "mct-entrada", "mct-telefone", "mct-email", "mct-cpfcnpj", "mct-endereco-busca"].forEach((id) => (document.getElementById(id).value = ""));
  comboContrato.reset();
  document.getElementById("mct-numparcelas").value = 1;
  document.getElementById("mct-diavencimento").value = 10;
  document.getElementById("mct-forma").value = "avista";
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
}
wireMascaraCpfCnpj("mct-cpfcnpj");
criarBuscaEndereco("mct-endereco-busca", "mct-endereco-dropdown");

document.getElementById("btn-novo-contrato").addEventListener("click", () => {
  pendingContratoOportunidadeId = null;
  pendingContratoEtapaFechamentoId = null;
  limparFormularioContrato();
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

  // Telefone, CPF/CNPJ e endereço são obrigatórios pra gerar o contrato —
  // o card só sai da etapa de origem depois de passar por aqui.
  const telefoneContrato = document.getElementById("mct-telefone").value.trim();
  const cpfCnpjContrato = document.getElementById("mct-cpfcnpj").value.trim();
  const enderecoContrato = document.getElementById("mct-endereco-busca").value.trim();
  if (!telefoneContrato) { mostrarErro("Telefone é obrigatório pra gerar o contrato."); return; }
  if (!cpfCnpjContrato) { mostrarErro("CPF ou CNPJ é obrigatório pra gerar o contrato."); return; }
  if (!enderecoContrato) { mostrarErro("Endereço é obrigatório pra gerar o contrato."); return; }

  const parcelasCalc = calcularParcelas(f.valorTotal, f.forma, f.valorEntrada, f.numParcelas, f.diaVencimento, f.dataPrimeira);

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
    if (Object.keys(patchCliente).length) await updateDoc(doc(db, "clientes", cliente.id), patchCliente);

    const contratoRef = await addDoc(collection(db, "contratos"), {
      oportunidadeId: pendingContratoOportunidadeId || null,
      clienteId: cliente.id, clienteNome: cliente.nome,
      valorTotal: f.valorTotal, formaPagamento: f.forma,
      valorEntrada: f.forma === "entrada_parcelas" ? f.valorEntrada : 0,
      numParcelas: f.forma === "entrada_parcelas" ? f.numParcelas : 1,
      diaVencimento: f.diaVencimento,
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

    try {
      const resp = await chamarAppsScript("gerarContratoPDF", {
        dados: {
          CLIENTE: cliente.nome,
          VALOR_TOTAL: fmtMoeda(f.valorTotal),
          FORMA_PAGAMENTO: f.forma === "avista" ? "À vista" : `Entrada de ${fmtMoeda(f.valorEntrada)} + ${f.numParcelas}x`,
          DATA: fmtData(hojeStr())
        }
      });
      if (resp.ok) await updateDoc(doc(db, "contratos", contratoRef.id), { pdfUrl: resp.url, pdfFileId: resp.fileId || null });
    } catch (errPdf) {
      mostrarErro("Contrato e parcelas criados, mas o PDF não pôde ser gerado: " + errPdf.message);
    }

    fecharModal("modal-contrato");
    limparFormularioContrato();
    pendingContratoOportunidadeId = null;
    pendingContratoEtapaFechamentoId = null;
    mostrarToast("Contrato gerado com sucesso.");
  } catch (err) {
    mostrarErro("Não foi possível gerar o contrato: " + err.message);
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

function renderTabelaContratos() {
  document.getElementById("tabela-contratos").innerHTML = STATE.contratos.map((c) => {
    const parcelasDoContrato = STATE.parcelas.filter((p) => p.contratoId === c.id);
    const pagas = parcelasDoContrato.filter((p) => p.status === "realizado").length;
    const links = linksPdfDrive(c.pdfFileId);
    return `<tr class="linha-clicavel" onclick="window.__jm.abrirDetalheContrato('${c.id}')">
      <td>${esc(c.clienteNome)}</td>
      <td class="num">${fmtMoeda(c.valorTotal)}</td>
      <td>${c.formaPagamento === "avista" ? "À vista" : `Entrada + ${c.numParcelas}x`}</td>
      <td>${pagas}/${parcelasDoContrato.length}</td>
      <td>${fmtDataHora(c.dataGeracao)}</td>
      <td>${links ? `<a href="${esc(links.download)}" onclick="event.stopPropagation()">Baixar PDF</a>` : c.pdfUrl ? `<a href="${esc(c.pdfUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Ver PDF</a>` : `<a href="#" onclick="event.stopPropagation();event.preventDefault();window.__jm.gerarPdfContratoExistente('${c.id}')">Gerar PDF</a>`}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="6"><div class="empty">Nenhum contrato ainda.</div></td></tr>`;
}

async function excluirContrato(id) {
  if (!confirm("Excluir este contrato e todas as parcelas/etapas administrativas vinculadas? Isso não pode ser desfeito.")) return;
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
  document.getElementById("mcs-status").value = c.status || "ativo";
  abrirModal("modal-contrato-status");
}
document.getElementById("btn-salvar-contrato-status").addEventListener("click", async () => {
  if (!pendingContratoStatusId) return;
  try {
    await updateDoc(doc(db, "contratos", pendingContratoStatusId), { status: document.getElementById("mcs-status").value });
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
    ["Valor total", esc(fmtMoeda(c.valorTotal))],
    ["Forma de pagamento", c.formaPagamento === "avista" ? "À vista" : `Entrada de ${esc(fmtMoeda(c.valorEntrada))} + ${c.numParcelas}x`],
    ["Parcelas pagas", `${pagas}/${parcelasDoContrato.length}`],
    ["Gerado em", esc(fmtDataHora(c.dataGeracao))],
    ["Status", esc(c.status === "cancelado" ? "Cancelado" : "Ativo")]
  ];
  if (links) {
    campos.push(["PDF", `<iframe src="${esc(links.preview)}" style="width:100%;height:340px;border:1px solid var(--line);border-radius:8px;background:#fff;"></iframe>
      <div style="display:flex;gap:14px;margin-top:8px;">
        <a href="${esc(c.pdfUrl || links.preview)}" target="_blank" rel="noopener">Abrir em nova aba</a>
        <a href="${esc(links.download)}">Baixar PDF</a>
      </div>`]);
  } else if (c.pdfUrl) {
    campos.push(["PDF", `<a href="${esc(c.pdfUrl)}" target="_blank" rel="noopener">Ver PDF</a>`]);
  } else {
    campos.push(["PDF", `
      <p class="hint" style="margin-bottom:8px;">Ainda não gerado (pode ter sido criado antes do Apps Script estar configurado).</p>
      <button class="btn btn-primary" onclick="window.__jm.gerarPdfContratoExistente('${id}')">🔄 Gerar PDF agora</button>
    `]);
  }
  abrirDetalhe({
    titulo: c.clienteNome,
    campos,
    onEditar: () => editarContratoStatus(id),
    onExcluir: () => excluirContrato(id)
  });
}

// Cobre contratos que ficaram sem PDF (ex: criados antes do Code.gs estar
// configurado com CONTRATO_TEMPLATE_DOC_ID) — gera com os mesmos dados
// já salvos no contrato, sem precisar recriar nada.
async function gerarPdfContratoExistente(id) {
  const c = STATE.contratos.find((x) => x.id === id);
  if (!c) return;
  try {
    const resp = await chamarAppsScript("gerarContratoPDF", {
      dados: {
        CLIENTE: c.clienteNome,
        VALOR_TOTAL: fmtMoeda(c.valorTotal),
        FORMA_PAGAMENTO: c.formaPagamento === "avista" ? "À vista" : `Entrada de ${fmtMoeda(c.valorEntrada)} + ${c.numParcelas}x`,
        DATA: fmtData(hojeStr())
      }
    });
    await updateDoc(doc(db, "contratos", id), { pdfUrl: resp.url, pdfFileId: resp.fileId || null });
    mostrarToast("PDF gerado com sucesso.");
    abrirDetalheContrato(id);
  } catch (err) { mostrarErro("Não foi possível gerar o PDF: " + err.message); }
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
  renderKanban("kanban-administrativo", "administrativo", colunas, STATE.cardsAdmin, (c) => c.etapa, renderCardAdmin);
}

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
  if (!confirm("Excluir este card do Funil Administrativo? Isso NÃO exclui o contrato nem as parcelas vinculadas — use com cuidado.")) return;
  try { await deleteDoc(doc(db, "cardsAdmin", id)); } catch (err) { mostrarErro(err.message); }
}

function abrirDetalheCardAdmin(id) {
  const c = STATE.cardsAdmin.find((x) => x.id === id);
  if (!c) return;
  const etapaCfg = STATE.etapasAdmin.find((e) => e.id === c.etapa);
  abrirDetalhe({
    titulo: c.clienteNome,
    campos: [
      ["Valor total", esc(fmtMoeda(c.valorTotal))],
      ["Etapa", esc(etapaCfg ? etapaCfg.nome : "—")],
      ["Contrato vinculado", c.contratoId ? "Sim (veja em Contratos)" : "—"]
    ],
    onEditar: () => editarCardAdmin(id),
    onExcluir: () => excluirCardAdmin(id)
  });
}

/* ══════════════ RELATÓRIO DE FUNIL (conversão + tempo em cada etapa) ══════════════
   Sob demanda (só ao clicar em "📊 Relatório", não fica recalculando o
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

  return etapasSorted.map((e, i) => {
    const jaPassaram = alcancaram[e.id].size;
    const anterior = i > 0 ? alcancaram[etapasSorted[i - 1].id].size : jaPassaram;
    const conversao = i === 0 ? (jaPassaram > 0 ? 100 : 0) : (anterior > 0 ? (jaPassaram / anterior) * 100 : 0);
    const tempos = temposAtuais[e.id];
    const tempoMedioMs = tempos.length ? tempos.reduce((s, v) => s + v, 0) / tempos.length : null;
    return { etapa: e, cardsAgora: cards.filter((c) => c.etapa === e.id).length, jaPassaram, conversao, tempoMedioMs };
  });
}

function renderRelatorioFunil(containerId, linhas) {
  document.getElementById(containerId).innerHTML = `
    <h2>Relatório do <span>funil</span></h2>
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
    <p class="hint" style="margin-top:10px;">"Já passaram" conta cada card que já esteve nessa etapa em algum momento (posição atual ou pelo histórico). Como o funil é de trânsito livre (arrastar pra qualquer etapa), a conversão é aproximada — não assume ordem estritamente sequencial.</p>
  `;
}

function configurarBotaoRelatorio(btnId, blocoId, getCards, getEtapas, colecaoNome) {
  document.getElementById(btnId).addEventListener("click", async () => {
    const bloco = document.getElementById(blocoId);
    if (bloco.style.display !== "none") { bloco.style.display = "none"; return; }
    bloco.style.display = "block";
    bloco.innerHTML = `<p class="hint">Calculando...</p>`;
    try {
      const linhas = await calcularAnaliseFunil(getCards(), getEtapas(), colecaoNome);
      renderRelatorioFunil(blocoId, linhas);
    } catch (err) {
      bloco.innerHTML = `<p class="hint">Não foi possível calcular: ${esc(err.message)}</p>`;
    }
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

async function marcarParcelaPaga(id) {
  try {
    await updateDoc(doc(db, "parcelas", id), { status: "realizado", dataPagamento: hojeStr() });
    mostrarToast("Parcela marcada como paga.");
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
  if (!confirm("Excluir esta parcela? Isso NÃO ajusta o valor total do contrato — use com cuidado.")) return;
  try { await deleteDoc(doc(db, "parcelas", id)); } catch (err) { mostrarErro(err.message); }
}

function abrirDetalheParcela(id) {
  const p = STATE.parcelas.find((x) => x.id === id);
  if (!p) return;
  abrirDetalhe({
    titulo: `${p.clienteNome} — ${p.numero === 0 ? "Entrada" : "Parcela " + p.numero}`,
    campos: [
      ["Valor", esc(fmtMoeda(p.valor))],
      ["Vencimento", esc(fmtData(p.vencimento))],
      ["Status", p.status === "realizado" ? "Pago" : "Esperado"],
      ["Data do pagamento", esc(fmtData(p.dataPagamento))]
    ],
    onEditar: () => editarParcela(id),
    onExcluir: () => excluirParcela(id)
  });
}

function renderFinanceiro() {
  const periodo = STATE.periodoFinanceiro;

  const faturamentoPeriodo = STATE.contratos
    .filter((c) => c.dataGeracao && c.dataGeracao.toDate && c.dataGeracao.toDate().toISOString().slice(0, 7) === periodo)
    .reduce((s, c) => s + (Number(c.valorTotal) || 0), 0);

  const parcelasDoPeriodo = STATE.parcelas.filter((p) => (p.vencimento || "").slice(0, 7) === periodo);
  const fluxoEsperado = parcelasDoPeriodo.filter((p) => p.status === "esperado").reduce((s, p) => s + (Number(p.valor) || 0), 0);
  const fluxoRealizado = STATE.parcelas
    .filter((p) => p.status === "realizado" && (p.dataPagamento || "").slice(0, 7) === periodo)
    .reduce((s, p) => s + (Number(p.valor) || 0), 0);

  const despesasMes = STATE.despesas.filter((d) => d.tipo === "despesa" && (d.data || "").slice(0, 7) === periodo).reduce((s, d) => s + (Number(d.valor) || 0), 0);
  const outrosCustos = STATE.despesas.filter((d) => d.tipo === "outro_custo" && (d.data || "").slice(0, 7) === periodo).reduce((s, d) => s + (Number(d.valor) || 0), 0);
  const lucroOperacional = fluxoRealizado - despesasMes;
  const saldoEstimado = lucroOperacional - outrosCustos;

  document.getElementById("fin-kpis").innerHTML = `
    <div class="kpi-card"><div class="label">Faturamento do período</div><div class="value">${fmtMoeda(faturamentoPeriodo)}</div><div class="sub">venda fechada no mês</div></div>
    <div class="kpi-card"><div class="label">Caixa esperado</div><div class="value">${fmtMoeda(fluxoEsperado)}</div><div class="sub">parcelas a vencer no mês</div></div>
    <div class="kpi-card positive"><div class="label">Caixa realizado</div><div class="value">${fmtMoeda(fluxoRealizado)}</div><div class="sub">parcelas pagas no mês</div></div>
    <div class="kpi-card negative"><div class="label">Despesas do mês</div><div class="value">${fmtMoeda(despesasMes)}</div></div>
    <div class="kpi-card ${lucroOperacional >= 0 ? "positive" : "negative"}"><div class="label">Lucro operacional</div><div class="value">${fmtMoeda(lucroOperacional)}</div><div class="sub">caixa realizado − despesas</div></div>
    <div class="kpi-card negative"><div class="label">Outros custos</div><div class="value">${fmtMoeda(outrosCustos)}</div><div class="sub">impostos e taxas</div></div>
    <div class="kpi-card ${saldoEstimado >= 0 ? "positive" : "negative"}"><div class="label">Saldo estimado</div><div class="value">${fmtMoeda(saldoEstimado)}</div><div class="sub">lucro operacional − outros custos</div></div>
  `;

  const vencidas = STATE.parcelas.filter((p) => p.status === "esperado" && p.vencimento && p.vencimento < hojeStr()).sort((a, b) => a.vencimento.localeCompare(b.vencimento));
  document.getElementById("tabela-parcelas-vencidas").innerHTML = vencidas.map((p) => `<tr class="linha-clicavel" onclick="window.__jm.abrirDetalheParcela('${p.id}')">
    <td>${esc(p.clienteNome)}</td><td>${p.numero === 0 ? "Entrada" : "Parcela " + p.numero}</td>
    <td>${fmtData(p.vencimento)}</td><td class="num">${fmtMoeda(p.valor)}</td>
    <td><button class="btn-small" onclick="event.stopPropagation();window.__jm.marcarParcelaPaga('${p.id}')">Marcar paga</button></td>
  </tr>`).join("") || `<tr><td colspan="5"><div class="empty">Nenhuma parcela vencida. 🎉</div></td></tr>`;

  document.getElementById("tabela-parcelas-periodo").innerHTML = parcelasDoPeriodo
    .slice().sort((a, b) => (a.vencimento || "").localeCompare(b.vencimento || ""))
    .map((p) => `<tr class="linha-clicavel" onclick="window.__jm.abrirDetalheParcela('${p.id}')">
      <td>${esc(p.clienteNome)}</td><td>${p.numero === 0 ? "Entrada" : "Parcela " + p.numero}</td>
      <td>${fmtData(p.vencimento)}</td><td class="num">${fmtMoeda(p.valor)}</td>
      <td><span class="stamp ${p.status}">${p.status === "realizado" ? "Pago" : "Esperado"}</span></td>
      <td>${p.status === "esperado" ? `<button class="btn-small" onclick="event.stopPropagation();window.__jm.marcarParcelaPaga('${p.id}')">Marcar paga</button>` : "—"}</td>
    </tr>`).join("") || `<tr><td colspan="6"><div class="empty">Nenhuma parcela neste período.</div></td></tr>`;

  const despesasDoPeriodo = STATE.despesas
    .filter((d) => (d.data || "").slice(0, 7) === periodo)
    .sort((a, b) => (a.data || "").localeCompare(b.data || ""));
  document.getElementById("tabela-despesas-periodo").innerHTML = despesasDoPeriodo.map((d) => `<tr class="linha-clicavel" onclick="window.__jm.abrirDetalheDespesa('${d.id}')">
    <td>${esc(d.descricao)}</td><td>${esc(d.categoria || "—")}</td>
    <td>${d.tipo === "despesa" ? "Despesa" : "Outro custo"}</td>
    <td class="num">${fmtMoeda(d.valor)}</td><td>${fmtData(d.data)}</td>
  </tr>`).join("") || `<tr><td colspan="5"><div class="empty">Nenhuma despesa lançada neste período.</div></td></tr>`;
}

/* ══════════════ DESPESAS & CUSTOS ══════════════ */

function abrirModalDespesa() {
  pendingDespesaId = null;
  document.getElementById("modal-despesa-titulo").textContent = "Nova despesa/custo";
  document.getElementById("md-descricao").value = "";
  document.getElementById("md-categoria").value = "";
  document.getElementById("md-valor").value = "";
  document.getElementById("md-data").value = hojeStr();
  document.getElementById("md-tipo").value = "despesa";
  document.getElementById("md-recorrente").checked = false;
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
  document.getElementById("md-tipo").value = d.tipo || "despesa";
  document.getElementById("md-recorrente").checked = !!d.recorrente;
  abrirModal("modal-despesa");
}
document.getElementById("btn-salvar-despesa").addEventListener("click", async () => {
  const descricao = document.getElementById("md-descricao").value.trim();
  const valor = parseMoeda(document.getElementById("md-valor").value);
  const data = document.getElementById("md-data").value || hojeStr();
  if (!descricao) { mostrarErro("Informe a descrição."); return; }
  if (!valor) { mostrarErro("Informe o valor."); return; }
  const recorrente = document.getElementById("md-recorrente").checked;
  const dados = {
    descricao, categoria: document.getElementById("md-categoria").value.trim(),
    tipo: document.getElementById("md-tipo").value, valor, data,
    recorrente, diaVencimento: recorrente ? parseInt(data.split("-")[2], 10) : null
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
  if (!confirm("Excluir este lançamento?")) return;
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
      ["Valor", esc(fmtMoeda(d.valor))],
      ["Data", esc(fmtData(d.data))],
      ["Recorrente", d.recorrente ? `Sim (dia ${d.diaVencimento})` : "—"],
      d.status === "realizado"
        ? ["Status", `Pago em ${esc(fmtData(d.dataPagamento))}`]
        : ["Status", `Pendente <button class="btn-small" style="margin-left:8px;" onclick="window.__jm.marcarDespesaPaga('${id}')">Marcar pago</button>`]
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

async function marcarDespesaPaga(id) {
  try {
    await updateDoc(doc(db, "despesas", id), { status: "realizado", dataPagamento: hojeStr() });
    mostrarToast("Despesa marcada como paga.");
  } catch (err) { mostrarErro(err.message); }
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

// "Status" de uma despesa: ausente = "esperado" (pendente) — despesas
// lançadas antes desse campo existir contam como pendentes por padrão,
// já que nunca foi registrado se foram pagas.
function statusDespesa(d) { return d.status === "realizado" ? "realizado" : "esperado"; }

function renderTabelaDespesas() {
  const de = STATE.periodoDespesasDe, ate = STATE.periodoDespesasAte;
  const despesasFiltradas = STATE.despesas.filter((d) => {
    const data = d.data || "";
    return (!de || data >= de) && (!ate || data <= ate);
  });
  const hoje = hojeStr();
  const pendentes = despesasFiltradas.filter((d) => statusDespesa(d) === "esperado");
  const pagas = despesasFiltradas.filter((d) => statusDespesa(d) === "realizado");
  const aPagarAteHoje = pendentes.filter((d) => (d.data || "") <= hoje);
  const somar = (lista) => lista.reduce((s, d) => s + (Number(d.valor) || 0), 0);

  document.getElementById("despesas-kpis").innerHTML = `
    <div class="kpi-card negative"><div class="label">A pagar até hoje</div><div class="value">${fmtMoeda(somar(aPagarAteHoje))}</div><div class="sub">pendentes com data de hoje ou anterior</div></div>
    <div class="kpi-card"><div class="label">Total pendente</div><div class="value">${fmtMoeda(somar(pendentes))}</div><div class="sub">todas as não pagas do período (inclusive futuras)</div></div>
    <div class="kpi-card positive"><div class="label">Total pago</div><div class="value">${fmtMoeda(somar(pagas))}</div><div class="sub">todas as pagas do período</div></div>
  `;

  document.getElementById("tabela-despesas").innerHTML = despesasFiltradas
    .slice().sort((a, b) => (b.data || "").localeCompare(a.data || ""))
    .map((d) => {
      const status = statusDespesa(d);
      const vencida = status === "esperado" && (d.data || "") <= hoje;
      return `<tr class="linha-clicavel" onclick="window.__jm.abrirDetalheDespesa('${d.id}')">
      <td>${esc(d.descricao)}</td><td>${esc(d.categoria || "—")}</td>
      <td>${d.tipo === "despesa" ? "Despesa" : "Outro custo"}</td>
      <td class="num">${fmtMoeda(d.valor)}</td><td>${fmtData(d.data)}</td>
      <td>${d.recorrente ? "Sim (dia " + d.diaVencimento + ")" : "—"}</td>
      <td><span class="stamp ${status === "realizado" ? "realizado" : vencida ? "vencido" : "esperado"}">${status === "realizado" ? "Pago" : vencida ? "A pagar" : "Pendente"}</span></td>
      <td>${status === "realizado" ? "—" : `<button class="btn-small" onclick="event.stopPropagation();window.__jm.marcarDespesaPaga('${d.id}')">Marcar pago</button>`}</td>
    </tr>`;
    }).join("") || `<tr><td colspan="8"><div class="empty">Nenhuma despesa no período.</div></td></tr>`;
}

/* ══════════════ CLIENTES ══════════════ */

document.getElementById("btn-novo-cliente").addEventListener("click", () => {
  pendingClienteId = null;
  document.getElementById("modal-cliente-titulo").textContent = "Novo cliente";
  ["mc-nome", "mc-telefone", "mc-email", "mc-cpfcnpj", "mc-endereco-busca", "mc-origem", "mc-obs"].forEach((id) => (document.getElementById(id).value = ""));
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
  document.getElementById("mc-origem").value = c.origem || "";
  document.getElementById("mc-obs").value = c.observacoes || "";
  abrirModal("modal-cliente");
}
// Abre o cadastro de cliente "por cima" de outro modal já aberto (o
// combobox de qualquer funil usa isso pra "+ Criar cliente"; o botão
// "✏️ Editar cliente" dentro do Agendamento/Vendas usa pra corrigir
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
    ["mc-nome", "mc-telefone", "mc-email", "mc-cpfcnpj", "mc-endereco-busca", "mc-origem", "mc-obs"].forEach((id) => (document.getElementById(id).value = ""));
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
  if (!confirm("Excluir este cliente? (Os registros já vinculados a ele nos funis não são apagados.)")) return;
  try { await deleteDoc(doc(db, "clientes", id)); } catch (err) { mostrarErro(err.message); }
}

function abrirDetalheCliente(id) {
  const c = STATE.clientes.find((x) => x.id === id);
  if (!c) return;
  abrirDetalhe({
    titulo: c.nome,
    campos: [
      ["Telefone", esc(c.telefone || "—")],
      ["E-mail", esc(c.email || "—")],
      ["CPF/CNPJ", esc(c.cpfCnpj || "—")],
      ["Endereço", esc(c.endereco || "—")],
      ["Origem", esc(c.origem || "—")],
      ["Observações", esc(c.observacoes || "—")]
    ],
    onEditar: () => editarCliente(id),
    onExcluir: () => excluirCliente(id)
  });
}

function renderTabelaClientes() {
  document.getElementById("tabela-clientes").innerHTML = STATE.clientes.map((c) => `<tr class="linha-clicavel" onclick="window.__jm.abrirDetalheCliente('${c.id}')">
    <td>${esc(c.nome)}</td><td>${esc(c.telefone || "—")}</td><td>${esc(c.email || "—")}</td><td>${esc(c.origem || "—")}</td>
  </tr>`).join("") || `<tr><td colspan="4"><div class="empty">Nenhum cliente cadastrado.</div></td></tr>`;
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
  if (!confirm("Excluir esta etapa? Agendamentos nela ficarão sem coluna visível até serem movidos.")) return;
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
  if (!confirm("Excluir esta etapa? Oportunidades nela ficarão sem coluna visível até serem movidas.")) return;
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
  if (!confirm("Excluir esta etapa? Cards nela ficarão sem coluna visível até serem movidos.")) return;
  try { await deleteDoc(doc(db, "etapasAdminConfig", id)); } catch (err) { mostrarErro(err.message); }
}

function fmtSla(e) {
  const unidade = e.slaUnidade === "horas" ? "h" : "d";
  if (!e.slaAmarelo && !e.slaVermelho) return "—";
  return `🟡 ${e.slaAmarelo || 0}${unidade} · 🔴 ${e.slaVermelho || 0}${unidade}`;
}

function renderConfigEtapasAgendamento() {
  document.getElementById("tabela-etapas-agendamento").innerHTML = [...STATE.etapasAgendamento].sort((a, b) => a.ordem - b.ordem).map((e) => `<tr class="linha-clicavel" onclick="window.__jm.abrirDetalheEtapaAgendamento('${e.id}')">
    <td>${e.ordem}</td><td>${esc(e.nome)}</td><td>${e.entraFunilVendas ? "Sim" : "—"}</td><td>${e.perda ? "Sim" : "—"}</td><td>${fmtSla(e)}</td>
  </tr>`).join("") || `<tr><td colspan="5"><div class="empty">Nenhuma etapa cadastrada.</div></td></tr>`;
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
  { nome: "Novo Lead", ordem: 1, entraFunilVendas: false, perda: false, slaUnidade: "dias", slaAmarelo: 1, slaVermelho: 2 },
  { nome: "Tentativa de Contato", ordem: 2, entraFunilVendas: false, perda: false, slaUnidade: "dias", slaAmarelo: 1, slaVermelho: 3 },
  { nome: "Retomar Contato", ordem: 3, entraFunilVendas: false, perda: false, slaUnidade: "dias", slaAmarelo: 1, slaVermelho: 3 },
  { nome: "Qualificação", ordem: 4, entraFunilVendas: false, perda: false, slaUnidade: "dias", slaAmarelo: 1, slaVermelho: 3 },
  { nome: "Agendado", ordem: 5, entraFunilVendas: true, perda: false, slaUnidade: "dias", slaAmarelo: 1, slaVermelho: 3 },
  { nome: "Reagendar", ordem: 6, entraFunilVendas: false, perda: false, slaUnidade: "dias", slaAmarelo: 1, slaVermelho: 3 },
  { nome: "Perdido", ordem: 7, entraFunilVendas: false, perda: true, slaUnidade: "dias", slaAmarelo: 0, slaVermelho: 0 }
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

function iniciarListeners() {
  onSnapshot(doc(db, "config", "geral"), (snap) => {
    STATE.config = snap.exists() ? snap.data() : {};
    renderConfigCalendario();
  }, (err) => mostrarErro("Erro de conexão (config): " + err.message));

  onSnapshot(query(collection(db, "clientes"), orderBy("createdAt", "desc")), (snap) => {
    STATE.clientes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderTabelaClientes();
  }, (err) => mostrarErro("Erro de conexão (clientes): " + err.message));

  onSnapshot(query(collection(db, "etapasAgendamentoConfig"), orderBy("ordem")), async (snap) => {
    STATE.etapasAgendamento = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (!etapasAgendamentoSeeded && STATE.etapasAgendamento.length === 0) {
      etapasAgendamentoSeeded = true;
      for (const e of DEFAULT_ETAPAS_AGENDAMENTO) await addDoc(collection(db, "etapasAgendamentoConfig"), e);
      return;
    }
    renderKanbanAgendamento();
    renderConfigEtapasAgendamento();
  }, (err) => mostrarErro("Erro de conexão (etapas de agendamento): " + err.message));

  onSnapshot(query(collection(db, "agendamentos"), orderBy("createdAt", "desc")), (snap) => {
    STATE.agendamentos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderKanbanAgendamento();
  }, (err) => mostrarErro("Erro de conexão (agendamentos): " + err.message));

  onSnapshot(query(collection(db, "etapasVendaConfig"), orderBy("ordem")), async (snap) => {
    STATE.etapasVenda = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (!etapasVendaSeeded && STATE.etapasVenda.length === 0) {
      etapasVendaSeeded = true;
      for (const e of DEFAULT_ETAPAS_VENDA) await addDoc(collection(db, "etapasVendaConfig"), e);
      return;
    }
    renderKanbanVendas();
    renderConfigEtapasVenda();
  }, (err) => mostrarErro("Erro de conexão (etapas de venda): " + err.message));

  onSnapshot(query(collection(db, "oportunidades"), orderBy("createdAt", "desc")), (snap) => {
    STATE.oportunidades = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderKanbanVendas();
  }, (err) => mostrarErro("Erro de conexão (oportunidades): " + err.message));

  onSnapshot(query(collection(db, "contratos"), orderBy("dataGeracao", "desc")), (snap) => {
    STATE.contratos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderTabelaContratos();
    renderFinanceiro();
  }, (err) => mostrarErro("Erro de conexão (contratos): " + err.message));

  onSnapshot(query(collection(db, "parcelas"), orderBy("vencimento")), (snap) => {
    STATE.parcelas = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderTabelaContratos();
    renderFinanceiro();
  }, (err) => mostrarErro("Erro de conexão (parcelas): " + err.message));

  onSnapshot(query(collection(db, "despesas"), orderBy("createdAt", "desc")), (snap) => {
    STATE.despesas = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderTabelaDespesas();
    renderFinanceiro();
    lancarRecorrentesPendentes();
  }, (err) => mostrarErro("Erro de conexão (despesas): " + err.message));

  onSnapshot(query(collection(db, "etapasAdminConfig"), orderBy("ordem")), async (snap) => {
    STATE.etapasAdmin = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (!etapasAdminSeeded && STATE.etapasAdmin.length === 0) {
      etapasAdminSeeded = true;
      for (const e of DEFAULT_ETAPAS_ADMIN) await addDoc(collection(db, "etapasAdminConfig"), e);
      return;
    }
    renderKanbanAdministrativo();
    renderConfigEtapasAdmin();
  }, (err) => mostrarErro("Erro de conexão (etapas administrativas): " + err.message));

  onSnapshot(query(collection(db, "cardsAdmin"), orderBy("createdAt", "desc")), (snap) => {
    STATE.cardsAdmin = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderKanbanAdministrativo();
  }, (err) => mostrarErro("Erro de conexão (funil administrativo): " + err.message));
}

// Funções chamadas a partir de HTML gerado por string (onclick inline) —
// só assim dá pra referenciá-las de dentro de innerHTML num ES module.
window.__jm = {
  marcarParcelaPaga, marcarDespesaPaga,
  abrirDetalheCliente, abrirDetalheDespesa, abrirDetalheContrato, abrirDetalheParcela,
  abrirDetalheEtapaAgendamento, abrirDetalheEtapaVenda, abrirDetalheEtapaAdmin,
  gerarPdfContratoExistente
};

iniciarListeners();

// As cores do badge de SLA (verde/amarelo/vermelho) dependem só do relógio
// — sem isso, um card ficaria "verde" pra sempre até a próxima escrita no
// Firestore. Reaplica o render dos 3 kanbans a cada minuto pra refletir o
// tempo passando, mesmo sem ninguém mexer em nada.
setInterval(() => {
  renderKanbanAgendamento();
  renderKanbanVendas();
  renderKanbanAdministrativo();
}, 60000);
