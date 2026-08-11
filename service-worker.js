const CACHE_NAME = "jm-v4";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
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
