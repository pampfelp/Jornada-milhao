const CACHE_NAME = "jm-v6";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./auth.js",
  "./firebase-init.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first com fallback pro cache (abre mesmo offline/instável), mas
// NUNCA cacheia chamadas ao Firestore (precisa sempre de dados frescos, usa
// conexões de streaming de longa duração) nem ao Apps Script (Agenda/PDF).
//
// "no-store" no fetch é essencial aqui: sem isso, "network-first" só evita
// o Cache API do service worker — o navegador ainda pode responder o
// fetch() com uma cópia do CACHE HTTP comum dele (o do GitHub Pages),
// nunca batendo na rede de verdade. Foi exatamente isso que fez o sistema
// gerar um contrato com o texto do modelo ANTIGO mesmo depois do app.js já
// ter sido atualizado — o "network-first" não estava realmente indo pra
// rede.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.hostname.endsWith("googleapis.com") || url.hostname.includes("script.google.com")) return;
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request, { cache: "no-store" })
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// ── Lembretes de cobrança (2026-11-03) ──
// O Code.gs (cobrancaRotina) manda pelo Firebase Cloud Messaging uma
// mensagem só de dados: titulo, corpo, url (o WhatsApp do mentorado com a
// mensagem pronta), tag e, no lembrete, parcelaId/dia/assinatura. Quem
// desenha a notificação é este arquivo, sem o SDK do Firebase aqui dentro.
// Mesma URL de APPS_SCRIPT_PROXY_URL, em firebase-init.js.
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzdJNroawGvXFRMELv_VeLqVTkENBtq6Veou3n3nST5vjjiNqF70L-r-ZLFNT-GupRN_w/exec";

self.addEventListener("push", (event) => {
  let d = {};
  try {
    const j = event.data ? event.data.json() : {};
    d = j.data || j.notification || j;
  } catch (e) { d = {}; }
  event.waitUntil(self.registration.showNotification(d.titulo || "Jornada do Milhão", {
    body: d.corpo || "",
    icon: "icon-192.png",
    badge: "icon-192.png",
    tag: d.tag || undefined,
    data: { url: d.url || "./", parcelaId: d.parcelaId || "", dia: d.dia || "", assinatura: d.assinatura || "" }
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const dados = event.notification.data || {};
  const alvo = new URL(dados.url || "./", self.registration.scope).href;
  // O toque conta como o contato do dia: a próxima notificação de hoje não
  // sai pra esta parcela, e a mensagem de amanhã já diz "contato nº N".
  const registro = dados.parcelaId
    ? fetch(APPS_SCRIPT_URL, { method: "POST", mode: "no-cors", body: JSON.stringify({ action: "cobRegistrarPush", parcelaId: dados.parcelaId, dia: dados.dia, assinatura: dados.assinatura }) }).catch(() => {})
    : Promise.resolve();
  event.waitUntil(Promise.all([self.clients.openWindow(alvo), registro]));
});
