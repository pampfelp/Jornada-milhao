import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import worker from "./worker.mjs";

const originalFetch = globalThis.fetch;
const env = { BRIDGE_KEY: "segredo-ficticio-do-teste" };
let chamadas = [];
let statusUpstream = 201;
globalThis.fetch = async (url, options) => {
  chamadas.push({ url, options });
  return Response.json({ link: "https://exemplo.invalid/p/teste" }, { status: statusUpstream });
};
const pedido = (path = "/paymentlink/create", overrides = {}) => new Request("https://ponte.invalid" + path, {
  method: "POST", headers: { "X-Bridge-Key": env.BRIDGE_KEY, Authorization: "Bearer token-ficticio", "Content-Type": "application/json" },
  body: "{}", ...overrides
});
try {
  assert.equal((await worker.fetch(pedido(), {})).status, 503);
  assert.equal((await worker.fetch(pedido("/paymentlink/create", { headers: {} }), env)).status, 401);
  for (const path of ["/oauth2/token", "/paymentlink/create?destino=outro", "/paymentlink/outro/refund", "/https://outro.invalid"]) {
    assert.equal((await worker.fetch(pedido(path), env)).status, 404);
  }
  assert.equal(chamadas.length, 0);
  assert.equal((await worker.fetch(pedido("/paymentlink/create", { body: "invalido" }), env)).status, 400);
  assert.equal((await worker.fetch(pedido("/paymentlink/create", { body: " ".repeat(65537) }), env)).status, 413);
  const resposta = await worker.fetch(pedido(), env);
  assert.equal(resposta.status, 201);
  assert.equal(chamadas[0].url, "https://ecommerce-api.svc.picpay.com/v1/paymentlink/create");
  assert.equal(chamadas[0].options.headers["User-Agent"], "JornadaCheckout/1.0");
  assert.equal(chamadas[0].options.headers["X-Bridge-Key"], undefined);
  assert.equal(chamadas[0].options.redirect, "manual");
  assert.equal(resposta.headers.get("Access-Control-Allow-Origin"), null);
  for (const [path, method] of [["/paymentlink/id-123/transactions", "GET"], ["/paymentlink/id-123/inactive", "POST"]]) {
    assert.equal((await worker.fetch(pedido(path, { method, body: method === "GET" ? undefined : "{}" }), env)).status, 201);
  }
  statusUpstream = 403;
  assert.equal((await worker.fetch(pedido(), env)).status, 403);
  statusUpstream = 302;
  assert.equal((await worker.fetch(pedido(), env)).status, 502);
  globalThis.fetch = async () => { throw new Error("rede"); };
  assert.equal((await worker.fetch(pedido(), env)).status, 502);
} finally { globalThis.fetch = originalFetch; }

const gs = fs.readFileSync(new URL("../../Code.gs", import.meta.url), "utf8");
const extrair = (nome) => {
  const inicio = gs.indexOf("function " + nome + "(");
  const fim = gs.indexOf("\nfunction ", inicio + 1);
  return gs.slice(inicio, fim === -1 ? undefined : fim);
};
let ambiente = "producao";
let propriedades = {};
let respostaStatus = 200;
let respostaJson = { transactions: [] };
let destino;
const contexto = {
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => propriedades[k] }) },
  picpayConfig_: () => ({ ambiente, urlApi: "https://ecommerce-api.svc.picpay.com/v1" }),
  picpayToken_: () => "token-ficticio", PICPAY_USER_AGENT_: "JornadaCheckout/1.0",
  UrlFetchApp: { fetch: (url, opcoes) => {
    destino = { url, opcoes };
    return { getResponseCode: () => respostaStatus, getContentText: () => JSON.stringify(respostaJson) };
  } },
  console: { error() {} }
};
vm.createContext(contexto);
vm.runInContext(extrair("picpay_") + extrair("fsConferirPagamento_"), contexto);
contexto.picpay_("get", "/paymentlink/teste/transactions", null, ambiente);
assert.equal(destino.url, "https://ecommerce-api.svc.picpay.com/v1/paymentlink/teste/transactions");
propriedades = { PICPAY_PROXY_URL: "https://ponte.invalid/", PICPAY_PROXY_SECRET: "ficticio" };
contexto.picpay_("get", "/paymentlink/teste/transactions", null, ambiente);
assert.equal(destino.url, "https://ponte.invalid/paymentlink/teste/transactions");
assert.equal(destino.opcoes.headers["X-Bridge-Key"], "ficticio");
assert.equal(destino.opcoes.followRedirects, false);
ambiente = "sandbox";
contexto.picpay_("get", "/paymentlink/teste/transactions", null, ambiente);
assert.equal(destino.opcoes.headers["X-Bridge-Key"], undefined);
ambiente = "producao";
propriedades = { PICPAY_PROXY_URL: "https://ponte.invalid" };
assert.throws(() => contexto.picpay_("get", "/paymentlink/teste/transactions", null, ambiente), /incompleta/);
propriedades = {};
const inscricao = { linkId: "teste", ambiente, status: "aguardando_pagamento" };
assert.equal(contexto.fsConferirPagamento_("teste", inscricao), false);
respostaStatus = 403;
assert.throws(() => contexto.fsConferirPagamento_("teste", inscricao), /consultar/);
respostaStatus = 200; respostaJson = {};
assert.throws(() => contexto.fsConferirPagamento_("teste", inscricao), /consultar/);
console.log("PASSOU: ponte autenticada/restrita, transporte produção/sandbox e falha de consulta distinta de pagamento pendente. Nenhuma API chamada.");
