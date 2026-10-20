// Checkout Fast Start.
//
// MODO_DEMONSTRACAO: o fluxo inteiro funciona na tela, mas nada é gravado,
// nenhum contrato vai pra Autentique e nada é cobrado. É a versão que vai ao
// ar pra análise da PicPay. Desligar só quando o Code.gs estiver ligado.
const MODO_DEMONSTRACAO = true;

// ?estado=... abre direto numa tela (conferência visual contra telas/*.png)
// ?exemplo=1 preenche os dados das imagens validadas

const ICONE = {
  seta: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  caneta: '<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 6l3 3"/>',
  cadeado: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'
};
const svg = (nome) => `<svg class="ic-svg" viewBox="0 0 24 24" aria-hidden="true">${ICONE[nome]}</svg>`;

const $ = (sel, raiz = document) => raiz.querySelector(sel);
const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)];
const form = $("#checkout");
const campo = (nome) => form.elements[nome];
const digitos = (v) => String(v || "").replace(/\D/g, "");

/* ============ estado da tela ============ */

const TELAS = ["empresa", "responsavel", "contrato", "pagamento", "final"];
let atual = "empresa";
let forma = "cartao";

function etapaDe(tela) { return TELAS.indexOf(tela) + 1; }

function mostrarTela(tela, { focar = true } = {}) {
  atual = tela;
  const etapa = etapaDe(tela);
  $$("[data-tela]").forEach((s) => (s.hidden = s.dataset.tela !== tela));
  $$(".etapas li").forEach((li) => {
    const n = Number(li.dataset.etapa);
    li.classList.toggle("feita", n < etapa);
    li.classList.toggle("atual", n === etapa);
    if (n === etapa) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
  });
  $(".etapas").style.setProperty("--feitas", Math.min(etapa, 4) - 1);

  const rodape = $(".rodape");
  rodape.hidden = tela === "final";
  rodape.classList.toggle("coluna", tela === "pagamento");
  $('[data-acao="voltar"]').hidden = etapa === 1 || etapa === 4;
  atualizarBotao();
  if (tela === "contrato") preencherContrato();
  if (tela === "final") preencherFinal();
  guardar();
  if (focar) {
    window.scrollTo({ top: 0, behavior: "smooth" });
    const primeiro = $(`[data-tela="${tela}"] input:not([type=hidden])`);
    if (primeiro && !primeiro.value && matchMedia("(pointer:fine)").matches) primeiro.focus({ preventScroll: true });
  }
}

function atualizarBotao() {
  const avancar = $('[data-acao="avancar"]');
  const nota = $(".rodape .nota");
  let botao = ["seta", "Continuar", "dir"], texto = "";
  if (atual === "contrato") botao = ["caneta", "Assinar contrato", "esq"];
  if (atual === "pagamento") {
    botao = ["cadeado", "Pagar R$ 4.997,00", "esq"];
    texto = forma === "cartao" ? "Processado pela PicPay. O cartão não fica no nosso site." : "Pagamento processado pela PicPay.";
  }
  avancar.hidden = atual === "pagamento" && forma === "pix";
  const [icone, rotulo, lado] = botao;
  avancar.innerHTML = lado === "esq" ? `${svg(icone)}${rotulo}` : `${rotulo}${svg(icone)}`;
  nota.hidden = !texto;
  nota.innerHTML = texto ? `${svg("cadeado")}${texto}` : "";
}

