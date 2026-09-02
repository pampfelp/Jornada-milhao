/*
  Autenticação real (Firebase Auth) + papéis.

  Este projeto rodou até 2026-09-02 sem Auth nenhum, com as regras validando
  só formato. Isso valia enquanto era uma pessoa só usando. Deixou de valer
  quando entrou gente com nível de acesso diferente: a SDR trabalha o funil e
  os clientes, e não vê custo, despesa nem painel financeiro.

  Adaptado do padrão de referência (boilerplate/js/auth.js, extraído do
  Sistema IEQ Tapajós). A diferença: lá o papel morava em perfis/{id} porque
  "pessoa" era entidade de negócio (membro da igreja). Aqui quem loga é a
  equipe, então o papel mora direto no vínculo:

    usuarios/{uid}   -> { nome, email, papel, ativo, precisaTrocarSenha, createdAt }
    config/bootstrap -> { adminCriado: bool }   (trava do 1º admin)

  Papel é valor canônico de uma lista fixa, nunca texto livre — campo aberto
  que vira agrupamento sempre volta com grafia divergente.
*/

import { db, auth, firebaseConfig } from "./firebase-init.js";
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  createUserWithEmailAndPassword, updatePassword, sendPasswordResetEmail,
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, collection, query, orderBy, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

/*
  Senha de primeiro acesso, igual ao padrão da Solar Green: uma só pra todo
  mundo, porque ninguém continua com ela. Toda conta nasce com
  precisaTrocarSenha:true e a pessoa é obrigada a criar a própria senha
  antes de ver qualquer tela.
*/
export const SENHA_PRIMEIRO_ACESSO = "Jornada@2026";

export const PAPEIS = {
  admin: "Administrador",
  gerente: "Gerente",
  sdr: "SDR",
};

/*
  Matriz de permissão por área. É a fonte de verdade única do que cada papel
  enxerga: o menu, as views e a decisão de abrir ou não cada listener leem
  daqui, em vez de cada lugar ter o próprio `if papel === ...` (que é como
  duas listas mantidas por mãos diferentes divergem em silêncio).

  As regras do Firestore repetem essa matriz do lado do servidor, porque
  esconder no navegador não protege nada sozinho — o app.js é conveniência,
  firestore.rules é a segurança de verdade. As duas precisam ser mudadas
  juntas quando um papel mudar de escopo.
*/
const AREAS_POR_PAPEL = {
  admin:   ["financeiro", "funis", "contratos", "entradas", "despesas", "clientes", "config", "usuarios", "planilha"],
  gerente: ["financeiro", "funis", "contratos", "entradas", "despesas", "clientes", "config"],
  sdr:     ["funis", "contratos", "clientes"],
};

export const AUTH = {
  pronto: false,   // primeiro carregamento (login + papel) já resolvido
  user: null,      // objeto do Firebase Auth
  usuario: null,   // { id, nome, email, papel, ativo, precisaTrocarSenha }
};

let _pararListenerUsuario = null;

/** Chame uma vez no bootstrap do app.js. onChange(AUTH) dispara a cada mudança relevante. */
export function iniciarAuth(onChange) {
  onAuthStateChanged(auth, async (user) => {
    _pararListenerUsuario?.();
    _pararListenerUsuario = null;
    AUTH.user = user;
    AUTH.usuario = null;

    if (!user) {
      AUTH.pronto = true;
      onChange(AUTH);
      return;
    }

    // onSnapshot (e não getDoc) de propósito: se o admin trocar o papel de
    // alguém ou desativar a conta, a sessão aberta daquela pessoa reage na
    // hora, sem depender dela recarregar a página.
    _pararListenerUsuario = onSnapshot(doc(db, "usuarios", user.uid), (snap) => {
      AUTH.usuario = snap.exists() ? { id: snap.id, ...snap.data() } : null;
      AUTH.pronto = true;
      onChange(AUTH);
    }, () => {
      // Sem permissão de ler o próprio vínculo (regra ainda não publicada,
      // ou conta criada no Auth sem documento correspondente).
      AUTH.usuario = null;
      AUTH.pronto = true;
      onChange(AUTH);
    });
  });
}

/** Traduz erros comuns do Firebase Auth pra mensagem em português. */
export function mensagemErroAuth(err) {
  const codigo = err?.code || "";
  if (["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found", "auth/invalid-email"].includes(codigo)) {
    return "E-mail ou senha incorretos.";
  }
  if (codigo === "auth/too-many-requests") return "Muitas tentativas. Tente de novo em alguns minutos.";
  if (codigo === "auth/weak-password") return "Senha muito curta (mínimo 6 caracteres).";
  if (codigo === "auth/email-already-in-use") return "Já existe uma conta usando esse e-mail.";
  if (codigo === "auth/requires-recent-login") return "Por segurança, saia e entre de novo antes de trocar a senha.";
  if (codigo === "auth/network-request-failed") return "Sem conexão. Confira a internet e tente de novo.";
  return err?.message || "Não foi possível concluir. Tente de novo.";
}

/* ══════════════ permissões ══════════════ */

export function papelAtual() { return AUTH.usuario?.papel || null; }
export function isAdmin() { return papelAtual() === "admin"; }

/** Fonte única de "esse papel enxerga essa área?". */
export function podeVer(area) {
  const areas = AREAS_POR_PAPEL[papelAtual()];
  return !!areas && areas.includes(area);
}

