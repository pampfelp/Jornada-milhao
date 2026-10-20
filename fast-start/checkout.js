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
  cadeado: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  fora: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'
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
    botao = ["fora", "Pagar com cartão", "dir"];
    texto = forma === "cartao" ? "Processado pela PicPay. O cartão não passa pelo nosso site." : "Pagamento processado pela PicPay.";
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
  whatsapp: (v) => mascarar(v, digitos(v).length > 10 ? "(##) # ####-####" : "(##) ####-####")
};
form.addEventListener("input", (ev) => {
  const el = ev.target;
  const chave = el.name || el.id;
  if (MASCARAS[chave]) el.value = MASCARAS[chave](el.value);
  limparErro(el);
  if (chave === "cnpj" && digitos(el.value).length === 14) buscarCnpj(el.value);
  if (chave === "cnpj") $(".campo .tag").hidden = true;
  if (chave === "cep" && digitos(el.value).length === 8) buscarCep(el.value);
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
  if (MODO_DEMONSTRACAO) {
    confirmandoPagamento();
    setTimeout(() => { fecharConfirmando(); mostrarTela("final"); }, 1800);
    return;
  }
  // produção: o Code.gs cria o Link de Pagamento (cartão até 12x) com
  // redirect_url pra esta página e devolve o link; a pessoa vai até a PicPay
  // e volta com ?retorno=..., quando confirmandoPagamento() espera o status.
}

function confirmandoPagamento() {
  const veu = $("#confirma");
  veu.classList.add("aguardando");
  $(".titulo", veu).textContent = "Confirmando seu pagamento";
  $(".msg", veu).textContent = "Você voltou da PicPay. Assim que o pagamento for confirmado, sua vaga aparece aqui. Leva alguns segundos.";
  veu.hidden = false;
}
function fecharConfirmando() {
  const veu = $("#confirma");
  veu.hidden = true;
  veu.classList.remove("aguardando");
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
  "confirmando": { tela: "pagamento", forma: "cartao", confirmando: true },
  "final": { tela: "final" }
};
const EXEMPLO = {
  cnpj: "12.345.678/0001-90", razaoSocial: "Sol do Norte Energia Ltda", cep: "66055-100", numero: "216",
  endereco: "Av. Visconde de Souza Franco, Umarizal", cidade: "Belém / PA",
  representanteNome: "Mariana Costa Albuquerque", representanteCpf: "123.456.789-00",
  email: "mariana@soldonorte.com.br", whatsapp: "(91) 9 8123-4567"
};

const params = new URLSearchParams(location.search);
if (params.has("exemplo")) {
  for (const [chave, valor] of Object.entries(EXEMPLO)) {
    const el = chave.startsWith("#") ? $(chave) : campo(chave);
    if (el) el.value = valor;
  }
  $(".campo .tag").hidden = false;
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
  if (previa.confirmando) confirmandoPagamento();
  if (previa.autentique) { $("#janela-aut").hidden = false; document.body.classList.add("com-janela"); }
} else {
  mostrarTela(recuperar(), { focar: false });
}