function trocarForma(nova) {
  forma = nova;
  $$("[data-forma]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.forma === nova)));
  $$("[data-forma-painel]").forEach((p) => (p.hidden = p.dataset.formaPainel !== nova));
  atualizarBotao();
}

/* ============ máscaras ============ */

function mascarar(v, molde) {
  const d = digitos(v);
  let out = "", i = 0;
  for (const c of molde) {
    if (i >= d.length) break;
    out += c === "#" ? d[i++] : c;
  }
  return out;
}
const MASCARAS = {
  cnpj: (v) => mascarar(v, "##.###.###/####-##"),
  cep: (v) => mascarar(v, "#####-###"),
  representanteCpf: (v) => mascarar(v, "###.###.###-##"),
  whatsapp: (v) => mascarar(v, digitos(v).length > 10 ? "(##) # ####-####" : "(##) ####-####"),
  "cc-numero": (v) => mascarar(v, digitos(v).startsWith("3") ? "#### ###### #####" : "#### #### #### ####"),
  "cc-validade": (v) => mascarar(v, "##/##"),
  "cc-cvv": (v) => digitos(v).slice(0, 4),
  "cc-cpf": (v) => mascarar(v, "###.###.###-##")
};
form.addEventListener("input", (ev) => {
  const el = ev.target;
  const chave = el.name || el.id;
  if (MASCARAS[chave]) el.value = MASCARAS[chave](el.value);
  if (el.id === "cc-nome") el.value = el.value.toUpperCase();
  limparErro(el);
  if (chave === "cnpj" && digitos(el.value).length === 14) buscarCnpj(el.value);
  if (chave === "cnpj") $(".campo .tag").hidden = true;
  if (chave === "cep" && digitos(el.value).length === 8) buscarCep(el.value);
  if (chave === "cc-numero") mostrarBandeira(el.value);
  guardar();
});

/* ============ validação ============ */

function cpfValido(v) {
  const d = digitos(v);
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
  for (const t of [9, 10]) {
    let s = 0;
    for (let i = 0; i < t; i++) s += Number(d[i]) * (t + 1 - i);
    if (((s * 10) % 11) % 10 !== Number(d[t])) return false;
  }
  return true;
}
function cnpjValido(v) {
  const d = digitos(v);
  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
  const calc = (n) => {
    const pesos = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const s = pesos.reduce((acc, p, i) => acc + Number(d[i]) * p, 0);
    const r = s % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}
function luhn(v) {
  const d = digitos(v);
  if (d.length < 13) return false;
  let s = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2) { n *= 2; if (n > 9) n -= 9; }
    s += n;
  }
  return s % 10 === 0;
}
function validadeOk(v) {
  const [m, a] = String(v).split("/").map(Number);
  if (!m || m > 12 || a === undefined || isNaN(a)) return false;
  const hoje = new Date();
  const ano = 2000 + a;
  return ano > hoje.getFullYear() || (ano === hoje.getFullYear() && m >= hoje.getMonth() + 1);
}

const REGRAS = {
  empresa: [
    ["cnpj", (v) => cnpjValido(v) || (digitos(v) ? "Confira o CNPJ: os números não fecham." : "Informe o CNPJ.")],
    ["razaoSocial", (v) => v.trim().length > 2 || "Informe a razão social."],
    ["cep", (v) => digitos(v).length === 8 || "O CEP tem 8 números."],
    ["numero", (v) => v.trim().length > 0 || "Informe o número."],
    ["endereco", (v) => v.trim().length > 3 || "Informe o endereço."],
    ["cidade", (v) => v.trim().length > 2 || "Informe a cidade."]
  ],
  responsavel: [
    ["representanteNome", (v) => v.trim().split(/\s+/).length >= 2 || "Escreva o nome completo."],
    ["representanteCpf", (v) => cpfValido(v) || (digitos(v) ? "Confira o CPF: os números não fecham." : "Informe o CPF.")],
    ["email", (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()) || "Confira o e-mail."],
    ["whatsapp", (v) => [10, 11].includes(digitos(v).length) || "Informe o WhatsApp com DDD."]
  ],
  cartao: [
    ["#cc-numero", (v) => luhn(v) || "Confira o número do cartão."],
    ["#cc-nome", (v) => v.trim().length > 3 || "Escreva o nome como está no cartão."],
    ["#cc-validade", (v) => validadeOk(v) || "Validade no formato MM/AA, ainda não vencida."],
    ["#cc-cvv", (v) => digitos(v).length >= 3 || "O CVV tem 3 ou 4 números."],
    ["#cc-cpf", (v) => cpfValido(v) || "Confira o CPF do titular."]
  ]
};