/** Sessão utilizável: logado, com vínculo, ativo e sem troca de senha pendente. */
export function sessaoLiberada() {
  return !!AUTH.user && !!AUTH.usuario && AUTH.usuario.ativo !== false && !AUTH.usuario.precisaTrocarSenha;
}

/* ══════════════ sessão ══════════════ */

export async function login(email, senha) {
  await signInWithEmailAndPassword(auth, email.trim(), senha);
}
export async function logout() {
  await signOut(auth);
}
export async function enviarResetSenha(email) {
  await sendPasswordResetEmail(auth, email.trim());
}

/**
 * Troca a senha da própria conta. Quando vem da tela de troca obrigatória
 * (primeiro acesso), também baixa a flag — senha temporária distribuída por
 * outra pessoa nunca deve virar a senha permanente.
 */
export async function alterarMinhaSenha(novaSenha) {
  await updatePassword(auth.currentUser, novaSenha);
  if (AUTH.usuario?.precisaTrocarSenha) {
    await updateDoc(doc(db, "usuarios", auth.currentUser.uid), { precisaTrocarSenha: false });
  }
}

/* ══════════════ bootstrap do primeiro admin ══════════════ */

export async function bootstrapNecessario() {
  try {
    const snap = await getDoc(doc(db, "config", "bootstrap"));
    return !snap.exists() || snap.data().adminCriado === false;
  } catch {
    return false; // sem permissão de ler = janela já fechada
  }
}

export async function criarPrimeiroAdmin({ nome, email, senha }) {
  const cred = await createUserWithEmailAndPassword(auth, email.trim(), senha);
  await setDoc(doc(db, "usuarios", cred.user.uid), {
    nome, email: email.trim(), papel: "admin", ativo: true,
    precisaTrocarSenha: false, createdAt: serverTimestamp(),
  });
  await setDoc(doc(db, "config", "bootstrap"), { adminCriado: true }, { merge: true });
}

/**
 * Idempotente e barata: se quem está logado já é admin de verdade mas a
 * janela de bootstrap continua aberta no banco, fecha agora. Sem isso, uma
 * escrita que falhou no meio do primeiro cadastro deixaria a janela aberta
 * pra sempre — e janela de bootstrap aberta é qualquer visitante criando
 * um admin pra si mesmo.
 */
export async function garantirBootstrapFechado() {
  try {
    const snap = await getDoc(doc(db, "config", "bootstrap"));
    if (!snap.exists() || snap.data().adminCriado !== true) {
      await setDoc(doc(db, "config", "bootstrap"), { adminCriado: true }, { merge: true });
    }
  } catch {
    // Offline ou sem permissão — não é crítico, tenta de novo no próximo login.
  }
}

/* ══════════════ gestão de usuários (só admin) ══════════════ */

export function assinarUsuarios(aoAtualizar, aoFalhar) {
  return onSnapshot(
    query(collection(db, "usuarios"), orderBy("nome")),
    (snap) => aoAtualizar(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => aoFalhar?.(err)
  );
}

/**
 * Cria a conta de acesso de outra pessoa.
 *
 * createUserWithEmailAndPassword loga automaticamente como o usuário
 * recém-criado NA INSTÂNCIA em que é chamado. Chamar na `auth` principal
 * derrubaria a sessão do admin no meio do cadastro. Por isso a conta nasce
 * numa segunda instância descartável do Firebase App, que loga "no vazio" e
 * é destruída em seguida; o vínculo usuarios/{uid} é gravado pelo `db` da
 * instância principal, ainda autenticada como admin.
 *
 * Sem Cloud Functions e sem Admin SDK, só o Web SDK chamado duas vezes.
 */
export async function criarUsuario({ nome, email, telefone, papel }) {
  const nomeInstancia = "criar-usuario-" + Date.now();
  const appSecundario = initializeApp(firebaseConfig, nomeInstancia);
  const authSecundario = getAuth(appSecundario);
  try {
    const cred = await createUserWithEmailAndPassword(authSecundario, email.trim(), SENHA_PRIMEIRO_ACESSO);
    await setDoc(doc(db, "usuarios", cred.user.uid), {
      nome, email: email.trim(), telefone: telefone || "", papel, ativo: true,
      // A senha é a mesma pra todo mundo, então a troca no primeiro acesso
      // não é opcional — é ela que faz a senha compartilhada ser descartável.
      precisaTrocarSenha: true, createdAt: serverTimestamp(),
    });
    return cred.user.uid;
  } finally {
    await signOut(authSecundario).catch(() => {});
    await deleteApp(appSecundario).catch(() => {});
  }
}

export async function atualizarUsuario(uid, { nome, telefone, papel, ativo }) {
  await updateDoc(doc(db, "usuarios", uid), { nome, telefone: telefone || "", papel, ativo });
}

/**
 * Remove só o vínculo usuarios/{uid}; a conta continua existindo no Firebase
 * Auth, porque apagar conta de outra pessoa exige Admin SDK. Sem o vínculo,
 * o login até acontece mas não libera nada — a sessão cai na tela de "acesso
 * não liberado". Pra revogar sem apagar, prefira ativo:false, que mantém o
 * histórico de quem era.
 */
export async function removerVinculoUsuario(uid) {
  await deleteDoc(doc(db, "usuarios", uid));
}
