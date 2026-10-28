// Verificação local do Pix do checkout, sem rede e sem criar cobranças.
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const checkout = new URL("../checkout.js", import.meta.url);
const fonte = fs.readFileSync(checkout, "utf8");
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../checkout.css", import.meta.url), "utf8");
const trecho = fonte.slice(fonte.indexOf("let pagamento = null;"), fonte.indexOf("function esperarRetorno()"));
const elementos = Object.fromEntries([".qr", ".copia", ".copia .codigo", ".copia button", ".espera"].map((seletor) => [seletor, {
  innerHTML: "", textContent: "", hidden: false, disabled: false,
  classList: { remove() {}, add() {} },
  addEventListener(tipo, funcao) { this[tipo] = funcao; }
}]));
let chamadas = 0, resolver, rejeitar, consulta, ciclo, aviso = "", qrGerados = 0, copiado = "", scriptQr;
const fabricaQr = () => ({ addData() { qrGerados++; }, make() {}, createSvgTag() { return "<svg></svg>"; } });
const contexto = vm.createContext({
  TextEncoder, Promise, Map, Error, Date, MODO_DEMONSTRACAO: false,
  inscricao: () => ({ chave: "mock-local" }), $: (seletor) => elementos[seletor],
  avisar: (texto) => { aviso = texto; }, mostrarTela: () => {}, fecharConfirmando: () => {},
  chamar: (acao) => {
    if (acao === "fsStatus") return consulta();
    assert.equal(acao, "fsPagamento"); chamadas++;
    return new Promise((resolve, reject) => { resolver = resolve; rejeitar = reject; });
  },
  window: { qrcode: fabricaQr },
  document: { createElement: () => ({ remove() {} }), head: { append(script) { scriptQr = script; } } },
  navigator: { clipboard: { async writeText(texto) { copiado = texto; } } },
  setInterval(funcao) { ciclo = funcao; return 1; }, clearInterval() {}, setTimeout() {}
});
const executar = (codigo) => vm.runInContext(codigo, contexto);
const aguardar = () => new Promise(setImmediate);
executar(trecho);

// BRCode sintético com endereço reservado: não aponta para cobrança real.
const tlv = (id, valor) => id + String(valor.length).padStart(2, "0") + valor;
function checksum(texto) {
  let crc = 0xffff;
  for (const byte of new TextEncoder().encode(texto)) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  return crc.toString(16).padStart(4, "0").toUpperCase();
}
const base = tlv("00", "01") + tlv("26", tlv("00", "br.gov.bcb.pix") + tlv("25", "example.invalid/mock"))
  + tlv("52", "0000") + tlv("53", "986") + tlv("58", "BR") + tlv("59", "TESTE") + tlv("60", "TESTE") + "6304";
contexto.valido = base + checksum(base);
assert.equal(executar("brcodeValido(valido)"), true);
for (const invalido of ["", "000201...", contexto.valido.slice(0, -2), contexto.valido.slice(0, -1) + (contexto.valido.endsWith("0") ? "1" : "0"), "0002XX" + contexto.valido.slice(6)]) {
  contexto.invalido = invalido;
  assert.equal(executar("brcodeValido(invalido)"), false);
}

const primeira = executar("prepararPagamento()");
assert.equal(primeira, executar("prepararPagamento()"));
assert.equal(chamadas, 1);
assert.equal(elementos[".copia button"].disabled, true);
assert.equal(elementos[".qr"].hidden, true);
assert.match(elementos[".espera"].textContent, /Preparando/);
rejeitar(new Error("403"));
assert.equal(await primeira, null);
assert.equal(elementos[".qr"].innerHTML, "");
assert.equal(elementos[".copia button"].disabled, true);
assert.doesNotMatch(elementos[".espera"].textContent, /Aguardando/);
assert.match(aviso, /403/);
assert.doesNotMatch(aviso, /instantes/);
executar("vigiarPagamento(5000, 0)");
assert.equal(ciclo, undefined, "não consulta sem cobrança preparada");

const segunda = executar("prepararPagamento()");
assert.equal(chamadas, 2);
resolver({ brcode: contexto.valido, link: "mock-local" });
assert.ok(await segunda);
await aguardar();
assert.equal(elementos[".copia button"].disabled, false);
assert.equal(elementos[".qr"].hidden, false);
assert.equal(qrGerados, 1);
assert.match(elementos[".espera"].textContent, /Aguardando/);
await executar("prepararPagamento()");
assert.equal(chamadas, 2, "reutiliza a cobrança preparada");

consulta = async () => { throw new Error("consulta indisponível"); };
executar("vigiarPagamento(5000, 0)");
await ciclo();
assert.match(elementos[".espera"].textContent, /Não foi possível consultar/);
consulta = async () => ({ pago: false });
await ciclo();
assert.match(elementos[".espera"].textContent, /Aguardando/);

const copia = fonte.slice(fonte.indexOf('$(".copia button").addEventListener'), fonte.indexOf("$('[data-acao=\"fechar-aut\"]')"));
executar(copia);
elementos[".copia .codigo"].textContent = "DOM alterado";
await elementos[".copia button"].click({ currentTarget: elementos[".copia button"] });
assert.equal(copiado, contexto.valido, "copia o valor validado, sem ler o DOM");
executar('limparPix("Falha de criação")');
copiado = "";
await elementos[".copia button"].click({ currentTarget: elementos[".copia button"] });
assert.equal(copiado, "");
await ciclo();
assert.equal(elementos[".espera"].textContent, "Falha de criação", "consulta não apaga falha da criação");

executar('bibliotecaQr = null; window.qrcode = undefined; desenharPix(valido)');
scriptQr.onerror();
await aguardar();
assert.equal(elementos[".qr"].hidden, true);
assert.equal(elementos[".qr"].innerHTML, "");
assert.equal(elementos[".copia button"].disabled, true);
contexto.window.qrcode = () => { throw new Error("falha ao desenhar"); };
executar("desenharPix(valido)");
await aguardar();
assert.equal(elementos[".qr"].hidden, true);
assert.equal(elementos[".copia button"].disabled, true);
contexto.window.qrcode = fabricaQr;
await executar("prepararPagamento()");
await aguardar();
assert.equal(elementos[".qr"].hidden, false);
contexto.MODO_DEMONSTRACAO = true;
await executar("prepararPagamento()");
assert.match(elementos[".espera"].textContent, /Demonstração/);
assert.equal(elementos[".copia button"].disabled, true);
assert.equal(elementos[".qr"].hidden, true);
assert.equal(chamadas, 2);

assert.doesNotMatch(html, /00020126580014/);
assert.doesNotMatch(css, /qr-demonstracao/);
assert.match(css, /\[hidden\]\s*\{\s*display\s*:\s*none\s*!important\s*\}/);
assert.doesNotMatch(css, /\.(?:qr|copia)[^{]*\{[^}]*display\s*:[^;}]*!important/);
assert.match(fonte, /if \(p && atual === "pagamento" && forma === "pix"\) vigiarPagamento/);
console.log("OK: BRCode, CRC, 403, deduplicação, retry, cache, cópia, status e recuperação, falhas QR, demonstração e CSS hidden. Sem rede.");