function mostrarErro(el, msg) {
  const label = el.closest(".campo");
  label.classList.add("com-erro");
  el.setAttribute("aria-invalid", "true");
  let aviso = $(".erro", label);
  if (!aviso) {
    aviso = document.createElement("small");
    aviso.className = "erro";
    aviso.id = `erro-${el.name || el.id}`;
    aviso.setAttribute("role", "alert");
    label.append(aviso);
    el.setAttribute("aria-describedby", aviso.id);
  }
  aviso.textContent = msg;
}
function limparErro(el) {
  const label = el.closest(".campo");
  if (!label || !label.classList.contains("com-erro")) return;
  label.classList.remove("com-erro");
  el.removeAttribute("aria-invalid");
  el.removeAttribute("aria-describedby");
  $(".erro", label)?.remove();
}
function validar(grupo) {
  let primeiro = null;
  for (const [nome, regra] of REGRAS[grupo]) {
    const el = nome.startsWith("#") ? $(nome) : campo(nome);
    const r = regra(el.value);
    if (r !== true) { mostrarErro(el, r); primeiro ??= el; }
    else limparErro(el);
  }
  if (primeiro) primeiro.focus();
  return !primeiro;
}

/* ============ preenchimento automático ============ */

let ultimoCnpj = "";
async function buscarCnpj(v) {
  const d = digitos(v);
  if (d === ultimoCnpj || !cnpjValido(d)) return;
  ultimoCnpj = d;
  try {
    const r = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${d}`);
    if (!r.ok) return;
    const e = await r.json();
    if (digitos(campo("cnpj").value) !== d) return;
    const preencher = (nome, valor) => { if (valor && !campo(nome).value.trim()) campo(nome).value = valor; };
    preencher("razaoSocial", e.razao_social);
    preencher("cep", MASCARAS.cep(e.cep));
    preencher("numero", e.numero);
    preencher("endereco", titulo([e.descricao_tipo_de_logradouro, e.logradouro].filter(Boolean).join(" ") + (e.bairro ? `, ${e.bairro}` : "")));
    preencher("cidade", e.municipio && e.uf ? `${titulo(e.municipio)} / ${e.uf}` : "");
    $(".campo .tag").hidden = false;
    $$('[data-tela="empresa"] input').forEach(limparErro);
    guardar();
  } catch { /* sem internet ou API fora: a pessoa digita */ }
}

let ultimoCep = "";
async function buscarCep(v) {
  const d = digitos(v);
  if (d === ultimoCep) return;
  ultimoCep = d;
  try {
    const r = await fetch(`https://viacep.com.br/ws/${d}/json/`);
    if (!r.ok) return;
    const e = await r.json();
    if (e.erro) return;
    campo("endereco").value = [e.logradouro, e.bairro].filter(Boolean).join(", ");
    campo("cidade").value = `${e.localidade} / ${e.uf}`;
    limparErro(campo("endereco")); limparErro(campo("cidade"));
    if (!campo("numero").value) campo("numero").focus();
    guardar();
  } catch { /* a pessoa digita */ }
}

