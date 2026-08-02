// Jornada do Milhão — lógica do app. Firestore em tempo real (onSnapshot),
// sem Cloud Functions. Ver README.md para as decisões tomadas nas perguntas
// em aberto do plano original (plano_financeiro_funil.md).

import { db, APPS_SCRIPT_PROXY_URL } from "./firebase-init.js";
import {
  collection, addDoc, updateDoc, deleteDoc, doc, setDoc,
  onSnapshot, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

const STATE = {
  clientes: [],
  agendamentos: [],
  etapasVenda: [],
  oportunidades: [],
  contratos: [],
  parcelas: [],
  despesas: [],
  etapasAdmin: [],
  cardsAdmin: [],
  config: {},
  periodoFinanceiro: new Date().toISOString().slice(0, 7)
};

const COLUNAS_AGENDAMENTO = [
  { id: "agendado", nome: "Agendado" },
  { id: "realizado", nome: "Realizado" },
  { id: "reagendado", nome: "Reagendado" },
  { id: "nao-veio", nome: "Não veio" }
];

let pendingContratoOportunidadeId = null;
let pendingContratoEtapaFechamentoId = null;
let pendingPerdaId = null;
let lancandoRecorrentes = false;
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

function addDias(dataStr, dias) {
  const d = new Date(dataStr + "T12:00:00");
  d.setDate(d.getDate() + Number(dias || 0));
  return d.toISOString().slice(0, 10);
}

function diasNoMes(ano, mes) {
  return new Date(ano, mes, 0).getDate();
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
  if (kbLongPress && kbLongPress.pointerId === e.pointerId) kbCancelLongPress();
  const st = kbState;
  if (!st || st.pointerId !== e.pointerId) return;
  kbState = null;
  kbStopAutoScroll();
  if (!st.dragging) return;
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
        pointerId, startX: clientX, startY: clientY,
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

/* ══════════════ FUNIL DE AGENDAMENTO ══════════════ */

function renderCardAgendamento(a) {
  const podeConverter = a.status === "realizado" && !a.convertido;
  return `
    <div class="kcard-nome">${esc(a.clienteNome)}</div>
    <div class="kcard-sub">${esc(a.telefone || "")}</div>
    <div class="kcard-foot">
      <span class="kcard-prazo">${fmtData(a.data)} ${esc(a.hora || "")}</span>
      <button class="btn-small" data-kcard-action title="Excluir" onclick="window.__jm.excluirAgendamento('${a.id}')">🗑</button>
    </div>
    ${podeConverter ? `<button class="btn btn-primary" style="margin-top:8px;width:100%;padding:8px;font-size:12px;" data-kcard-action onclick="window.__jm.converterEmOportunidade('${a.id}')">→ Converter em oportunidade</button>` : ""}
    ${a.convertido ? `<div class="sublabel" style="margin-top:6px;">✔ Convertido em oportunidade</div>` : ""}
  `;
}

function renderKanbanAgendamento() {
  renderKanban("kanban-agendamento", "agendamento", COLUNAS_AGENDAMENTO, STATE.agendamentos, (a) => a.status, renderCardAgendamento);
}

async function moverAgendamento(id, novoStatus) {
  const ag = STATE.agendamentos.find((a) => a.id === id);
  if (!ag || ag.status === novoStatus) return;
  try {
    await updateDoc(doc(db, "agendamentos", id), { status: novoStatus, updatedAt: serverTimestamp() });
    await addDoc(collection(db, "agendamentos", id, "historico"), { tipo: "mudanca_status", para: novoStatus, timestamp: serverTimestamp() });
  } catch (err) { mostrarErro("Não foi possível mover: " + err.message); }
}

async function converterEmOportunidade(agendamentoId) {
  const ag = STATE.agendamentos.find((a) => a.id === agendamentoId);
  if (!ag || ag.convertido) return;
  const primeiraEtapa = [...STATE.etapasVenda].sort((a, b) => a.ordem - b.ordem)[0];
  if (!primeiraEtapa) { mostrarErro("Cadastre ao menos uma etapa do Funil de Vendas em Configurações."); return; }
  try {
    await addDoc(collection(db, "oportunidades"), {
      clienteId: ag.clienteId || null, clienteNome: ag.clienteNome, telefone: ag.telefone || "",
      agendamentoId: ag.id, etapa: primeiraEtapa.id, valorProposto: 0, observacoes: "",
      perdida: false, motivoPerda: "", fechada: false,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    });
    await updateDoc(doc(db, "agendamentos", agendamentoId), { convertido: true });
    mostrarToast("Oportunidade criada no Funil de Vendas.");
  } catch (err) { mostrarErro("Não foi possível converter: " + err.message); }
}

async function excluirAgendamento(id) {
  if (!confirm("Excluir este agendamento?")) return;
  try { await deleteDoc(doc(db, "agendamentos", id)); } catch (err) { mostrarErro(err.message); }
}

document.getElementById("btn-sync-agenda").addEventListener("click", sincronizarAgenda);
async function sincronizarAgenda() {
  const from = addDias(hojeStr(), -7) + "T00:00:00";
  const to = addDias(hojeStr(), 60) + "T23:59:59";
  try {
    const calendarId = STATE.config.calendarioAgendaId || undefined;
    const resp = await chamarAppsScript("listarEventosAgenda", { from, to, calendarId });
    let criados = 0, atualizados = 0;
    const processadosNestaSincronizacao = new Set();
    for (const ev of resp.eventos || []) {
      const inicio = new Date(ev.inicio);
      const dataStr = inicio.toISOString().slice(0, 10);
      const horaStr = inicio.toTimeString().slice(0, 5);
      const clienteNome = ev.titulo || "Sem título";

      // Eventos recorrentes compartilham o mesmo googleEventId em TODAS as
      // ocorrências (limitação do CalendarApp do Apps Script) — sem isso,
      // uma série semanal colapsaria num único card que ficaria "pulando"
      // de data a cada sincronização, marcado como reagendado sem parar.
      // Pra série recorrente, a chave real de uma ocorrência é (id + data).
      // Pra evento único, o id sozinho já identifica a ocorrência — e ASSIM
      // uma mudança de data nele é reagendamento de verdade.
      const chave = ev.recorrente ? `${ev.googleEventId}|${dataStr}` : ev.googleEventId;
      if (processadosNestaSincronizacao.has(chave)) continue;
      processadosNestaSincronizacao.add(chave);

      const existente = STATE.agendamentos.find((a) => a.googleEventId === chave);
      if (!existente) {
        await addDoc(collection(db, "agendamentos"), {
          clienteId: null, clienteNome, telefone: "", data: dataStr, hora: horaStr,
          status: "agendado", origem: "agenda", googleEventId: chave,
          observacoes: ev.descricao || "", convertido: false,
          createdAt: serverTimestamp(), updatedAt: serverTimestamp()
        });
        criados++;
      } else if (existente.data !== dataStr || existente.hora !== horaStr) {
        await updateDoc(doc(db, "agendamentos", existente.id), {
          data: dataStr, hora: horaStr, status: "reagendado", updatedAt: serverTimestamp()
        });
        atualizados++;
      }
    }
    mostrarToast(`Agenda sincronizada: ${criados} novo(s), ${atualizados} reagendado(s).`);
  } catch (err) {
    mostrarErro("Não foi possível sincronizar a Agenda: " + err.message);
  }
}

document.getElementById("btn-novo-agendamento").addEventListener("click", () => {
  document.getElementById("ma-cliente").value = "";
  document.getElementById("ma-telefone").value = "";
  document.getElementById("ma-data").value = hojeStr();
  document.getElementById("ma-hora").value = "";
  document.getElementById("ma-obs").value = "";
  abrirModal("modal-agendamento");
});
document.getElementById("btn-salvar-agendamento").addEventListener("click", async () => {
  const clienteNome = document.getElementById("ma-cliente").value.trim();
  if (!clienteNome) { mostrarErro("Informe o nome do cliente."); return; }
  try {
    await addDoc(collection(db, "agendamentos"), {
      clienteId: null, clienteNome,
      telefone: document.getElementById("ma-telefone").value.trim(),
      data: document.getElementById("ma-data").value || hojeStr(),
      hora: document.getElementById("ma-hora").value || "",
      status: "agendado", origem: "manual", googleEventId: null, convertido: false,
      observacoes: document.getElementById("ma-obs").value.trim(),
      createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    });
    fecharModal("modal-agendamento");
    mostrarToast("Agendamento criado.");
  } catch (err) { mostrarErro(err.message); }
});

/* ══════════════ FUNIL DE VENDAS ══════════════ */

function colunasVendas() {
  const cfg = [...STATE.etapasVenda].sort((a, b) => a.ordem - b.ordem).map((e) => ({ id: e.id, nome: e.nome }));
  cfg.push({ id: "perdido", nome: "❌ Perdido" });
  return cfg;
}

function renderCardOportunidade(o) {
  return `
    <div class="kcard-nome">${esc(o.clienteNome)}</div>
    <div class="kcard-sub">${esc(o.telefone || "")}</div>
    <div class="kcard-foot">
      <span class="kcard-valor">${fmtMoeda(o.valorProposto)}</span>
      <button class="btn-small" data-kcard-action title="Excluir" onclick="window.__jm.excluirOportunidade('${o.id}')">🗑</button>
    </div>
    ${o.perdida && o.motivoPerda ? `<div class="sublabel" style="margin-top:6px;">Motivo: ${esc(o.motivoPerda)}</div>` : ""}
  `;
}

function renderKanbanVendas() {
  const colunas = colunasVendas();
  renderKanban("kanban-vendas", "vendas", colunas, STATE.oportunidades, (o) => o.etapa, renderCardOportunidade);
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

  if (novaEtapa === "perdido") {
    pendingPerdaId = id;
    document.getElementById("mp-motivo").value = "";
    abrirModal("modal-perda");
    return;
  }

  const etapaCfg = STATE.etapasVenda.find((e) => e.id === novaEtapa);
  if (etapaCfg && etapaCfg.fechamento) {
    pendingContratoOportunidadeId = id;
    pendingContratoEtapaFechamentoId = novaEtapa;
    document.getElementById("mct-cliente").value = op.clienteNome;
    document.getElementById("mct-valor").value = op.valorProposto ? String(op.valorProposto).replace(".", ",") : "";
    document.getElementById("mct-forma").value = "avista";
    document.getElementById("mct-primeiraparcela").value = hojeStr();
    document.getElementById("mct-linha-parcelamento").style.display = "none";
    atualizarPreviewParcelas();
    abrirModal("modal-contrato");
    return;
  }

  try {
    await updateDoc(doc(db, "oportunidades", id), { etapa: novaEtapa, updatedAt: serverTimestamp() });
    await addDoc(collection(db, "oportunidades", id, "historico"), { tipo: "mudanca_etapa", para: novaEtapa, timestamp: serverTimestamp() });
  } catch (err) { mostrarErro("Não foi possível mover: " + err.message); }
}

async function excluirOportunidade(id) {
  if (!confirm("Excluir esta oportunidade?")) return;
  try { await deleteDoc(doc(db, "oportunidades", id)); } catch (err) { mostrarErro(err.message); }
}

document.getElementById("btn-confirmar-perda").addEventListener("click", async () => {
  if (!pendingPerdaId) return;
  const motivo = document.getElementById("mp-motivo").value.trim();
  try {
    await updateDoc(doc(db, "oportunidades", pendingPerdaId), {
      etapa: "perdido", perdida: true, motivoPerda: motivo, updatedAt: serverTimestamp()
    });
    fecharModal("modal-perda");
    pendingPerdaId = null;
  } catch (err) { mostrarErro(err.message); }
});

document.getElementById("btn-nova-oportunidade").addEventListener("click", () => {
  document.getElementById("mo-cliente").value = "";
  document.getElementById("mo-telefone").value = "";
  document.getElementById("mo-valor").value = "";
  document.getElementById("mo-obs").value = "";
  abrirModal("modal-oportunidade");
});
document.getElementById("btn-salvar-oportunidade").addEventListener("click", async () => {
  const clienteNome = document.getElementById("mo-cliente").value.trim();
  if (!clienteNome) { mostrarErro("Informe o nome do cliente."); return; }
  const primeiraEtapa = [...STATE.etapasVenda].sort((a, b) => a.ordem - b.ordem)[0];
  if (!primeiraEtapa) { mostrarErro("Cadastre ao menos uma etapa do Funil de Vendas em Configurações."); return; }
  try {
    await addDoc(collection(db, "oportunidades"), {
      clienteId: null, clienteNome,
      telefone: document.getElementById("mo-telefone").value.trim(),
      agendamentoId: null, etapa: primeiraEtapa.id,
      valorProposto: parseMoeda(document.getElementById("mo-valor").value),
      observacoes: document.getElementById("mo-obs").value.trim(),
      perdida: false, motivoPerda: "", fechada: false,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    });
    fecharModal("modal-oportunidade");
    mostrarToast("Oportunidade criada.");
  } catch (err) { mostrarErro(err.message); }
});

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
    nomeCliente: document.getElementById("mct-cliente").value.trim(),
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
  ["mct-cliente", "mct-valor", "mct-entrada"].forEach((id) => (document.getElementById(id).value = ""));
  document.getElementById("mct-numparcelas").value = 1;
  document.getElementById("mct-diavencimento").value = 10;
  document.getElementById("mct-forma").value = "avista";
  document.getElementById("mct-preview-parcelas").textContent = "";
}

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
  const f = lerFormularioContrato();
  if (!f.nomeCliente) { mostrarErro("Informe o cliente."); return; }
  if (!f.valorTotal) { mostrarErro("Informe o valor total."); return; }
  const parcelasCalc = calcularParcelas(f.valorTotal, f.forma, f.valorEntrada, f.numParcelas, f.diaVencimento, f.dataPrimeira);

  try {
    const cliente = await encontrarOuCriarCliente(f.nomeCliente, "");
    const contratoRef = await addDoc(collection(db, "contratos"), {
      oportunidadeId: pendingContratoOportunidadeId || null,
      clienteId: cliente.id, clienteNome: cliente.nome,
      valorTotal: f.valorTotal, formaPagamento: f.forma,
      valorEntrada: f.forma === "entrada_parcelas" ? f.valorEntrada : 0,
      numParcelas: f.forma === "entrada_parcelas" ? f.numParcelas : 1,
      diaVencimento: f.diaVencimento,
      dataGeracao: serverTimestamp(), pdfUrl: null, status: "ativo"
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
      const hoje = hojeStr();
      await addDoc(collection(db, "cardsAdmin"), {
        contratoId: contratoRef.id, clienteId: cliente.id, clienteNome: cliente.nome,
        valorTotal: f.valorTotal, etapa: primeiraEtapaAdmin.id, dataEntrouEtapa: hoje,
        prazoEtapaAtual: addDias(hoje, primeiraEtapaAdmin.prazoDiasPadrao || 0),
        createdAt: serverTimestamp(), updatedAt: serverTimestamp()
      });
    }

    if (pendingContratoOportunidadeId) {
      await updateDoc(doc(db, "oportunidades", pendingContratoOportunidadeId), {
        etapa: pendingContratoEtapaFechamentoId, fechada: true, contratoId: contratoRef.id, updatedAt: serverTimestamp()
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
      if (resp.ok) await updateDoc(doc(db, "contratos", contratoRef.id), { pdfUrl: resp.url });
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

function renderTabelaContratos() {
  document.getElementById("tabela-contratos").innerHTML = STATE.contratos.map((c) => {
    const parcelasDoContrato = STATE.parcelas.filter((p) => p.contratoId === c.id);
    const pagas = parcelasDoContrato.filter((p) => p.status === "realizado").length;
    return `<tr>
      <td>${esc(c.clienteNome)}</td>
      <td class="num">${fmtMoeda(c.valorTotal)}</td>
      <td>${c.formaPagamento === "avista" ? "À vista" : `Entrada + ${c.numParcelas}x`}</td>
      <td>${pagas}/${parcelasDoContrato.length}</td>
      <td>${fmtDataHora(c.dataGeracao)}</td>
      <td>${c.pdfUrl ? `<a href="${esc(c.pdfUrl)}" target="_blank" rel="noopener">Ver PDF</a>` : "—"}</td>
      <td><button class="btn-small" onclick="window.__jm.excluirContrato('${c.id}')">🗑</button></td>
    </tr>`;
  }).join("") || `<tr><td colspan="7"><div class="empty">Nenhum contrato ainda.</div></td></tr>`;
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

/* ══════════════ FUNIL ADMINISTRATIVO ══════════════ */

function renderCardAdmin(c) {
  const atrasado = c.prazoEtapaAtual && c.prazoEtapaAtual < hojeStr();
  return `
    <div class="kcard-nome">${esc(c.clienteNome)}</div>
    <div class="kcard-sub">${fmtMoeda(c.valorTotal)}</div>
    <div class="kcard-foot">
      <span class="kcard-prazo ${atrasado ? "atrasado" : ""}">prazo ${fmtData(c.prazoEtapaAtual)}</span>
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
  const etapaCfg = STATE.etapasAdmin.find((e) => e.id === novaEtapa);
  const prazoDias = etapaCfg ? (etapaCfg.prazoDiasPadrao || 0) : 0;
  const hoje = hojeStr();
  try {
    await updateDoc(doc(db, "cardsAdmin", id), {
      etapa: novaEtapa, dataEntrouEtapa: hoje, prazoEtapaAtual: addDias(hoje, prazoDias), updatedAt: serverTimestamp()
    });
    await addDoc(collection(db, "cardsAdmin", id, "historico"), { tipo: "mudanca_etapa", para: novaEtapa, timestamp: serverTimestamp() });
  } catch (err) { mostrarErro("Não foi possível mover: " + err.message); }
}

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
  document.getElementById("tabela-parcelas-vencidas").innerHTML = vencidas.map((p) => `<tr>
    <td>${esc(p.clienteNome)}</td><td>${p.numero === 0 ? "Entrada" : "Parcela " + p.numero}</td>
    <td>${fmtData(p.vencimento)}</td><td class="num">${fmtMoeda(p.valor)}</td>
    <td><button class="btn-small" onclick="window.__jm.marcarParcelaPaga('${p.id}')">Marcar paga</button></td>
  </tr>`).join("") || `<tr><td colspan="5"><div class="empty">Nenhuma parcela vencida. 🎉</div></td></tr>`;

  document.getElementById("tabela-parcelas-periodo").innerHTML = parcelasDoPeriodo
    .slice().sort((a, b) => (a.vencimento || "").localeCompare(b.vencimento || ""))
    .map((p) => `<tr>
      <td>${esc(p.clienteNome)}</td><td>${p.numero === 0 ? "Entrada" : "Parcela " + p.numero}</td>
      <td>${fmtData(p.vencimento)}</td><td class="num">${fmtMoeda(p.valor)}</td>
      <td><span class="stamp ${p.status}">${p.status === "realizado" ? "Pago" : "Esperado"}</span></td>
      <td>${p.status === "esperado" ? `<button class="btn-small" onclick="window.__jm.marcarParcelaPaga('${p.id}')">Marcar paga</button>` : "—"}</td>
    </tr>`).join("") || `<tr><td colspan="6"><div class="empty">Nenhuma parcela neste período.</div></td></tr>`;
}

/* ══════════════ DESPESAS & CUSTOS ══════════════ */

function abrirModalDespesa() {
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

document.getElementById("btn-salvar-despesa").addEventListener("click", async () => {
  const descricao = document.getElementById("md-descricao").value.trim();
  const valor = parseMoeda(document.getElementById("md-valor").value);
  const data = document.getElementById("md-data").value || hojeStr();
  if (!descricao) { mostrarErro("Informe a descrição."); return; }
  if (!valor) { mostrarErro("Informe o valor."); return; }
  const recorrente = document.getElementById("md-recorrente").checked;
  try {
    await addDoc(collection(db, "despesas"), {
      descricao, categoria: document.getElementById("md-categoria").value.trim(),
      tipo: document.getElementById("md-tipo").value, valor, data,
      recorrente, diaVencimento: recorrente ? parseInt(data.split("-")[2], 10) : null,
      ultimoMesLancado: recorrente ? data.slice(0, 7) : null,
      origemRecorrenteId: null, createdAt: serverTimestamp()
    });
    fecharModal("modal-despesa");
    mostrarToast("Lançamento salvo.");
  } catch (err) { mostrarErro(err.message); }
});

async function excluirDespesa(id) {
  if (!confirm("Excluir este lançamento?")) return;
  try { await deleteDoc(doc(db, "despesas", id)); } catch (err) { mostrarErro(err.message); }
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
        ultimoMesLancado: null, origemRecorrenteId: d.id, createdAt: serverTimestamp()
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

function renderTabelaDespesas() {
  document.getElementById("tabela-despesas").innerHTML = STATE.despesas
    .slice().sort((a, b) => (b.data || "").localeCompare(a.data || ""))
    .map((d) => `<tr>
      <td>${esc(d.descricao)}</td><td>${esc(d.categoria || "—")}</td>
      <td>${d.tipo === "despesa" ? "Despesa" : "Outro custo"}</td>
      <td class="num">${fmtMoeda(d.valor)}</td><td>${fmtData(d.data)}</td>
      <td>${d.recorrente ? "Sim (dia " + d.diaVencimento + ")" : "—"}</td>
      <td><button class="btn-small" onclick="window.__jm.excluirDespesa('${d.id}')">🗑</button></td>
    </tr>`).join("") || `<tr><td colspan="7"><div class="empty">Nenhuma despesa lançada.</div></td></tr>`;
}

/* ══════════════ CLIENTES ══════════════ */

document.getElementById("btn-novo-cliente").addEventListener("click", () => {
  document.getElementById("modal-cliente-titulo").textContent = "Novo cliente";
  ["mc-nome", "mc-telefone", "mc-email", "mc-origem", "mc-obs"].forEach((id) => (document.getElementById(id).value = ""));
  abrirModal("modal-cliente");
});
document.getElementById("btn-salvar-cliente").addEventListener("click", async () => {
  const nome = document.getElementById("mc-nome").value.trim();
  if (!nome) { mostrarErro("Informe o nome."); return; }
  try {
    await addDoc(collection(db, "clientes"), {
      nome, telefone: document.getElementById("mc-telefone").value.trim(),
      email: document.getElementById("mc-email").value.trim(),
      origem: document.getElementById("mc-origem").value.trim(),
      observacoes: document.getElementById("mc-obs").value.trim(),
      createdAt: serverTimestamp()
    });
    fecharModal("modal-cliente");
    mostrarToast("Cliente salvo.");
  } catch (err) { mostrarErro(err.message); }
});

async function excluirCliente(id) {
  if (!confirm("Excluir este cliente? (Os registros já vinculados a ele nos funis não são apagados.)")) return;
  try { await deleteDoc(doc(db, "clientes", id)); } catch (err) { mostrarErro(err.message); }
}

function renderTabelaClientes() {
  document.getElementById("tabela-clientes").innerHTML = STATE.clientes.map((c) => `<tr>
    <td>${esc(c.nome)}</td><td>${esc(c.telefone || "—")}</td><td>${esc(c.email || "—")}</td><td>${esc(c.origem || "—")}</td>
  </tr>`).join("") || `<tr><td colspan="4"><div class="empty">Nenhum cliente cadastrado.</div></td></tr>`;

  document.getElementById("lista-clientes-datalist").innerHTML = STATE.clientes.map((c) => `<option value="${esc(c.nome)}">`).join("");
}

/* ══════════════ CONFIGURAÇÕES — ETAPAS DOS FUNIS ══════════════ */

document.getElementById("btn-nova-etapa-venda").addEventListener("click", () => {
  document.getElementById("mev-nome").value = "";
  document.getElementById("mev-ordem").value = STATE.etapasVenda.length + 1;
  document.getElementById("mev-fechamento").checked = false;
  abrirModal("modal-etapa-venda");
});
document.getElementById("btn-salvar-etapa-venda").addEventListener("click", async () => {
  const nome = document.getElementById("mev-nome").value.trim();
  if (!nome) { mostrarErro("Informe o nome da etapa."); return; }
  try {
    await addDoc(collection(db, "etapasVendaConfig"), {
      nome, ordem: parseInt(document.getElementById("mev-ordem").value, 10) || (STATE.etapasVenda.length + 1),
      fechamento: document.getElementById("mev-fechamento").checked
    });
    fecharModal("modal-etapa-venda");
  } catch (err) { mostrarErro(err.message); }
});
async function excluirEtapaVenda(id) {
  if (!confirm("Excluir esta etapa? Oportunidades nela ficarão sem coluna visível até serem movidas.")) return;
  try { await deleteDoc(doc(db, "etapasVendaConfig", id)); } catch (err) { mostrarErro(err.message); }
}

document.getElementById("btn-nova-etapa-admin").addEventListener("click", () => {
  document.getElementById("mea-nome").value = "";
  document.getElementById("mea-ordem").value = STATE.etapasAdmin.length + 1;
  document.getElementById("mea-prazo").value = 5;
  abrirModal("modal-etapa-admin");
});
document.getElementById("btn-salvar-etapa-admin").addEventListener("click", async () => {
  const nome = document.getElementById("mea-nome").value.trim();
  if (!nome) { mostrarErro("Informe o nome da etapa."); return; }
  try {
    await addDoc(collection(db, "etapasAdminConfig"), {
      nome, ordem: parseInt(document.getElementById("mea-ordem").value, 10) || (STATE.etapasAdmin.length + 1),
      prazoDiasPadrao: parseInt(document.getElementById("mea-prazo").value, 10) || 0
    });
    fecharModal("modal-etapa-admin");
  } catch (err) { mostrarErro(err.message); }
});
async function excluirEtapaAdmin(id) {
  if (!confirm("Excluir esta etapa? Cards nela ficarão sem coluna visível até serem movidos.")) return;
  try { await deleteDoc(doc(db, "etapasAdminConfig", id)); } catch (err) { mostrarErro(err.message); }
}

function renderConfigEtapasVenda() {
  document.getElementById("tabela-etapas-venda").innerHTML = [...STATE.etapasVenda].sort((a, b) => a.ordem - b.ordem).map((e) => `<tr>
    <td>${e.ordem}</td><td>${esc(e.nome)}</td><td>${e.fechamento ? "Sim" : "—"}</td>
    <td><button class="btn-small" onclick="window.__jm.excluirEtapaVenda('${e.id}')">🗑</button></td>
  </tr>`).join("") || `<tr><td colspan="4"><div class="empty">Nenhuma etapa cadastrada.</div></td></tr>`;
}
function renderConfigEtapasAdmin() {
  document.getElementById("tabela-etapas-admin").innerHTML = [...STATE.etapasAdmin].sort((a, b) => a.ordem - b.ordem).map((e) => `<tr>
    <td>${e.ordem}</td><td>${esc(e.nome)}</td><td>${e.prazoDiasPadrao}</td>
    <td><button class="btn-small" onclick="window.__jm.excluirEtapaAdmin('${e.id}')">🗑</button></td>
  </tr>`).join("") || `<tr><td colspan="4"><div class="empty">Nenhuma etapa cadastrada.</div></td></tr>`;
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

const DEFAULT_ETAPAS_VENDA = [
  { nome: "Novo Lead", ordem: 1, fechamento: false },
  { nome: "Proposta Enviada", ordem: 2, fechamento: false },
  { nome: "Negociação", ordem: 3, fechamento: false },
  { nome: "Fechado", ordem: 4, fechamento: true }
];
const DEFAULT_ETAPAS_ADMIN = [
  { nome: "Pagamento da entrada", ordem: 1, prazoDiasPadrao: 3 },
  { nome: "Criação do grupo", ordem: 2, prazoDiasPadrao: 2 },
  { nome: "Execução", ordem: 3, prazoDiasPadrao: 15 },
  { nome: "Entrega", ordem: 4, prazoDiasPadrao: 5 }
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
  converterEmOportunidade, excluirAgendamento,
  excluirOportunidade, marcarParcelaPaga,
  excluirContrato, excluirDespesa, excluirCliente,
  excluirEtapaVenda, excluirEtapaAdmin
};

iniciarListeners();
sincronizarAgenda().catch(() => {}); // melhor-esforço: silencioso se o Apps Script ainda não estiver configurado
