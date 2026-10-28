// Ponte privada Apps Script -> PicPay. Não recebe client_secret nem grava tokens.
const ORIGEM = "https://ecommerce-api.svc.picpay.com/v1";
const USER_AGENT = "JornadaCheckout/1.0";

function erro(status, mensagem) {
  return Response.json({ error: { message: mensagem } }, {
    status, headers: { "Cache-Control": "no-store" }
  });
}

export default {
  async fetch(request, env) {
    if (!env.BRIDGE_KEY) return erro(503, "Ponte não configurada.");
    if (request.headers.get("X-Bridge-Key") !== env.BRIDGE_KEY) return erro(401, "Não autorizado.");
    const url = new URL(request.url);
    const caminho = url.pathname;
    const permitido = !url.search && (
      (request.method === "POST" && caminho === "/paymentlink/create") ||
      (request.method === "GET" && /^\/paymentlink\/[A-Za-z0-9_-]+\/transactions$/.test(caminho)) ||
      (request.method === "POST" && /^\/paymentlink\/[A-Za-z0-9_-]+\/inactive$/.test(caminho))
    );
    if (!permitido) return erro(404, "Operação não permitida.");
    const autorizacao = request.headers.get("Authorization") || "";
    if (!/^Bearer \S+$/.test(autorizacao)) return erro(401, "Token PicPay ausente.");
    let corpo;
    if (request.method === "POST") {
      corpo = await request.text();
      if (corpo.length > 65536) return erro(413, "Pedido muito grande.");
      try { JSON.parse(corpo); } catch { return erro(400, "JSON inválido."); }
    }
    try {
      const resposta = await fetch(ORIGEM + caminho, {
        method: request.method, redirect: "manual",
        headers: {
          Authorization: autorizacao, Accept: "application/json",
          "Content-Type": "application/json", "User-Agent": USER_AGENT
        },
        ...(corpo === undefined ? {} : { body: corpo })
      });
      if (resposta.status >= 300 && resposta.status < 400) return erro(502, "Redirecionamento inesperado da PicPay.");
      return new Response(resposta.body, {
        status: resposta.status,
        headers: {
          "Content-Type": resposta.headers.get("Content-Type") || "application/json",
          "Cache-Control": "no-store"
        }
      });
    } catch {
      return erro(502, "Não foi possível acessar a PicPay.");
    }
  }
};