function titulo(s) {
  return String(s).toLowerCase().replace(/(^|\s)(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
    .replace(/\s(De|Da|Do|Das|Dos|E)\s/g, (m) => m.toLowerCase());
}

function bandeiraDe(v) {
  const d = digitos(v);
  if (/^4/.test(d)) return "VISA";
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(d)) return "MASTER";
  if (/^3[47]/.test(d)) return "AMEX";
  if (/^(606282|3841)/.test(d)) return "HIPER";
  if (/^(4011|4312|4389|4514|4576|5041|5066|5067|509|6277|6362|6363|650|6516|6550)/.test(d)) return "ELO";
  return "";
}
function mostrarBandeira(v) {
  const nome = digitos(v).length >= 6 ? bandeiraDe(v) : "";
  const el = $(".bandeira");
  el.hidden = !nome;
  el.firstElementChild.textContent = nome;
}

/* ============ textos que dependem do que a pessoa digitou ============ */

function nomeCurto() {
  const nome = campo("razaoSocial").value.trim();
  return (nome === nome.toUpperCase() ? titulo(nome) : nome)
    .replace(/\s+(ltda\.?|me|epp|eireli|s\/?a\.?|ss|limitada)$/i, "").trim() || "Sua empresa";
}
function primeiroNome() { return campo("representanteNome").value.trim().split(/\s+/)[0] || ""; }

function preencherContrato() {
  $('[data-campo="razaoSocial"]').textContent = campo("razaoSocial").value.trim() || "Sua empresa";
}
function preencherFinal() {
  $('[data-campo="primeiroNome"]').textContent = primeiroNome();
  $('[data-campo="nomeCurto"]').textContent = nomeCurto();
  $('[data-campo="email"]').textContent = campo("email").value.trim();
}

/* ============ confirmação entre etapas ============ */

function marcarFeita(n) {
  const li = $(`.etapas li[data-etapa="${n}"]`);
  li.classList.add("feita"); li.classList.remove("atual");
  $(".etapas").style.setProperty("--feitas", n);
}

function confirmar(titulo, msg, prox, depois) {
  const veu = $("#confirma");
  $(".titulo", veu).textContent = titulo;
  $(".msg", veu).textContent = msg;
  $(".prox-txt", veu).textContent = prox;
  veu.hidden = false;
  veu.classList.remove("anima"); void veu.offsetWidth; veu.classList.add("anima");
  const espera = matchMedia("(prefers-reduced-motion: reduce)").matches ? 1400 : 2200;
  setTimeout(() => { veu.hidden = true; depois(); }, espera);
}

/* ============ avançar ============ */

let ocupado = false;
form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (ocupado || !$("#confirma").hidden) return;
  if (atual === "empresa") {
    if (!validar("empresa")) return;
    marcarFeita(1);
    confirmar("Empresa registrada",
      `${nomeCurto()} já está no nosso radar. Agora falta conhecer quem vai conduzir a aceleração aí dentro.`,
      "Próximo: Responsável", () => mostrarTela("responsavel"));
  } else if (atual === "responsavel") {
    if (!validar("responsavel")) return;
    marcarFeita(2);
    confirmar(`Tudo certo, ${primeiroNome()}`,
      "Já deixamos o contrato preenchido com os seus dados. Confira e assine na próxima etapa.",
      "Próximo: Contrato", () => mostrarTela("contrato"));
  } else if (atual === "contrato") {
    assinar();
  } else if (atual === "pagamento" && forma === "cartao") {
    if (!validar("cartao")) return;
    pagarCartao();
  }
});

function assinar() {
  if (MODO_DEMONSTRACAO) {
    contratoAssinado();
    return;
  }
  // produção: Code.gs gera o PDF, cria o documento na Autentique, assina pelo
  // Benedito e devolve o link exclusivo do cliente, que abre em #janela-aut.
}
function contratoAssinado() {
  marcarFeita(3);
  confirmar("Contrato assinado",
    `Pronto, ${primeiroNome()}. As duas assinaturas estão registradas na Autentique e a cópia vai para o seu e-mail. Só falta garantir a vaga.`,
    "Próximo: Pagamento", () => mostrarTela("pagamento"));
}

function pagarCartao() {
  const btn = $('[data-acao="avancar"]');
  ocupado = true;
  btn.disabled = true;
  btn.innerHTML = `${svg("cadeado")}Processando...`;
  // produção: o SDK da PicPay transforma o cartão em token e o Code.gs cobra.
  setTimeout(() => {
    ocupado = false;
    btn.disabled = false;
    ["#cc-numero", "#cc-nome", "#cc-validade", "#cc-cvv", "#cc-cpf"].forEach((s) => ($(s).value = ""));
    mostrarTela("final");
  }, MODO_DEMONSTRACAO ? 1200 : 0);
}

$('[data-acao="voltar"]').addEventListener("click", () => {
  const i = TELAS.indexOf(atual);
  if (i > 0 && i < 3) mostrarTela(TELAS[i - 1]);
});
$$("[data-forma]").forEach((b) => b.addEventListener("click", () => trocarForma(b.dataset.forma)));
$(".copia button").addEventListener("click", async (ev) => {
  try {
    await navigator.clipboard.writeText($(".copia .codigo").textContent.trim());
    ev.currentTarget.textContent = "Copiado";
    setTimeout(() => (ev.currentTarget.textContent = "Copiar"), 2000);
  } catch { /* navegador sem permissão de copiar */ }
});
$('[data-acao="fechar-aut"]').addEventListener("click", () => {
  $("#janela-aut").hidden = true;
  document.body.classList.remove("com-janela");
});

