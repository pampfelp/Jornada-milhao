// Inicialização do Firebase — via CDN (ESM), sem bundler, sem etapa de
// build.
//
// Firestore é o banco de dados deste sistema. Além disso, este projeto usa
// um Apps Script mínimo (Code.gs) como proxy de 2 APIs externas: Google
// Agenda (Funil de Agendamento) e geração de PDF de contrato — nunca como
// banco de dados. Veja o README para o passo a passo de implantação do
// Code.gs.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager, connectFirestoreEmulator
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

// TROQUE pela config do SEU projeto (Firebase Console > Configurações do
// projeto > seus apps > app Web > "Config"). Essas chaves são públicas por
// design no Firebase Web — a segurança vem das regras (firestore.rules),
// não de esconder essa config.
const firebaseConfig = {
  apiKey: "AIzaSyD2ud5FQsbZeWp8Yh9tIN4W1Nlr60je3dQ",
  authDomain: "financeirojornadamilhao.firebaseapp.com",
  projectId: "financeirojornadamilhao",
  storageBucket: "financeirojornadamilhao.firebasestorage.app",
  messagingSenderId: "256752517394",
  appId: "1:256752517394:web:b32d92e68ab095c427b3cb"
};

export const firebaseApp = initializeApp(firebaseConfig);

// Cache local persistente (IndexedDB) — dados já sincronizados continuam
// disponíveis mesmo se a internet cair no meio do uso, e escritas feitas
// offline ficam na fila e sobem sozinhas quando a conexão volta (o
// indicador de sincronização, bolinha amarela, mostra isso acontecendo).
// "MultipleTabManager" permite abrir o sistema em mais de uma aba ao mesmo
// tempo sem uma brigar com a outra pelo cache. Se o navegador não suportar
// IndexedDB nesse contexto (raro — ex.: aba anônima em navegador antigo),
// cai pra memória (comportamento de antes, sem persistência) em vez de
// quebrar o carregamento do app.
let db;
try {
  db = initializeFirestore(firebaseApp, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
  });
} catch (err) {
  console.warn("[firebase] cache persistente indisponível nesse navegador, usando memória:", err.message);
  db = getFirestore(firebaseApp);
}
export { db };

// Por padrão, sempre conecta no projeto Firestore REAL (mesmo testando
// local ou pela hospedagem) — assim dá pra testar sem precisar rodar
// nenhum emulador. Só usa o emulador local se a página abrir com
// "?emulator=1" na URL (ex: http://localhost:8000/?emulator=1).
if (new URLSearchParams(location.search).has("emulator")) {
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  console.log("[firebase] usando emulador local do Firestore (:8080)");
}

// ══════════════ APPS SCRIPT (proxy de Agenda + geração de PDF) ══════════════
// URL da implantação do Code.gs (Apps Script Web App). TROQUE pela URL
// "/exec" que você copiar ao implantar o Code.gs (veja o README, seção
// "Apps Script").
export const APPS_SCRIPT_PROXY_URL = "https://script.google.com/macros/s/AKfycbzdJNroawGvXFRMELv_VeLqVTkENBtq6Veou3n3nST5vjjiNqF70L-r-ZLFNT-GupRN_w/exec";