/* ============ recarregar não perde o que já foi digitado ============ */
// Só os dados da empresa e do responsável, nunca o cartão.

const CHAVE = "fast-start-inscricao";
const GUARDADOS = ["cnpj", "razaoSocial", "cep", "numero", "endereco", "cidade", "representanteNome", "representanteCpf", "email", "whatsapp"];
function guardar() {
  if (params.has("estado") || params.has("exemplo")) return;
  try {
    if (atual === "final") { sessionStorage.removeItem(CHAVE); return; }
    const dados = Object.fromEntries(GUARDADOS.map((n) => [n, campo(n).value]));
    sessionStorage.setItem(CHAVE, JSON.stringify({ dados, tela: atual }));
  } catch { /* navegação privada sem armazenamento */ }
}
function recuperar() {
  try {
    const salvo = JSON.parse(sessionStorage.getItem(CHAVE) || "null");
    if (!salvo) return "empresa";
    GUARDADOS.forEach((n) => (campo(n).value = salvo.dados[n] || ""));
    return TELAS.includes(salvo.tela) && salvo.tela !== "final" ? salvo.tela : "empresa";
  } catch { return "empresa"; }
}

/* ============ pré-visualização por endereço (conferência visual) ============ */

const PREVIA = {
  "empresa": { tela: "empresa" },
  "confirma-1": { tela: "empresa", confirma: ["Empresa registrada", "A Sol do Norte já está no nosso radar. Agora falta conhecer quem vai conduzir a aceleração aí dentro.", "Próximo: Responsável"] },
  "responsavel": { tela: "responsavel" },
  "contrato": { tela: "contrato" },
  "autentique": { tela: "contrato", autentique: true },
  "contrato-assinado": { tela: "contrato", confirma: ["Contrato assinado", "Pronto, Mariana. As duas assinaturas estão registradas na Autentique e a cópia vai para o seu e-mail. Só falta garantir a vaga.", "Próximo: Pagamento"], feitas: 3 },
  "cartao": { tela: "pagamento", forma: "cartao" },
  "pix": { tela: "pagamento", forma: "pix" },
  "final": { tela: "final" }
};
const EXEMPLO = {
  cnpj: "12.345.678/0001-90", razaoSocial: "Sol do Norte Energia Ltda", cep: "66055-100", numero: "216",
  endereco: "Av. Visconde de Souza Franco, Umarizal", cidade: "Belém / PA",
  representanteNome: "Mariana Costa Albuquerque", representanteCpf: "123.456.789-00",
  email: "mariana@soldonorte.com.br", whatsapp: "(91) 9 8123-4567",
  "#cc-numero": "4111 1111 1111 1111", "#cc-nome": "MARIANA C ALBUQUERQUE", "#cc-validade": "08/29",
  "#cc-cvv": "•••", "#cc-cpf": "123.456.789-00"
};

const params = new URLSearchParams(location.search);
if (params.has("exemplo")) {
  for (const [chave, valor] of Object.entries(EXEMPLO)) {
    const el = chave.startsWith("#") ? $(chave) : campo(chave);
    if (el) el.value = valor;
  }
  $(".campo .tag").hidden = false;
  mostrarBandeira(EXEMPLO["#cc-numero"]);
}
const previa = PREVIA[params.get("estado")];
if (previa) {
  if (previa.forma) trocarForma(previa.forma);
  mostrarTela(previa.tela, { focar: false });
  if (previa.feitas) $(".etapas").style.setProperty("--feitas", previa.feitas);
  if (previa.confirma) {
    const veu = $("#confirma");
    [$(".titulo", veu).textContent, $(".msg", veu).textContent, $(".prox-txt", veu).textContent] = previa.confirma;
    veu.hidden = false;
  }
  if (previa.autentique) { $("#janela-aut").hidden = false; document.body.classList.add("com-janela"); }
} else {
  mostrarTela(recuperar(), { focar: false });
}
