/**
 * Jornada do Milhão — Apps Script mínimo, usado SÓ como proxy de APIs
 * externas (Google Agenda e geração de PDF de contrato). NÃO é o banco de
 * dados deste sistema (isso é o Firestore) — mas a integração com a
 * YayForms (item 5 abaixo) É uma exceção: como não há ninguém no navegador
 * esperando pra salvar o lead quando alguém responde um formulário, este
 * script escreve DIRETO no Firestore nesse caso específico (via API REST,
 * sem autenticação — as mesmas regras de formato que valem pro app.js
 * valem aqui). Fora isso, este arquivo só repassa integrações que o
 * navegador sozinho não consegue fazer:
 *
 *   1. "listarCalendarios" — lista os calendários que a conta implantada
 *      enxerga, pra alimentar o seletor em Configurações (pra escolher em
 *      qual Agenda os agendamentos criados no sistema são lançados).
 *   2. "criarEventoAgenda" — cria um evento novo na Agenda quando um
 *      agendamento é criado (ou reagendado) no sistema. O fluxo é sempre
 *      Firestore → Agenda, nunca o contrário: este sistema NÃO lê/importa
 *      eventos da Agenda.
 *   3. "gerarContratoPDF" — recebe o HTML do contrato já pronto (montado
 *      no app.js — mesmo padrão do SolarGreen-ERP: nada de Google Docs
 *      modelo, o texto inteiro já vem com os dados substituídos), converte
 *      em PDF de verdade e guarda no Google Drive, devolvendo o link. Sem
 *      isso o navegador não tem como gerar um PDF formatado nem guardá-lo
 *      em algum lugar de graça.
 *   4. "enviarParaAssinatura" — manda o PDF do contrato (já gerado no
 *      Drive) pra Autentique via API, que dispara sozinha um e-mail pro
 *      cliente com o link de assinatura digital. Fica aqui (e não no
 *      navegador) só por causa do token da API: ele mora em Script
 *      Properties (AUTENTIQUE_API_TOKEN), nunca no código-fonte, então
 *      nunca aparece no repositório público nem no navegador de quem usa
 *      o sistema.
 *   5. Webhook da YayForms (recebido em "?origem=yayforms", não é uma
 *      "action" chamada pelo app.js) — toda vez que alguém responde
 *      QUALQUER formulário cadastrado na YayForms, ela avisa este script,
 *      que busca a resposta completa na API da YayForms e cria um lead
 *      novo direto no Funil de Agendamento (etapa inicial), com o nome do
 *      formulário guardado no campo "Origem" do cliente.
 *   6. Checkout do Fast Start ("fsRegistrar", "fsContrato", "fsContratoStatus",
 *      "fsPagamento", "fsStatus")
 *      — ver a seção FAST START no fim deste arquivo.
 *
 * ESCOPO — SÓ CRIAÇÃO de evento na Agenda, SÓ CRIAÇÃO de arquivo no Drive:
 * nenhuma ação aqui lê, edita ou apaga evento da Agenda, nem apaga arquivo
 * do Drive.
 *
 * COMO USAR:
 * 1. Crie uma planilha Google Sheets em branco, só para servir de "casa"
 *    pro script (o conteúdo dela não importa).
 * 2. Menu Extensões > Apps Script.
 * 3. Apague o conteúdo padrão e cole TODO este arquivo.
 * 4. Menu ⚙️ Configurações do projeto > Script Properties > "Add script
 *    property" e adicione (veja o README, seção "Apps Script", pro passo a
 *    passo completo de cada uma):
 *      AGENDA_CALENDAR_ID     = (opcional; "primary" se não preencher)
 *      AUTENTIQUE_API_TOKEN   = (opcional; token gerado em
 *                                 painel.autentique.com.br/perfil/api —
 *                                 sem isso, só o botão "Enviar para
 *                                 assinatura digital" fica indisponível)
 *      AUTENTIQUE_SANDBOX     = (opcional; "true" pra testar sem gastar
 *                                 crédito/documento real — deixe em
 *                                 branco ou "false" em produção)
 *      YAYFORMS_API_TOKEN     = (opcional; token gerado em
 *                                 yayforms.com/help/how-to-generate-a-yay-
 *                                 forms-api-token — sem isso, o webhook de
 *                                 leads não funciona)
 *      YAYFORMS_WEBHOOK_TOKEN = (opcional; uma senha longa que VOCÊ
 *                                 inventa — é o que impede qualquer pessoa
 *                                 na internet de forjar leads falsos nessa
 *                                 URL pública. Veja o README, seção
 *                                 "YayForms", pro passo a passo completo.)
 * 5. Rode a função "autorizar" uma vez direto no editor (▶) pra autorizar
 *    o acesso à Agenda e ao Drive antes de implantar.
 * 6. Menu Implantar > Nova implantação > tipo "Aplicativo da Web".
 *    - Executar como: Eu (seu e-mail)
 *    - Quem pode acessar: Qualquer pessoa
 *    Copie a URL "/exec" gerada.
 * 7. Cole essa URL na constante APPS_SCRIPT_PROXY_URL, em firebase-init.js.
 * 8. Toda vez que editar este arquivo, é preciso fazer uma NOVA implantação
 *    (ou "Gerenciar implantações > editar > Nova versão") pra que a URL
 *    publicada reflita o código novo — só salvar não é suficiente.
 */

var CONTRATOS_FOLDER_NAME = "Jornada do Milhão - Contratos";

// Rode esta função uma vez no editor (▶) antes de implantar, só pra abrir a
// tela de autorização do Google (Agenda + Drive + acesso a serviço
// externo) de forma previsível. A chamada ao UrlFetchApp aqui é só pra
// forçar o Google a listar o escopo "script.external_request" na tela de
// autorização — sem isso, quem já tinha autorizado antes de o
// enviarParaAssinatura existir (que é quem chama UrlFetchApp de verdade)
// nunca vê essa permissão de novo, e a chamada à Autentique falha com
// "Você não tem permissão para chamar UrlFetchApp.fetch" mesmo depois de
// reimplantado. Rodar esta função de novo (▶) e aceitar a tela de
// permissão resolve — não precisa reautorizar toda vez, só quando um
// escopo novo é adicionado.
function autorizar() {
  CalendarApp.getDefaultCalendar();
  DriveApp.getRootFolder();
  UrlFetchApp.fetch("https://www.google.com", { muteHttpExceptions: true });
}

function doPost(e) {
  // Webhook da YayForms não manda {action: "..."} como o app.js manda —
  // ele tem o formato de payload dela mesma. Por isso é distinguido pela
  // query string da URL (configurada na YayForms), não pelo corpo.
  if (e.parameter && e.parameter.origem === "yayforms") {
    return json_(acaoReceberLeadYayforms_(e));
  }
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) {}
  return json_(rotear_(body));
}

function rotear_(body) {
  try {
    switch (body.action) {
      case "listarCalendarios": return acaoListarCalendarios_();
      case "criarEventoAgenda": return acaoCriarEventoAgenda_(body.calendarId, body.clienteNome, body.clienteEmail, body.observacoes, body.inicio, body.duracaoMinutos);
      case "gerarContratoPDF": return acaoGerarContratoPDF_(body.html, body.clienteNome);
      case "enviarParaAssinatura": return acaoEnviarParaAssinatura_(body.fileId, body.clienteNome, body.clienteEmail, body.nomeDocumento);
      case "fsRegistrar": return acaoFsRegistrar_(body);
      case "fsPagamento": return acaoFsPagamento_(body);
      case "fsStatus": return acaoFsStatus_(body);
      case "fsContrato": return acaoFsContrato_(body);
      case "fsContratoStatus": return acaoFsContratoStatus_(body);
      default: return { ok: false, erro: "Ação desconhecida: " + body.action };
    }
  } catch (err) {
    return { ok: false, erro: String(err) };
  }
}

// ══════════════ GOOGLE AGENDA (só criação de evento) ══════════════

// Lista os calendários que a conta que implantou este Code.gs enxerga
// (os dela + os que foram compartilhados com ela) — alimenta o seletor de
// calendário em Configurações, pra escolher em qual Agenda os
// agendamentos criados no sistema são lançados.
function acaoListarCalendarios_() {
  var calendarios = CalendarApp.getAllCalendars().map(function (cal) {
    return { id: cal.getId(), nome: cal.getName() };
  });
  return { ok: true, calendarios: calendarios };
}

// Cria um evento novo na Agenda quando um agendamento é criado (ou
// reagendado, depois de um no-show) no sistema — o fluxo é sempre
// Firestore → Agenda, nunca o contrário. "calendarId" vem do calendário
// escolhido em Configurações (guardado no Firestore); se não vier, cai
// pra Script Property AGENDA_CALENDAR_ID e, por último, pro calendário
// principal. "inicio" é uma string ISO (ex: "2026-08-10T14:00:00").
//
// Título e descrição são fixos por padrão de negócio (não vêm do
// chamador) — o Google Calendar mostra o MESMO título/descrição pra todo
// mundo que vê o evento (organizador e convidados), não existe
// personalização por destinatário. Por isso: o título usa a frase do
// ponto de vista do Benedito (é ele quem organiza / vê na própria Agenda
// primeiro) e a descrição usa a frase do ponto de vista do cliente — as
// duas ficam visíveis pra ambos, só em campos diferentes.
// Se "clienteEmail" vier preenchido, ele é adicionado como convidado e o
// Calendar dispara o convite por e-mail nativo dele (mesmo convite que
// aparece pra qualquer evento com convidado).
function acaoCriarEventoAgenda_(calendarId, clienteNome, clienteEmail, observacoes, inicio, duracaoMinutos) {
  if (!clienteNome || !inicio) return { ok: false, erro: "Parâmetros clienteNome/inicio são obrigatórios." };
  var calendario = CalendarApp.getCalendarById(calendarId || obterCalendarId_());
  if (!calendario) return { ok: false, erro: "Calendário não encontrado: " + calendarId };

  var dataInicio = new Date(inicio);
  var duracao = duracaoMinutos || 60;
  var dataFim = new Date(dataInicio.getTime() + duracao * 60000);

  var titulo = "Reunião Consultoria Jornada do Milhão com " + clienteNome;
  var descricao = "Reunião Consultoria " + clienteNome + " com Benedito Viegas - Jornada do Milhão";
  if (observacoes) descricao += "\n\n" + observacoes;

  var opcoes = { description: descricao };
  if (clienteEmail) { opcoes.guests = clienteEmail; opcoes.sendInvites = true; }

  var evento = calendario.createEvent(titulo, dataInicio, dataFim, opcoes);
  return { ok: true, googleEventId: evento.getId(), url: evento.getHtmlLink ? evento.getHtmlLink() : "" };
}

function obterCalendarId_() {
  var props = PropertiesService.getScriptProperties();
  return props.getProperty("AGENDA_CALENDAR_ID") || "primary";
}

// ══════════════ GERAÇÃO DE CONTRATO EM PDF ══════════════

// "html" já vem PRONTO do app.js (montarHtmlContrato — mesmo padrão do
// SolarGreen-ERP: o texto inteiro do contrato, com todos os dados já
// substituídos, é montado em JavaScript no navegador, não aqui). Este
// script só converte esse HTML em PDF de verdade e guarda no Drive (pasta
// "Jornada do Milhão - Contratos") — não existe mais Google Docs modelo
// nenhum no meio do caminho, o que elimina de vez qualquer formatação
// escondida (quebra de página, estilo "Título" etc.) que um Google Docs
// editado à mão podia carregar sem ninguém perceber.
function acaoGerarContratoPDF_(html, clienteNome) {
  if (!html) return { ok: false, erro: "Falta o HTML do contrato." };

  var pasta = getContratosFolder_();
  var nomeArquivo = "Contrato - " + (clienteNome || "Cliente") + " - " + Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "GMT-3", "dd-MM-yyyy HH-mm");

  var blobHtml = Utilities.newBlob(html, "text/html", nomeArquivo + ".html");
  var pdfBlob = blobHtml.getAs("application/pdf").setName(nomeArquivo + ".pdf");
  var arquivoPdf = pasta.createFile(pdfBlob);
  arquivoPdf.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  return {
    ok: true,
    url: arquivoPdf.getUrl(),
    fileId: arquivoPdf.getId()
  };
}

function getContratosFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty("CONTRATOS_FOLDER_ID");
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (err) {}
  }
  var pastas = DriveApp.getFoldersByName(CONTRATOS_FOLDER_NAME);
  var pasta = pastas.hasNext() ? pastas.next() : DriveApp.createFolder(CONTRATOS_FOLDER_NAME);
  props.setProperty("CONTRATOS_FOLDER_ID", pasta.getId());
  return pasta;
}

// ══════════════ ASSINATURA ELETRÔNICA (Autentique) ══════════════

var AUTENTIQUE_GRAPHQL_URL_ = "https://api.autentique.com.br/v2/graphql";

// Manda o PDF do contrato (já gerado no Drive por acaoGerarContratoPDF_,
// identificado por "fileId") pra Autentique via GraphQL, criando um
// documento com um único signatário (o cliente). A própria Autentique
// dispara o e-mail com o link de assinatura pro "clienteEmail" — este
// script só aciona a API e devolve o link também, como cópia de backup
// (ex: caso o Benedito precise reenviar manualmente por WhatsApp).
function acaoEnviarParaAssinatura_(fileId, clienteNome, clienteEmail, nomeDocumento) {
  if (!fileId) return { ok: false, erro: "Falta o PDF do contrato — gere o PDF antes de enviar pra assinatura." };
  if (!clienteEmail) return { ok: false, erro: "O cliente precisa ter um e-mail cadastrado pra receber o link de assinatura." };

  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty("AUTENTIQUE_API_TOKEN");
  if (!token) return { ok: false, erro: "Configure AUTENTIQUE_API_TOKEN em Project Settings > Script Properties." };
  var sandbox = props.getProperty("AUTENTIQUE_SANDBOX") === "true";

  var blob;
  try {
    blob = DriveApp.getFileById(fileId).getBlob();
  } catch (err) {
    return { ok: false, erro: "Não encontrei o PDF do contrato no Drive (fileId inválido)." };
  }

  // Segue o "GraphQL multipart request spec" que a Autentique usa pra
  // receber upload de arquivo: 3 partes no multipart — "operations" (a
  // query+variáveis, com o campo do arquivo como null), "map" (aponta
  // qual parte do multipart preenche qual variável) e a parte com o
  // arquivo em si, com o mesmo nome usado no "map" ("file").
  var query = "mutation CreateDocumentMutation($document: DocumentInput!, $signers: [SignerInput!]!, $file: Upload!) { " +
    "createDocument(document: $document, signers: $signers, file: $file, sandbox: " + (sandbox ? "true" : "false") + ") { " +
    "id name signatures { public_id email link { short_link } } } }";
  var variables = {
    document: { name: nomeDocumento || ("Contrato - " + (clienteNome || "Cliente")) },
    signers: [{ email: clienteEmail, name: clienteNome || "", action: "SIGN" }],
    file: null
  };
  var operations = JSON.stringify({ query: query, variables: variables });
  var map = JSON.stringify({ file: ["variables.file"] });

  var resposta = UrlFetchApp.fetch(AUTENTIQUE_GRAPHQL_URL_, {
    method: "post",
    headers: { Authorization: "Bearer " + token },
    payload: { operations: operations, map: map, file: blob },
    muteHttpExceptions: true
  });

  var json;
  try {
    json = JSON.parse(resposta.getContentText());
  } catch (err) {
    return { ok: false, erro: "Resposta inválida da Autentique: " + resposta.getContentText() };
  }
  if (json.errors && json.errors.length) {
    return { ok: false, erro: "Autentique: " + json.errors.map(function (e) { return e.message; }).join("; ") };
  }
  var documento = json.data && json.data.createDocument;
  if (!documento) return { ok: false, erro: "Autentique não retornou o documento criado." };
  var assinatura = (documento.signatures || [])[0] || {};

  return {
    ok: true,
    autentiqueDocId: documento.id,
    link: assinatura.link ? assinatura.link.short_link : null,
    sandbox: sandbox
  };
}

// ══════════════ YAYFORMS → NOVO LEAD NO FUNIL DE AGENDAMENTO ══════════════
//
// Fluxo: em cada formulário da YayForms, Benedito cadastra um webhook
// apontando pra ESTA MESMA URL do Code.gs, com "?origem=yayforms&token=SEU_
// TOKEN" no final. Toda resposta enviada (não parcial) dispara um POST
// aqui — o corpo exato que a YayForms manda varia entre "versões" de
// payload, então em vez de depender do formato exato, este script só usa o
// corpo pra achar o ID da resposta, e busca os dados de verdade na API da
// YayForms (GET /responses/{id}), que tem um formato estável e testado.
//
// Segurança: Apps Script não dá acesso aos headers HTTP de quem chamou
// doPost — só à query string e ao corpo. Por isso a verificação não é por
// header de assinatura (como a YayForms oferece), e sim por um token
// simples na própria URL: sem ele batendo com YAYFORMS_WEBHOOK_TOKEN, a
// requisição é rejeitada. Como a URL deste Code.gs já é pública (está no
// app.js, que é público), esse token é a ÚNICA coisa que impede qualquer
// pessoa na internet de forjar leads falsos direto no funil.

var FIRESTORE_PROJECT_ID_ = "financeirojornadamilhao";
// Mesma chave pública que já vive em firebase-init.js — não é segredo (é
// assim que o Firebase Web funciona), só identifica o projeto.
var FIRESTORE_API_KEY_ = "AIzaSyD2ud5FQsbZeWp8Yh9tIN4W1Nlr60je3dQ";

// Igual ao rotear_(), sempre devolve um JSON {ok:...} mesmo se algo
// explodir no meio (ex: Firestore fora do ar) — nunca deixa o doPost
// devolver um erro cru pro webhook da YayForms.
function acaoReceberLeadYayforms_(e) {
  try {
    var result = acaoReceberLeadYayformsInterno_(e);
    if (!result.ok) console.error("Erro YayForms Webhook:", result.erro);
    return result;
  } catch (err) {
    console.error("Exceção YayForms Webhook:", String(err));
    return { ok: false, erro: String(err) };
  }
}

function acaoReceberLeadYayformsInterno_(e) {
  var props = PropertiesService.getScriptProperties();
  var tokenEsperado = props.getProperty("YAYFORMS_WEBHOOK_TOKEN");
  if (!tokenEsperado || !e.parameter || e.parameter.token !== tokenEsperado) {
    return { ok: false, erro: "Token do webhook ausente ou inválido." };
  }

  var corpoTexto = (e.postData && e.postData.contents) || "{}";
  console.log("Payload recebido da YayForms:", corpoTexto);
  var corpo = {};
  try { corpo = JSON.parse(corpoTexto); } catch (err) {}

  var r = corpo.payload && corpo.payload.response;
  var nomeFormulario = "Formulário YayForms";

  // Se o payload vier do webhook, tentamos buscar o nome do form na raiz (alguns webhooks mandam)
  if (corpo.payload && corpo.payload.form && corpo.payload.form.title) {
    nomeFormulario = corpo.payload.form.title;
  }

  // Idempotência: verificar se o lead já foi criado para esta resposta
  if (r && r.id) {
    var queryUrl = "https://firestore.googleapis.com/v1/projects/" + FIRESTORE_PROJECT_ID_ + "/databases/(default)/documents:runQuery?key=" + FIRESTORE_API_KEY_;
    var queryPayload = {
      structuredQuery: {
        from: [{ collectionId: "agendamentos" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "yayformsResponseId" },
            op: "EQUAL",
            value: { stringValue: String(r.id) }
          }
        }
      }
    };
    
    var respQuery = UrlFetchApp.fetch(queryUrl, {
      method: "post", contentType: "application/json",
      headers: { Authorization: "Bearer " + obterIdTokenRobo_() },
      payload: JSON.stringify(queryPayload), muteHttpExceptions: true
    });
    var jsonQuery = JSON.parse(respQuery.getContentText());
    // runQuery retorna um array. Se o primeiro item tiver "document", já existe.
    if (jsonQuery && jsonQuery.length > 0 && jsonQuery[0].document) {
      console.log("Lead já existe para a resposta " + r.id + " (idempotência).");
      return { ok: true, jaExistia: true, formulario: nomeFormulario };
    }
  }

  // Se o payload não trouxer a resposta embutida, tentamos buscar via API como fallback
  if (!corpo.payload || !corpo.payload.response) {
    var apiToken = props.getProperty("YAYFORMS_API_TOKEN");
    if (!apiToken) return { ok: false, erro: "Payload sem dados e YAYFORMS_API_TOKEN não configurado." };
    var responseId = extrairResponseIdYayforms_(corpo, corpoTexto);
    if (!responseId) return { ok: false, erro: "Não encontrei o ID da resposta no webhook recebido." };

    var respostaHttp = UrlFetchApp.fetch("https://api.yayforms.com/responses/" + responseId, {
      headers: { Authorization: "Bearer " + apiToken }, muteHttpExceptions: true
    });
    console.log("Resposta YayForms API:", respostaHttp.getContentText());
    var dadosResposta = JSON.parse(respostaHttp.getContentText());
    r = dadosResposta && dadosResposta.data;
    if (!r) return { ok: false, erro: "Não consegui buscar a resposta " + responseId + " na API da YayForms." };
  }

  // Tenta buscar o nome real do formulário na YayForms
  if (r && r.formId) {
    var apiToken = props.getProperty("YAYFORMS_API_TOKEN");
    if (apiToken) {
      try {
        var respostaForm = UrlFetchApp.fetch("https://api.yayforms.com/forms/" + r.formId, {
          headers: { Authorization: "Bearer " + apiToken }, muteHttpExceptions: true
        });
        var dadosForm = JSON.parse(respostaForm.getContentText());
        if (dadosForm && dadosForm.data && dadosForm.data.title) nomeFormulario = dadosForm.data.title;
      } catch (err) {
        console.error("Erro ao buscar título do form:", String(err));
      }
    }
  }

  // Se 'answers' vier como um objeto (mapa de IDs), converte para array —
  // mas guarda o ID de cada campo (a chave do mapa) em "fieldId" antes de
  // achatar, porque é dele que mapearQualificacaoYayforms_ depende pra
  // saber EXATAMENTE qual pergunta é essa (ver comentário lá embaixo).
  var answersArray = [];
  if (r.answers && typeof r.answers === 'object' && !Array.isArray(r.answers)) {
    Object.keys(r.answers).forEach(function(k) {
      var a = r.answers[k];
      a.fieldId = k;
      answersArray.push(a);
    });
  } else if (Array.isArray(r.answers)) {
    answersArray = r.answers;
  }

  var extraido = extrairContatoRespostaYayforms_(answersArray);
  var qualificacao = mapearQualificacaoYayforms_(answersArray, r.formId);

  var etapaInicialId = obterPrimeiraEtapaAgendamento_();
  if (!etapaInicialId) return { ok: false, erro: "Cadastre ao menos uma etapa no Funil de Agendamento (Configurações) antes de ligar essa integração." };

  var observacoes = "Formulário: " + nomeFormulario + " (resposta " + r.id + ")";
  observacoes += r.submittedAt ? "\nStatus: respondido até o fim" : "\nStatus: PARCIAL — começou a responder mas não chegou ao fim";
  if (r.tracking && (r.tracking.utm_source || r.tracking.utm_medium || r.tracking.utm_campaign)) {
    observacoes += "\nUTM: " + [r.tracking.utm_source, r.tracking.utm_medium, r.tracking.utm_campaign].filter(function (x) { return x; }).join(" / ");
  }
  observacoes += "\n\n" + extraido.linhas.join("\n");

  var clienteId = criarDocumentoFirestore_("clientes", {
    nome: extraido.nome || ("Lead sem nome — " + nomeFormulario),
    telefone: extraido.telefone, email: extraido.email, cpfCnpj: "", endereco: "",
    representanteNome: "", representanteCpf: "", origem: nomeFormulario, observacoes: ""
  });

  criarDocumentoFirestore_("agendamentos", {
    clienteId: clienteId, clienteNome: extraido.nome || ("Lead sem nome — " + nomeFormulario),
    telefone: extraido.telefone, email: extraido.email,
    data: "", hora: "", etapa: etapaInicialId,
    convertido: false, enviadoAgenda: false, motivoPerda: "",
    observacoes: observacoes, formCompleto: !!r.submittedAt, yayformsResponseId: r.id,
    instagram: qualificacao.instagram, estabelecimento: qualificacao.estabelecimento,
    timeComercial: qualificacao.timeComercial, faturamento6meses: qualificacao.faturamento6meses,
    ondeTrava: qualificacao.ondeTrava
  });

  return { ok: true, clienteId: clienteId, formulario: nomeFormulario };
}

// ══════════════ MAPA FIXO DE PERGUNTAS POR FORMULÁRIO (1 pergunta = 1 campo) ══════════════
//
// Antes disso o casamento era por PALAVRA-CHAVE no título da pergunta —
// funcionava até duas perguntas do MESMO formulário conterem a mesma
// palavra. Foi exatamente o que aconteceu: "Qual faturamento você TEVE nos
// últimos 6 meses" e "Qual faturamento você QUER atingir nos próximos 6
// meses" continham as duas "faturamento" e "6 meses", então caíam no mesmo
// bloco de código — só não se via o efeito porque as opções de resposta da
// segunda não batiam com nenhuma faixa esperada, por sorte de redação, não
// por proteção de verdade.
//
// Agora é pelo ID do campo na YayForms (a chave de "answers", ex.:
// "6a4bf6f071fc6c335703ec48") — único por pergunta DENTRO de um formulário,
// sem ambiguidade nenhuma: 1 ID = 1 pergunta = 1 campo do CRM. Cada formId
// tem sua própria tabela porque o ID de cada campo é gerado pela YayForms e
// não se repete entre formulários diferentes, mesmo quando a pergunta
// parece igual.
//
// Formulário sem tabela aqui (ou pergunta sem entrada dentro da tabela)
// simplesmente não preenche aquele campo — a resposta continua intacta no
// texto de observações (extrairContatoRespostaYayforms_ grava TODAS as
// respostas lá, nenhuma se perde), e a SDR preenche na ligação, como
// sempre foi pra lead que não veio de formulário nenhum.
//
// Pra adicionar/completar um formulário: abra uma resposta completa na
// tela de Logs da YayForms (ícone de olho), pegue o "formId" e, pra cada
// pergunta que quiser mapear, o ID da chave dentro de "answers" e o texto
// EXATO da opção escolhida (cópia e cola, sem adivinhar acento nem
// pontuação).
var MAPAS_FORMULARIO_QUALIFICACAO_ = {
  // "Jornada do Milhão - ORGANICO"
  "6a4bf6ef71fc6c335703ec43": {
    "6a4bf6ef71fc6c335703ec47": { chave: "instagram", tipo: "texto" },
    "6a4bf6f071fc6c335703ec48": {
      chave: "estabelecimento", tipo: "opcao",
      mapa: {
        "Não, operamos de forma remota / home office": "remoto_online"
        // "Sim, temos loja/escritório físico" (ou texto equivalente) ainda
        // não apareceu numa resposta real — adicione aqui assim que uma
        // resposta escolher essa opção.
      }
    },
    "6a4bf6f071fc6c335703ec49": {
      chave: "timeComercial", tipo: "opcao",
      mapa: {
        "Trabalho sozinho ou tenho 1 vendedor": "0_1"
        // "Até 2 vendedores" / "Até 3 vendedores" / "Equipe comercial" (ou
        // texto equivalente) ainda não apareceram — adicione aqui quando
        // aparecerem.
      }
    },
    "6a4bf6f071fc6c335703ec4a": {
      chave: "faturamento6meses", tipo: "opcao",
      mapa: {
        "Menos de R$ 500.000,00": "menos_500k",
        "Entre R$ 500.000,00 e R$ 800.000,00": "500k_800k",
        "Entre R$ 800.000,00 e R$ 1,2 milhão": "800k_1_2mi",
        "Entre R$ 1,2 milhão e R$ 2 milhões": "1_2mi_2mi",
        "Acima de R$ 2 milhões": "acima_2mi"
      }
    },
    "6a4bf6f071fc6c335703ec4b": {
      chave: "ondeTrava", tipo: "multipla",
      opcoes: [
        "Margem caindo, mesmo vendendo",
        "Não consigo escalar as vendas mesmo tendo equipe",
        "Minha operação não comporta crescer mais",
        "Falta de previsibilidade - mês bom, mês ruim",
        "Gestão de time comercial",
        "Dificuldade em contratar e remunerar time comercial"
      ]
    }
    // 6a4bf6f071fc6c335703ec4c (nome da empresa/cidade), ec4f (meta de
    // faturamento), ec4e (comprometimento) e ec4d (confirmação de vaga) não
    // têm campo correspondente no CRM ainda — de propósito, ver plano.
  }
  // Outro formId aqui quando "parceiros" / "tráfego" / "tráfego (com capa)"
  // precisarem do mesmo tratamento — hoje eles ficam sem qualificação
  // automática (só o texto em observações), igual um lead sem formulário.
};

function mapearQualificacaoYayforms_(answers, formId) {
  var q = { estabelecimento: null, timeComercial: null, faturamento6meses: null, ondeTrava: [], instagram: "" };
  var mapaForm = MAPAS_FORMULARIO_QUALIFICACAO_[formId];
  if (!mapaForm) return q;

  answers.forEach(function (a) {
    var cfg = mapaForm[a.fieldId];
    if (!cfg || a.content === null || a.content === undefined) return;
    var valorTexto = Array.isArray(a.content) ? a.content.join(", ") : String(a.content);
    valorTexto = valorTexto.trim();
    if (!valorTexto) return;

    if (cfg.tipo === "texto") {
      q[cfg.chave] = valorTexto;
    } else if (cfg.tipo === "opcao") {
      // Comparação EXATA de propósito: já sabemos com certeza qual pergunta
      // é essa (foi o ID que decidiu), então não tem por que adivinhar o
      // valor por pedaço de texto — se a opção ainda não está no "mapa",
      // fica de fora (visível nos comentários acima) em vez de arriscar
      // um match errado.
      var codigo = cfg.mapa[valorTexto];
      if (codigo) q[cfg.chave] = codigo;
    } else if (cfg.tipo === "multipla") {
      var selecionados = Array.isArray(a.content) ? a.content : [String(a.content)];
      selecionados.forEach(function (sel) {
        var s = String(sel).trim();
        if (cfg.opcoes.indexOf(s) > -1 && q.ondeTrava.indexOf(s) === -1) q.ondeTrava.push(s);
      });
    }
  });
  return q;
}

// A YayForms manda o ID da resposta em algum lugar do corpo do webhook —
// como o formato exato do payload varia (v1/v2, e pode mudar), tenta
// alguns caminhos comuns e, se nenhum bater, cai pra procurar qualquer
// `"id":"<24 caracteres hexadecimais>"` no texto bruto (é assim que a
// YayForms formata IDs em toda a API — bem confiável na prática).
function extrairResponseIdYayforms_(corpo, corpoTexto) {
  var candidatos = [
    corpo && corpo.response && corpo.response.id,
    corpo && corpo.responseId,
    corpo && corpo.id,
    corpo && corpo.data && corpo.data.id,
    corpo && corpo.data && corpo.data.responseId
  ];
  for (var i = 0; i < candidatos.length; i++) {
    if (candidatos[i] && /^[a-f0-9]{24}$/i.test(candidatos[i])) return candidatos[i];
  }
  var m = corpoTexto.match(/"id"\s*:\s*"([a-f0-9]{24})"/i);
  return m ? m[1] : null;
}

// Tenta descobrir nome/telefone/e-mail nas respostas de um formulário
// (formato livre — cada form tem perguntas diferentes) combinando o texto
// da pergunta ("fieldPlainTitle") com o formato do valor respondido. Nada
// disso é perdido mesmo se a classificação errar: TODAS as respostas
// também viram texto em "linhas", que vai pras observações do lead.
function extrairContatoRespostaYayforms_(answers) {
  var nome = "", telefone = "", email = "";
  var linhas = [];
  answers.forEach(function (a) {
    if (a.content === null || a.content === undefined) return;
    var valorTexto = Array.isArray(a.content) ? a.content.join(", ") : String(a.content);
    if (!valorTexto.trim()) return;
    var tituloBase = a.fieldPlainTitle || a.fieldTitle || "Pergunta";
    // Tira as tags de html de fieldTitle se for o caso
    tituloBase = tituloBase.replace(/<[^>]*>?/gm, '');
    var tituloLower = tituloBase.toLowerCase();
    
    var pareceEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(valorTexto.trim());
    var pareceTelefone = /^[\d+()\s-]{8,20}$/.test(valorTexto.trim());
    if (!nome && !pareceEmail && !pareceTelefone && tituloLower.indexOf("nome") > -1) {
      nome = valorTexto;
    } else if (!email && (pareceEmail || tituloLower.indexOf("email") > -1 || tituloLower.indexOf("e-mail") > -1)) {
      email = valorTexto;
    } else if (!telefone && (pareceTelefone || tituloLower.indexOf("telefone") > -1 || tituloLower.indexOf("whatsapp") > -1 || tituloLower.indexOf("celular") > -1)) {
      telefone = valorTexto;
    }
    linhas.push(tituloBase + ": " + valorTexto);
  });
  return { nome: nome, telefone: telefone, email: email, linhas: linhas };
}

// ══════════════ FIRESTORE REST (só usado pelo webhook da YayForms) ══════════════
//
// O resto deste sistema fala com o Firestore direto do navegador, via SDK
// — mas não existe "navegador" esperando quando um webhook chega aqui.
// Estas funções chamam a API REST pública do Firestore.
// Agora usando a conta-robô para respeitar as regras de firestore (papel automacao).

function obterIdTokenRobo_() {
  var cache = CacheService.getScriptCache();
  var tokenInfo = cache.get("ROBOT_AUTH_TOKEN");
  if (tokenInfo) return tokenInfo;
  
  var props = PropertiesService.getScriptProperties();
  var email = props.getProperty("FIREBASE_ROBOT_EMAIL");
  var pwd = props.getProperty("FIREBASE_ROBOT_PASSWORD");
  if (!email || !pwd) throw new Error("FIREBASE_ROBOT_EMAIL ou FIREBASE_ROBOT_PASSWORD ausente nas Script Properties.");

  var url = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + FIRESTORE_API_KEY_;
  var resp = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ email: email, password: pwd, returnSecureToken: true }),
    muteHttpExceptions: true
  });
  
  var json = JSON.parse(resp.getContentText());
  if (json.error) throw new Error("Auth Robo Falhou: " + json.error.message);
  
  cache.put("ROBOT_AUTH_TOKEN", json.idToken, 3000); // cache por 50 min
  return json.idToken;
}

function valorFirestore_(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return { doubleValue: v };
  // Faltava isso: sem checar array ANTES do "resto vira string", uma lista
  // como ondeTrava virava "String(['a','b'])" = "a,b" gravado como
  // stringValue — o app.js espera um array de verdade (chama .join nele) e
  // quebrava ao abrir o card. Recursivo pra cobrir array de objeto também,
  // se algum dia precisar.
  if (Array.isArray(v)) return { arrayValue: { values: v.map(valorFirestore_) } };
  return { stringValue: String(v) };
}

function criarDocumentoFirestore_(colecao, dados) {
  var fields = {};
  Object.keys(dados).forEach(function (k) { fields[k] = valorFirestore_(dados[k]); });
  var agora = new Date().toISOString();
  fields.createdAt = { timestampValue: agora };
  fields.updatedAt = { timestampValue: agora };
  if (colecao === "agendamentos") fields.dataEntrouEtapa = { timestampValue: agora };
  var url = "https://firestore.googleapis.com/v1/projects/" + FIRESTORE_PROJECT_ID_ + "/databases/(default)/documents/" + colecao + "?key=" + FIRESTORE_API_KEY_;
  var resp = UrlFetchApp.fetch(url, {
    method: "post", contentType: "application/json",
    headers: { Authorization: "Bearer " + obterIdTokenRobo_() },
    payload: JSON.stringify({ fields: fields }), muteHttpExceptions: true
  });
  var json = JSON.parse(resp.getContentText());
  if (json.error) throw new Error("Firestore (" + colecao + "): " + json.error.message);
  var partes = json.name.split("/");
  return partes[partes.length - 1];
}

// Acha a etapa com menor "ordem" em etapasAgendamentoConfig (normalmente
// "Novo Lead") — é nela que todo lead vindo de formulário nasce, do mesmo
// jeito que um lead criado manualmente no sistema.
function obterPrimeiraEtapaAgendamento_() {
  var url = "https://firestore.googleapis.com/v1/projects/" + FIRESTORE_PROJECT_ID_ + "/databases/(default)/documents/etapasAgendamentoConfig?key=" + FIRESTORE_API_KEY_ + "&pageSize=100";
  var resp = UrlFetchApp.fetch(url, { 
    headers: { Authorization: "Bearer " + obterIdTokenRobo_() },
    muteHttpExceptions: true 
  });
  var json = JSON.parse(resp.getContentText());
  var docs = json.documents || [];
  var melhor = null;
  docs.forEach(function (d) {
    var campoOrdem = d.fields && d.fields.ordem;
    var ordem = campoOrdem ? Number(campoOrdem.integerValue != null ? campoOrdem.integerValue : campoOrdem.doubleValue) : 999999;
    if (!melhor || ordem < melhor.ordem) {
      var partes = d.name.split("/");
      melhor = { id: partes[partes.length - 1], ordem: ordem };
    }
  });
  return melhor ? melhor.id : null;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ══════════════ LANÇAMENTO DIÁRIO DE ROTINAS (Frente 2) ══════════════

function instalarTriggerRotinas() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "acaoLancarRotinasDiarias_") return;
  }
  ScriptApp.newTrigger("acaoLancarRotinasDiarias_")
    .timeBased()
    .atHour(0)
    .everyDays(1)
    .create();
}

function acaoLancarRotinasDiarias_() {
  try {
    var token = obterIdTokenRobo_();
    var hoje = new Date().toISOString().slice(0, 10);
    var urlRotinas = "https://firestore.googleapis.com/v1/projects/" + FIRESTORE_PROJECT_ID_ + "/databases/(default)/documents/rotinas?key=" + FIRESTORE_API_KEY_ + "&pageSize=300";
    var respRotinas = UrlFetchApp.fetch(urlRotinas, { headers: { Authorization: "Bearer " + token }, muteHttpExceptions: true });
    var jsonRotinas = JSON.parse(respRotinas.getContentText());
    if (jsonRotinas.error) throw new Error("Erro ler rotinas: " + jsonRotinas.error.message);
    
    var rotinas = jsonRotinas.documents || [];
    
    var urlEtapas = "https://firestore.googleapis.com/v1/projects/" + FIRESTORE_PROJECT_ID_ + "/databases/(default)/documents/etapasTarefaConfig?key=" + FIRESTORE_API_KEY_ + "&pageSize=100";
    var respEtapas = UrlFetchApp.fetch(urlEtapas, { headers: { Authorization: "Bearer " + token }, muteHttpExceptions: true });
    var jsonEtapas = JSON.parse(respEtapas.getContentText());
    var docs = jsonEtapas.documents || [];
    var melhor = null;
    docs.forEach(function (d) {
      var campoOrdem = d.fields && d.fields.ordem;
      var ordem = campoOrdem ? Number(campoOrdem.integerValue != null ? campoOrdem.integerValue : campoOrdem.doubleValue) : 999999;
      if (!melhor || ordem < melhor.ordem) {
        var partes = d.name.split("/");
        melhor = { id: partes[partes.length - 1], ordem: ordem };
      }
    });
    var etapaInicialId = melhor ? melhor.id : "a_fazer";

    var diaSemanaHj = new Date().getDay(); 

    rotinas.forEach(function (r) {
      var rotinaId = r.name.split("/").pop();
      var f = r.fields || {};
      var ativa = f.ativa && f.ativa.booleanValue;
      if (!ativa) return;
      
      var diasSemana = [];
      if (f.diasSemana && f.diasSemana.arrayValue && f.diasSemana.arrayValue.values) {
        diasSemana = f.diasSemana.arrayValue.values.map(function(v) { return Number(v.integerValue != null ? v.integerValue : v.doubleValue); });
      }
      if (diasSemana.length > 0 && diasSemana.indexOf(diaSemanaHj) === -1) return;

      var queryUrl = "https://firestore.googleapis.com/v1/projects/" + FIRESTORE_PROJECT_ID_ + "/databases/(default)/documents:runQuery?key=" + FIRESTORE_API_KEY_;
      var queryPayload = {
        structuredQuery: {
          from: [{ collectionId: "tarefas" }],
          where: {
            compositeFilter: {
              op: "AND",
              filters: [
                { fieldFilter: { field: { fieldPath: "origemRotinaId" }, op: "EQUAL", value: { stringValue: rotinaId } } },
                { fieldFilter: { field: { fieldPath: "dataReferencia" }, op: "EQUAL", value: { stringValue: hoje } } }
              ]
            }
          }
        }
      };
      
      var respQuery = UrlFetchApp.fetch(queryUrl, {
        method: "post", contentType: "application/json",
        headers: { Authorization: "Bearer " + token },
        payload: JSON.stringify(queryPayload), muteHttpExceptions: true
      });
      var jsonQuery = JSON.parse(respQuery.getContentText());
      if (jsonQuery && jsonQuery.length > 0 && jsonQuery[0].document) {
        console.log("Tarefa já existe para rotina " + rotinaId + " na data " + hoje);
        return;
      }
      
      var subtarefasList = [];
      if (f.checklistTemplate && f.checklistTemplate.arrayValue && f.checklistTemplate.arrayValue.values) {
        subtarefasList = f.checklistTemplate.arrayValue.values.map(function(v) { 
          return { mapValue: { fields: { titulo: { stringValue: v.stringValue }, feito: { booleanValue: false } } } }; 
        });
      }

      var fields = {
        titulo: f.titulo ? f.titulo : { stringValue: "" },
        descricao: { stringValue: "Lançamento automático de rotina" },
        responsavelUid: f.responsavelUid ? f.responsavelUid : { stringValue: "" },
        etapa: { stringValue: etapaInicialId },
        origemRotinaId: { stringValue: rotinaId },
        dataReferencia: { stringValue: hoje },
        prazo: { stringValue: "" }
      };
      if (subtarefasList.length > 0) {
        fields.subtarefas = { arrayValue: { values: subtarefasList } };
      } else {
        fields.subtarefas = { arrayValue: { values: [] } };
      }
      
      var agora = new Date().toISOString();
      fields.createdAt = { timestampValue: agora };
      fields.updatedAt = { timestampValue: agora };
      fields.dataEntrouEtapa = { timestampValue: agora };
      
      var urlCreate = "https://firestore.googleapis.com/v1/projects/" + FIRESTORE_PROJECT_ID_ + "/databases/(default)/documents/tarefas?key=" + FIRESTORE_API_KEY_;
      UrlFetchApp.fetch(urlCreate, {
        method: "post", contentType: "application/json",
        headers: { Authorization: "Bearer " + token },
        payload: JSON.stringify({ fields: fields }), muteHttpExceptions: true
      });
    });

  } catch (err) {
    console.error("Erro na acaoLancarRotinasDiarias_:", String(err));
  }
}

// ══════════════ FAST START: CHECKOUT (inscrição + Link de Pagamento PicPay) ══════════════
//
// A página pública fast-start/ (GitHub Pages) não grava no Firestore: ela
// manda os dados pra cá (crença 12), e este script grava pela conta-robô.
//
//   fsRegistrar        etapa 2 concluída: cria o cliente (produto Fast
//                      Start) e o card no Funil de Agendamento (quem parar
//                      aqui já é lead pra SDR) e a inscrição em
//                      inscricoesFastStart, que guarda o estado do checkout.
//   fsPagamento        etapa 4: cria (uma vez só) o Link de Pagamento da
//                      PicPay com cartão até 12x e Pix, e devolve o link e o
//                      código Pix (brcode).
//   fsStatus           a página pergunta se já pagou; aqui se consulta a
//                      própria PicPay (nunca se confia no navegador). Pago
//                      vira status "pago" na inscrição + uma tarefa pra
//                      equipe gerar o contrato e lançar o recebimento.
//   verificarPendentesFastStart (gatilho a cada 15 min): mesma consulta pra
//                      quem pagou e fechou a aba antes de voltar.
//
// Script Properties: PICPAY_AMBIENTE ("sandbox" ou "producao"),
// PICPAY_CLIENT_ID e PICPAY_CLIENT_SECRET (produção) e
// PICPAY_SANDBOX_CLIENT_ID e PICPAY_SANDBOX_CLIENT_SECRET (teste). As
// credenciais saem do Painel PicPay Empresas > Integrações (o secret aparece
// uma vez só). Em sandbox, cliente e card nascem com "(TESTE)" no nome.
//
// Webhook da PicPay não é usado: Apps Script não lê o header authorization
// que ela manda, e a URL de notificação não aceita query string. A consulta
// ativa (fsStatus + gatilho) cobre o mesmo caso.

var FS_VALOR_CENTAVOS_ = 499700;
var FS_PARCELAS_MAX_ = 12;
var FS_PAGINA_ = "https://pampfelp.github.io/Jornada-milhao/fast-start/";
var FS_COLECAO_ = "inscricoesFastStart";
var FS_CAMPOS_ = ["cnpj", "razaoSocial", "cep", "numero", "endereco", "cidade", "representanteNome", "representanteCpf", "email", "whatsapp"];

// Produção usa PICPAY_CLIENT_ID/SECRET (card "Link de Pagamento - API" do
// painel); sandbox usa PICPAY_SANDBOX_CLIENT_ID/SECRET (card "Credenciais de
// teste"). Uma não funciona no ambiente da outra: dá 401 invalid_client.
// Trocar de ambiente é mudar só PICPAY_AMBIENTE.
function picpayConfig_() {
  var p = PropertiesService.getScriptProperties();
  var limpo = function (k) { return String(p.getProperty(k) || "").trim(); };
  var amb = limpo("PICPAY_AMBIENTE").toLowerCase() || "sandbox";
  var producao = amb === "producao" || amb === "produção" || amb === "production";
  return {
    clientId: producao ? limpo("PICPAY_CLIENT_ID") : limpo("PICPAY_SANDBOX_CLIENT_ID"),
    clientSecret: producao ? limpo("PICPAY_CLIENT_SECRET") : limpo("PICPAY_SANDBOX_CLIENT_SECRET"),
    urlToken: producao ? "https://ecommerce-api.svc.picpay.com/oauth2/token" : "https://api.ms.qa.limbo.work/oauth2/token",
    urlApi: producao ? "https://ecommerce-api.svc.picpay.com/v1" : "https://api.ms.qa.limbo.work/sandbox/v1",
    ambiente: producao ? "producao" : "sandbox"
  };
}

// Token da PicPay vale 5 minutos; guardado por 4 pra não pedir a cada chamada.
function picpayToken_() {
  var cfg = picpayConfig_();
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error(cfg.ambiente === "producao"
      ? "PICPAY_CLIENT_ID ou PICPAY_CLIENT_SECRET ausente nas Script Properties."
      : "PICPAY_SANDBOX_CLIENT_ID ou PICPAY_SANDBOX_CLIENT_SECRET ausente nas Script Properties.");
  }
  var cache = CacheService.getScriptCache();
  var chave = "PICPAY_TOKEN_" + cfg.ambiente;
  var guardado = cache.get(chave);
  if (guardado) return guardado;
  var resp = UrlFetchApp.fetch(cfg.urlToken, {
    method: "post", contentType: "application/json", muteHttpExceptions: true,
    payload: JSON.stringify({ grant_type: "client_credentials", client_id: cfg.clientId, client_secret: cfg.clientSecret })
  });
  var json = {};
  try { json = JSON.parse(resp.getContentText()); } catch (err) {}
  if (resp.getResponseCode() !== 200 || !json.access_token) {
    throw new Error("PicPay recusou as credenciais (" + resp.getResponseCode() + ", ambiente " + cfg.ambiente +
                    (json.error_description ? ": " + json.error_description : "") + ").");
  }
  cache.put(chave, json.access_token, 240);
  return json.access_token;
}

function picpay_(metodo, caminho, corpo) {
  var cfg = picpayConfig_();
  var opcoes = { method: metodo, muteHttpExceptions: true, headers: { Authorization: "Bearer " + picpayToken_(), Accept: "application/json" } };
  if (corpo) { opcoes.contentType = "application/json"; opcoes.payload = JSON.stringify(corpo); }
  var resp = UrlFetchApp.fetch(cfg.urlApi + caminho, opcoes);
  var json = {};
  try { json = JSON.parse(resp.getContentText() || "{}"); } catch (err) {}
  return { status: resp.getResponseCode(), json: json };
}

// ── validação (a mesma da página; aqui é a que vale) ──

function fsDigitos_(v) { return String(v || "").replace(/\D/g, ""); }

function fsCpfValido_(v) {
  var d = fsDigitos_(v);
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
  for (var t = 9; t <= 10; t++) {
    var s = 0;
    for (var i = 0; i < t; i++) s += Number(d[i]) * (t + 1 - i);
    if (((s * 10) % 11) % 10 !== Number(d[t])) return false;
  }
  return true;
}

function fsCnpjValido_(v) {
  var d = fsDigitos_(v);
  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
  function calc(n) {
    var pesos = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    var s = 0;
    for (var i = 0; i < pesos.length; i++) s += Number(d[i]) * pesos[i];
    var r = s % 11;
    return r < 2 ? 0 : 11 - r;
  }
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}

function fsLimparDados_(dados) {
  var limpo = {};
  FS_CAMPOS_.forEach(function (c) { limpo[c] = String((dados && dados[c]) || "").trim().slice(0, 200); });
  var problemas = [];
  if (!fsCnpjValido_(limpo.cnpj)) problemas.push("CNPJ");
  if (limpo.razaoSocial.length < 3) problemas.push("razão social");
  if (fsDigitos_(limpo.cep).length !== 8) problemas.push("CEP");
  if (!limpo.endereco || !limpo.numero || !limpo.cidade) problemas.push("endereço");
  if (limpo.representanteNome.split(/\s+/).length < 2) problemas.push("nome completo");
  if (!fsCpfValido_(limpo.representanteCpf)) problemas.push("CPF");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(limpo.email)) problemas.push("e-mail");
  var tel = fsDigitos_(limpo.whatsapp).length;
  if (tel !== 10 && tel !== 11) problemas.push("WhatsApp");
  return { dados: limpo, problemas: problemas };
}

// ── Firestore: ler e atualizar um documento (a criação já existe acima) ──

function lerDocumentoFirestore_(colecao, id) {
  var url = "https://firestore.googleapis.com/v1/projects/" + FIRESTORE_PROJECT_ID_ + "/databases/(default)/documents/" + colecao + "/" + encodeURIComponent(id) + "?key=" + FIRESTORE_API_KEY_;
  var resp = UrlFetchApp.fetch(url, { headers: { Authorization: "Bearer " + obterIdTokenRobo_() }, muteHttpExceptions: true });
  if (resp.getResponseCode() === 404) return null;
  var json = JSON.parse(resp.getContentText());
  if (json.error) throw new Error("Firestore (" + colecao + "): " + json.error.message);
  var saida = {};
  Object.keys(json.fields || {}).forEach(function (k) {
    var f = json.fields[k];
    saida[k] = f.stringValue != null ? f.stringValue : f.booleanValue != null ? f.booleanValue
             : f.doubleValue != null ? f.doubleValue : f.integerValue != null ? Number(f.integerValue)
             : f.timestampValue != null ? f.timestampValue : null;
  });
  return saida;
}

function atualizarDocumentoFirestore_(colecao, id, dados) {
  var fields = {};
  var mascara = [];
  Object.keys(dados).forEach(function (k) { fields[k] = valorFirestore_(dados[k]); mascara.push("updateMask.fieldPaths=" + encodeURIComponent(k)); });
  fields.updatedAt = { timestampValue: new Date().toISOString() };
  mascara.push("updateMask.fieldPaths=updatedAt");
  var url = "https://firestore.googleapis.com/v1/projects/" + FIRESTORE_PROJECT_ID_ + "/databases/(default)/documents/" + colecao + "/" + encodeURIComponent(id) + "?key=" + FIRESTORE_API_KEY_ + "&" + mascara.join("&");
  var resp = UrlFetchApp.fetch(url, {
    method: "patch", contentType: "application/json",
    headers: { Authorization: "Bearer " + obterIdTokenRobo_() },
    payload: JSON.stringify({ fields: fields }), muteHttpExceptions: true
  });
  var json = JSON.parse(resp.getContentText());
  if (json.error) throw new Error("Firestore (" + colecao + "): " + json.error.message);
}

function fsPrimeiraEtapa_(colecaoConfig, padrao) {
  var url = "https://firestore.googleapis.com/v1/projects/" + FIRESTORE_PROJECT_ID_ + "/databases/(default)/documents/" + colecaoConfig + "?key=" + FIRESTORE_API_KEY_ + "&pageSize=100";
  var resp = UrlFetchApp.fetch(url, { headers: { Authorization: "Bearer " + obterIdTokenRobo_() }, muteHttpExceptions: true });
  var docs = (JSON.parse(resp.getContentText()).documents) || [];
  var melhor = null;
  docs.forEach(function (d) {
    var o = d.fields && d.fields.ordem;
    var ordem = o ? Number(o.integerValue != null ? o.integerValue : o.doubleValue) : 999999;
    if (!melhor || ordem < melhor.ordem) melhor = { id: d.name.split("/").pop(), ordem: ordem };
  });
  return melhor ? melhor.id : padrao;
}

// A inscrição só é mexida por quem tem a chave que ela recebeu ao nascer
// (fica na sessão do navegador de quem preencheu).
function fsCarregar_(body) {
  if (!body.inscricaoId || !body.chave) return null;
  var insc = lerDocumentoFirestore_(FS_COLECAO_, String(body.inscricaoId));
  if (!insc || insc.chave !== String(body.chave)) return null;
  return insc;
}

// ── ações chamadas pela página ──

function acaoFsRegistrar_(body) {
  if (body.site) return { ok: true, inscricaoId: "", chave: "" }; // honeypot: robô preencheu o campo escondido
  var v = fsLimparDados_(body.dados);
  if (v.problemas.length) return { ok: false, erro: "Confira: " + v.problemas.join(", ") + "." };
  var d = v.dados;
  var teste = picpayConfig_().ambiente !== "producao";
  var sufixo = teste ? " (TESTE)" : "";

  var existente = fsCarregar_(body);
  if (existente) {
    // Voltou e corrigiu algum dado: a inscrição guarda a versão nova. O
    // cliente já criado continua como nasceu (o robô só cria, não edita).
    var patch = {};
    FS_CAMPOS_.forEach(function (c) { patch[c] = d[c]; });
    atualizarDocumentoFirestore_(FS_COLECAO_, body.inscricaoId, patch);
    return { ok: true, inscricaoId: body.inscricaoId, chave: body.chave };
  }

  var enderecoCompleto = d.endereco + ", " + d.numero + " - " + d.cidade + " - CEP " + d.cep;
  var nome = d.razaoSocial + sufixo;
  var clienteId = criarDocumentoFirestore_("clientes", {
    nome: nome, telefone: d.whatsapp, email: d.email, cpfCnpj: d.cnpj, endereco: enderecoCompleto,
    representanteNome: d.representanteNome, representanteCpf: d.representanteCpf,
    origem: "Checkout Fast Start" + sufixo, produto: "fast_start", observacoes: ""
  });
  var hoje = Utilities.formatDate(new Date(), "America/Belem", "dd/MM/yyyy HH:mm");
  var agendamentoId = criarDocumentoFirestore_("agendamentos", {
    clienteId: clienteId, clienteNome: nome, telefone: d.whatsapp, email: d.email,
    data: "", hora: "", etapa: fsPrimeiraEtapa_("etapasAgendamentoConfig", ""),
    convertido: false, enviadoAgenda: false, motivoPerda: "", formCompleto: false,
    observacoes: "Checkout Fast Start: preencheu empresa e responsável em " + hoje + ".\n" +
                 "Representante: " + d.representanteNome + " (" + d.email + ").\n" +
                 "Se não pagar, é lead pra recuperar. Pagamento confirmado vira tarefa pra equipe."
  });
  var chave = Utilities.getUuid();
  var doc = { status: "dados", chave: chave, clienteId: clienteId, agendamentoId: agendamentoId, ambiente: teste ? "sandbox" : "producao" };
  FS_CAMPOS_.forEach(function (c) { doc[c] = d[c]; });
  var inscricaoId = criarDocumentoFirestore_(FS_COLECAO_, doc);
  return { ok: true, inscricaoId: inscricaoId, chave: chave };
}

function acaoFsPagamento_(body) {
  var insc = fsCarregar_(body);
  if (!insc) return { ok: false, erro: "Inscrição não encontrada. Recarregue a página." };
  if (insc.status === "pago") return { ok: true, pago: true };
  if (!insc.contratoAssinadoEm) return { ok: false, erro: "Assine o contrato antes do pagamento." };
  var hoje = Utilities.formatDate(new Date(), "America/Belem", "yyyy-MM-dd");
  if (insc.link && insc.brcode && insc.linkExpiraEm && insc.linkExpiraEm > hoje) {
    return { ok: true, link: insc.link, brcode: insc.brcode };
  }
  var expiraTexto = Utilities.formatDate(new Date(Date.now() + 3 * 24 * 3600 * 1000), "America/Belem", "yyyy-MM-dd");
  var r = picpay_("post", "/paymentlink/create", {
    charge: {
      name: "Fast Start",
      description: ("Inscrição Fast Start - " + insc.razaoSocial).slice(0, 120),
      order_number: String(body.inscricaoId).slice(0, 15),
      redirect_url: FS_PAGINA_ + "?retorno=" + encodeURIComponent(body.inscricaoId) + (insc.ambiente === "sandbox" ? "&modo=teste" : ""),
      payment: { methods: ["CREDIT_CARD", "BRCODE"], brcode_arrangements: ["PIX"] },
      amounts: { product: FS_VALOR_CENTAVOS_ }
    },
    options: { allow_create_pix_key: true, card_max_installment_number: FS_PARCELAS_MAX_, expired_at: expiraTexto }
  });
  if (r.status !== 201 && r.status !== 200) {
    var msg = r.json && r.json.error && r.json.error.message;
    return { ok: false, erro: "A PicPay não criou o pagamento" + (msg ? ": " + msg : " (" + r.status + ")") + "." };
  }
  var link = r.json.link || "";
  atualizarDocumentoFirestore_(FS_COLECAO_, body.inscricaoId, {
    status: "aguardando_pagamento", link: link, linkId: link.split("/").pop(), brcode: r.json.brcode || "", linkExpiraEm: expiraTexto
  });
  return { ok: true, link: link, brcode: r.json.brcode || "" };
}

function acaoFsStatus_(body) {
  var insc = fsCarregar_(body);
  if (!insc) return { ok: false, erro: "Inscrição não encontrada." };
  return { ok: true, pago: fsConferirPagamento_(body.inscricaoId, insc) };
}

// Pergunta à PicPay se o link desta inscrição tem transação paga. Se tiver
// e ainda não estava marcado, marca como pago e cria a tarefa pra equipe.
// O lock impede que duas consultas ao mesmo tempo criem duas tarefas.
function fsConferirPagamento_(inscricaoId, insc) {
  if (insc.status === "pago") return true;
  if (!insc.linkId) return false;
  var r = picpay_("get", "/paymentlink/" + encodeURIComponent(insc.linkId) + "/transactions");
  var pagas = ((r.json && r.json.transactions) || []).filter(function (t) { return t.status === "PAYED"; });
  if (!pagas.length) return false;

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var atual = lerDocumentoFirestore_(FS_COLECAO_, inscricaoId);
    if (atual.status === "pago") return true;
    var tx = pagas[0];
    var valor = Number(tx.amount || 0);
    var quando = Utilities.formatDate(new Date(), "America/Belem", "dd/MM/yyyy HH:mm");
    atualizarDocumentoFirestore_(FS_COLECAO_, inscricaoId, {
      status: "pago", pagoEm: new Date().toISOString(), transacaoId: tx.id || "", valorPagoCentavos: valor
    });
    criarDocumentoFirestore_("tarefas", {
      titulo: "Fast Start pago: " + atual.razaoSocial + (atual.ambiente === "sandbox" ? " (TESTE)" : ""),
      descricao: "Pagamento confirmado pela PicPay em " + quando + " (R$ " + (valor / 100).toFixed(2).replace(".", ",") + ").\n" +
                 "Empresa: " + atual.razaoSocial + " - CNPJ " + atual.cnpj + "\n" +
                 "Representante: " + atual.representanteNome + " - " + atual.email + " - " + atual.whatsapp + "\n" +
                 "Fazer: gerar o contrato do Fast Start no sistema, lançar o recebimento e mandar a data de início no WhatsApp.\n" +
                 "Inscrição " + inscricaoId + ", link PicPay " + atual.linkId + ".",
      responsavelUid: "", etapa: fsPrimeiraEtapa_("etapasTarefaConfig", "a_fazer"),
      dataReferencia: Utilities.formatDate(new Date(), "America/Belem", "yyyy-MM-dd"), prazo: "", subtarefas: []
    });
    return true;
  } finally {
    lock.releaseLock();
  }
}

// Rode uma vez no editor (▶) pra ligar a conferência a cada 15 minutos.
function instalarTriggerFastStart() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "verificarPendentesFastStart") return;
  }
  ScriptApp.newTrigger("verificarPendentesFastStart").timeBased().everyMinutes(15).create();
}

function verificarPendentesFastStart() {
  try {
    var url = "https://firestore.googleapis.com/v1/projects/" + FIRESTORE_PROJECT_ID_ + "/databases/(default)/documents:runQuery?key=" + FIRESTORE_API_KEY_;
    var resp = UrlFetchApp.fetch(url, {
      method: "post", contentType: "application/json", muteHttpExceptions: true,
      headers: { Authorization: "Bearer " + obterIdTokenRobo_() },
      payload: JSON.stringify({ structuredQuery: {
        from: [{ collectionId: FS_COLECAO_ }],
        where: { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "aguardando_pagamento" } } },
        limit: 50
      } })
    });
    (JSON.parse(resp.getContentText()) || []).forEach(function (linha) {
      if (!linha.document) return;
      var id = linha.document.name.split("/").pop();
      var insc = lerDocumentoFirestore_(FS_COLECAO_, id);
      if (insc) fsConferirPagamento_(id, insc);
    });
  } catch (err) {
    console.error("verificarPendentesFastStart:", String(err));
  }
}

// Rode no editor (▶) pra testar as credenciais da PicPay sem passar pela
// página: cria um link de R$ 1,00 e mostra no log se deu certo.
function testarPicPay() {
  var cfg = picpayConfig_();
  var r = picpay_("post", "/paymentlink/create", {
    charge: { name: "Teste de integração", description: "Teste", order_number: "teste" + Date.now().toString().slice(-8),
              redirect_url: FS_PAGINA_, payment: { methods: ["CREDIT_CARD", "BRCODE"], brcode_arrangements: ["PIX"] },
              amounts: { product: 100 } },
    options: { allow_create_pix_key: true, card_max_installment_number: 1,
               expired_at: Utilities.formatDate(new Date(Date.now() + 24 * 3600 * 1000), "America/Belem", "yyyy-MM-dd") }
  });
  console.log("Ambiente: " + cfg.ambiente + " | status " + r.status + " | link: " + (r.json.link || JSON.stringify(r.json)));
}

// ── Fast Start: contrato e assinatura na Autentique (etapa 3) ──
//
// O contrato é montado AQUI, a partir dos dados validados da inscrição,
// nunca na página: se a página mandasse o HTML, dava pra alterar cláusula
// no navegador e a assinatura do contratado seria aplicada sozinha nesse
// texto. Por isso o modelo existe em duas cópias (esta e a do app.js,
// montarHtmlContratoFastStart); mudou o texto lá, muda aqui na mesma sessão.
//
//   fsContrato        gera o PDF, cria o documento na Autentique com dois
//                     signatários (a conta dona do AUTENTIQUE_API_TOKEN, que
//                     assina na hora pelo signDocument, e o representante,
//                     que recebe link próprio) e devolve o link dele.
//   fsContratoStatus  pergunta à Autentique se o representante já assinou.
//
// Assinatura de teste: quando PICPAY_AMBIENTE não é "producao", o documento
// nasce em sandbox na Autentique (não gasta crédito, some em alguns dias).

var FS_LOGO_URL_ = "https://pampfelp.github.io/Jornada-milhao/fast-start-logo.png";
// Cláusula 3 e quadro "Investimento" com o texto aprovado por ele em
// 2026-10-20 (página de termos): a forma é escolhida depois, no pagamento.
var FS_PAGAMENTO_CONTRATO_ = {
  destaque: "À vista no Pix ou em até 12x sem juros no cartão",
  detalhe: "Na inscrição, pela página de pagamento processada pela PicPay.",
  clausula: "à vista via PIX ou em até 12 (doze) parcelas sem juros no cartão de crédito, conforme a opção escolhida na página de inscrição, no ato da contratação."
};

function fsEsc_(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fsDataExtenso_() {
  var meses = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  var d = new Date();
  var dia = Number(Utilities.formatDate(d, "America/Belem", "d"));
  var mes = Number(Utilities.formatDate(d, "America/Belem", "M"));
  return dia + " de " + meses[mes - 1] + " de " + Utilities.formatDate(d, "America/Belem", "yyyy");
}

function fsQualificacao_(cliente) {
  var texto = "pessoa jurídica de direito privado, inscrita no CNPJ sob o nº " + fsEsc_(cliente.cpfCnpj) +
              ", com sede em " + fsEsc_(cliente.endereco);
  if (cliente.representanteNome) {
    texto += ", neste ato representada por " + fsEsc_(cliente.representanteNome);
    if (cliente.representanteCpf) texto += ", portador(a) do CPF nº " + fsEsc_(cliente.representanteCpf);
  }
  return texto;
}

function fsClienteDaInscricao_(insc) {
  return {
    nome: insc.razaoSocial, cpfCnpj: insc.cnpj, email: insc.email, telefone: insc.whatsapp,
    endereco: insc.endereco + ", " + insc.numero + " - " + insc.cidade + " - CEP " + insc.cep,
    representanteNome: insc.representanteNome, representanteCpf: insc.representanteCpf
  };
}

function fsLogoDataUri_() {
  try {
    var resp = UrlFetchApp.fetch(FS_LOGO_URL_, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return "";
    return "data:image/png;base64," + Utilities.base64Encode(resp.getBlob().getBytes());
  } catch (err) {
    return "";
  }
}

function autentique_(query, variaveis) {
  var token = PropertiesService.getScriptProperties().getProperty("AUTENTIQUE_API_TOKEN");
  if (!token) throw new Error("Configure AUTENTIQUE_API_TOKEN nas Script Properties.");
  var resp = UrlFetchApp.fetch(AUTENTIQUE_GRAPHQL_URL_, {
    method: "post", contentType: "application/json", muteHttpExceptions: true,
    headers: { Authorization: "Bearer " + token },
    payload: JSON.stringify({ query: query, variables: variaveis || {} })
  });
  var json = JSON.parse(resp.getContentText());
  if (json.errors && json.errors.length) throw new Error("Autentique: " + json.errors.map(function (e) { return e.message; }).join("; "));
  return json.data;
}

function acaoFsContrato_(body) {
  var insc = fsCarregar_(body);
  if (!insc) return { ok: false, erro: "Inscrição não encontrada. Recarregue a página." };
  if (insc.contratoAssinadoEm) return { ok: true, assinado: true };
  if (insc.contratoLink) return { ok: true, link: insc.contratoLink };

  var token = PropertiesService.getScriptProperties().getProperty("AUTENTIQUE_API_TOKEN");
  if (!token) return { ok: false, erro: "Assinatura indisponível agora." };
  var sandbox = picpayConfig_().ambiente !== "producao";

  var cliente = fsClienteDaInscricao_(insc);
  var html = fsMontarContratoHtml_(cliente, fsLogoDataUri_());
  var nome = "Contrato Fast Start - " + insc.razaoSocial + (sandbox ? " (TESTE)" : "");
  var pdf = Utilities.newBlob(html, "text/html", nome + ".html").getAs("application/pdf").setName(nome + ".pdf");
  var arquivo = getContratosFolder_().createFile(pdf);

  // Dono do token: precisa estar na lista pra o signDocument assinar por ele.
  var dono = autentique_("query { me { name email } }").me;

  var query = "mutation CreateDocumentMutation($document: DocumentInput!, $signers: [SignerInput!]!, $file: Upload!) { " +
    "createDocument(document: $document, signers: $signers, file: $file, sandbox: " + (sandbox ? "true" : "false") + ") { " +
    "id signatures { public_id name email link { short_link } } } }";
  var variables = {
    document: { name: nome },
    signers: [
      { email: dono.email, action: "SIGN" },
      { name: insc.representanteNome, action: "SIGN", configs: { cpf: fsDigitos_(insc.representanteCpf) } }
    ],
    file: null
  };
  var resp = UrlFetchApp.fetch(AUTENTIQUE_GRAPHQL_URL_, {
    method: "post", muteHttpExceptions: true,
    headers: { Authorization: "Bearer " + token },
    payload: { operations: JSON.stringify({ query: query, variables: variables }), map: JSON.stringify({ file: ["variables.file"] }), file: arquivo.getBlob() }
  });
  var json = JSON.parse(resp.getContentText());
  if (json.errors && json.errors.length) return { ok: false, erro: "Autentique: " + json.errors.map(function (e) { return e.message; }).join("; ") };
  var docAut = json.data.createDocument;
  var doRepresentante = (docAut.signatures || []).filter(function (s) { return !s.email && s.link && s.link.short_link; })[0];
  if (!doRepresentante) return { ok: false, erro: "A Autentique não devolveu o link de assinatura." };

  autentique_("mutation SignDocument($id: UUID!) { signDocument(id: $id) }", { id: docAut.id });

  atualizarDocumentoFirestore_(FS_COLECAO_, body.inscricaoId, {
    contratoDocId: docAut.id, contratoPublicId: doRepresentante.public_id,
    contratoLink: doRepresentante.link.short_link, contratoPdfId: arquivo.getId()
  });
  return { ok: true, link: doRepresentante.link.short_link };
}

function acaoFsContratoStatus_(body) {
  var insc = fsCarregar_(body);
  if (!insc) return { ok: false, erro: "Inscrição não encontrada." };
  if (insc.contratoAssinadoEm) return { ok: true, assinado: true };
  if (!insc.contratoDocId) return { ok: true, assinado: false };
  var doc = autentique_("query Doc($id: UUID!) { document(id: $id) { signatures { public_id signed { created_at } } } }", { id: insc.contratoDocId }).document;
  var dele = (doc.signatures || []).filter(function (s) { return s.public_id === insc.contratoPublicId; })[0];
  if (!dele || !dele.signed) return { ok: true, assinado: false };
  atualizarDocumentoFirestore_(FS_COLECAO_, body.inscricaoId, { contratoAssinadoEm: dele.signed.created_at || new Date().toISOString() });
  return { ok: true, assinado: true };
}

// Rode no editor (▶): mostra no log de quem é a conta da Autentique. É essa
// conta que assina como CONTRATADO em todo contrato do checkout.
function testarAutentique() {
  var me = autentique_("query { me { name email cpf } }").me;
  console.log("Conta da Autentique: " + me.name + " <" + me.email + ">" + (me.cpf ? " CPF final " + String(me.cpf).slice(-4) : ""));
}


// Modelo do contrato Fast Start: cópia de montarHtmlContratoFastStart (app.js),
// trocando só os dados do contrato pelos da inscrição (valor fixo R$ 4.997,00
// e a cláusula 3 aprovada pra página de inscrição).
function fsMontarContratoHtml_(cliente, logo) {
  const nomeCliente = fsEsc_(cliente.nome);
  const ehPj = fsDigitos_(cliente.cpfCnpj).length > 11;
  const contato = [cliente.email && `e-mail ${fsEsc_(cliente.email)}`, cliente.telefone && `telefone ${fsEsc_(cliente.telefone)}`].filter(Boolean).join(", ");
  const qualificacao = fsQualificacao_(cliente) + (contato ? `, ${contato}` : "");
  const pagamento = FS_PAGAMENTO_CONTRATO_;
  const valorTotalTexto = "R$ 4.997,00";
  const logoImg = (classe) => logo ? `<img class="${classe}" src="${logo}" alt="Fast Start">` : "";
  const assinaturaContratante = ehPj
    ? `<div class="ass-nome">Razão social: ${nomeCliente}</div>
       ${cliente.representanteNome ? `<div class="ass-info">Representante: ${fsEsc_(cliente.representanteNome)}</div>` : ""}
       ${cliente.representanteCpf ? `<div class="ass-info">CPF: ${fsEsc_(cliente.representanteCpf)}</div>` : ""}`
    : `<div class="ass-nome">Nome: ${nomeCliente}</div>
       <div class="ass-info">CPF: ${fsEsc_(cliente.cpfCnpj || "—")}</div>`;
  const secao = (num, titulo) => `<div class="secao-esp"><table class="secao"><tr><td class="secao-num">${num}</td><td class="secao-tit">${titulo}</td></tr></table></div>`;
  const p = (num, texto) => `<p><span class="n">${num}</span>  ${texto}</p>`;
  const dia = (num, rotulo, titulo, itens) => `<table class="dia"><tr>
    <td class="dia-rot"><div class="dia-num">${num}</div><div class="dia-nome">${rotulo}</div></td>
    <td class="dia-cont"><div class="dia-tit">${titulo}</div><ul>${itens.map((i) => `<li>${i}</li>`).join("")}</ul></td>
  </tr></table>`;
  const alineas = (itens) => `<div class="alineas">${itens.map(([l, t]) => `<p><span class="n">${l})</span>  ${t}</p>`).join("")}</div>`;

  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Contrato Fast Start - ${nomeCliente}</title>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;700&display=swap" rel="stylesheet">
<style>
*{-webkit-print-color-adjust:exact;print-color-adjust:exact;box-sizing:border-box;}
@page{size:A4;margin:0 0 22mm 0;
  @bottom-left{content:"FAST START  \\2022  A primeira aceleradora do solar";white-space:pre;font-family:Poppins,Arial,sans-serif;font-size:7.5pt;color:#6B6258;margin-left:20mm;margin-top:4mm;padding-top:1.6mm;border-top:0.4mm solid #F5B21F;vertical-align:top;}
  @bottom-right{content:"Página " counter(page) " de " counter(pages);font-family:Poppins,Arial,sans-serif;font-size:7.5pt;color:#6B6258;margin-right:20mm;margin-top:4mm;padding-top:1.6mm;border-top:0.4mm solid #F5B21F;vertical-align:top;}
}
@page capa{margin:0;@bottom-right{content:none;border:none;}@bottom-left{content:none;border:none;}}
body{margin:0;font-family:Poppins,Arial,sans-serif;font-size:9.5pt;line-height:1.57;color:#1E1E1E;text-rendering:geometricPrecision;}
.capa{page:capa;width:210mm;height:297mm;background:#160B04;text-align:center;position:relative;z-index:2;}
.capa-logo{width:87mm;margin-top:79mm;}
.capa h1{font-size:18pt;font-weight:700;line-height:1.3;margin:0;}
.capa .t1{color:#fff;margin-top:8.5mm;}
.capa .t2{color:#F5B21F;margin-top:3.6mm;}
.capa-faixa{background:#F5B21F;color:#160B04;font-weight:700;font-size:11pt;line-height:5.7mm;margin:9.5mm 22.9mm 0;}
.capa-sub{color:#D9CFC3;font-size:9.5pt;margin-top:15mm;}
.corpo{width:100%;border-collapse:collapse;}
.corpo>thead>tr>td{padding:0;}
.cab{height:19.4mm;background:#160B04;border-bottom:0.9mm solid #F5B21F;position:relative;margin-bottom:10.4mm;}
.cab-logo{position:absolute;left:20.4mm;top:1.7mm;height:13.6mm;}
.cab-txt{position:absolute;right:20mm;bottom:2.4mm;color:#F5B21F;font-weight:700;font-size:7.5pt;letter-spacing:2pt;line-height:1;}
.corpo>tbody>tr>td{padding:0 20mm;}
p{margin:0 0 7pt;text-align:justify;break-inside:avoid;}
.n{color:#C98A0E;font-weight:700;}
.rotulo{color:#C98A0E;font-weight:700;font-size:8pt;letter-spacing:2pt;margin:0 0 3pt;}
h2.titulo{font-size:15pt;font-weight:700;color:#160B04;line-height:1.45;margin:0 0 12pt;}
h3{font-size:10pt;font-weight:700;color:#160B04;margin:8pt 0 5pt -2mm;padding-left:3.1mm;border-left:0.9mm solid #F5B21F;line-height:1.5;}
.bloco{break-inside:avoid;}
.nova-pagina{break-before:page;}
/* padding no lugar de parte da margem: o Chromium zera a margem de cima
   do bloco que abre página, e o modelo mantém ~4mm abaixo do cabeçalho */
.secao-esp{margin-top:5.5mm;padding-top:4mm;}
table.secao{width:100%;border-collapse:collapse;table-layout:fixed;margin:0 0 6.4mm;}
.secao td{height:11mm;padding:0;vertical-align:middle;font-weight:700;color:#160B04;}
.secao-num{width:15.9mm;background:#160B04;color:#F5B21F !important;font-size:15pt;text-align:center;}
.secao-tit{background:#F5B21F;font-size:12pt;letter-spacing:0.5pt;text-transform:uppercase;padding-left:4mm !important;}
table.dia{width:100%;border-collapse:collapse;table-layout:fixed;margin:0 0 7.2mm;break-inside:avoid;}
.dia-rot{width:33.4mm;background:#160B04;text-align:center;vertical-align:middle;}
.dia-num{color:#fff;font-size:7.5pt;letter-spacing:1pt;line-height:1.4;}
.dia-nome{color:#F5B21F;font-size:15pt;font-weight:700;text-transform:uppercase;line-height:1.4;}
.dia-cont{background:#FDF4E1;border-bottom:0.45mm solid #F5B21F;padding:4mm 4.3mm 3.4mm;vertical-align:top;}
.dia-tit{font-size:10pt;font-weight:700;color:#160B04;line-height:1.5;margin-bottom:4pt;}
.dia-cont ul{list-style:none;margin:0;padding:0;}
.dia-cont li{font-size:9pt;line-height:1.54;margin:0 0 2pt;padding-left:6.3mm;position:relative;}
.dia-cont li:before{content:"\\25BA";color:#C98A0E;font-size:6pt;position:absolute;left:0.6mm;top:0.2mm;}
table.invest{width:100%;border-collapse:collapse;table-layout:fixed;margin:7.2mm 0 6mm;break-inside:avoid;}
.invest td{height:21.4mm;vertical-align:middle;padding:0 4.3mm;}
.invest-esq{width:63.5mm;background:#160B04;}
.invest-rot{color:#fff;font-size:7.5pt;letter-spacing:1.5pt;line-height:1.4;}
.invest-valor{color:#F5B21F;font-size:20pt;font-weight:700;line-height:1.3;}
.invest-dir{background:#F5B21F;color:#160B04;padding-left:5mm !important;}
.invest-dest{font-size:11pt;font-weight:700;line-height:1.4;}
.invest-det{font-size:9pt;line-height:1.4;}
.alineas{margin:0 0 10pt 6.3mm;}
.alineas p{margin-bottom:5pt;}
.fecho{break-inside:avoid;}
.data{text-align:right;margin:4mm 0 0;}
table.assinaturas{width:100%;border-collapse:collapse;margin-top:24mm;}
.assinaturas td{width:50%;vertical-align:top;text-align:center;font-size:9pt;line-height:1.55;}
.assinaturas td:first-child{padding-right:7mm;}
.assinaturas td:last-child{padding-left:7mm;}
.ass-linha{border-top:0.55mm solid #160B04;padding-top:3.6mm;}
.ass-papel{color:#C98A0E;font-weight:700;font-size:8.5pt;letter-spacing:1.5pt;}
.ass-nome{color:#160B04;font-weight:700;}
.ass-info{color:#6B6258;}
</style></head><body>
<div class="capa">
  ${logoImg("capa-logo")}
  <h1 class="t1">CONTRATO DE PRESTAÇÃO DE SERVIÇOS</h1>
  <h1 class="t2">DE ACELERAÇÃO COMERCIAL</h1>
  <div class="capa-faixa">Programa de 3 meses  •  Encontros semanais em grupo</div>
  <div class="capa-sub">Estruturação comercial: do time de vendas às estratégias de fechamento</div>
</div>
<table class="corpo"><thead><tr><td><div class="cab">${logoImg("cab-logo")}<div class="cab-txt">CONTRATO DE ACELERAÇÃO COMERCIAL</div></div></td></tr></thead><tbody><tr><td>

<div class="rotulo">QUALIFICAÇÃO DAS PARTES</div>
<h2 class="titulo">Contrato de Prestação de Serviços de Aceleração Comercial – Fast Start</h2>

<h3>CONTRATANTE</h3>
<p><strong>${nomeCliente}</strong>, ${qualificacao}.</p>

<h3>CONTRATADO</h3>
<p><strong>BENEDITO JOÃO VIEGAS DE MATOS</strong>, pessoa física, brasileiro, casado, CPF nº 925.437.152-15, escritório comercial localizado na Rua Municipalidade, Edifício Mirai Offices, sala 216, bairro Umarizal, Belém/PA.</p>
<p>As partes acima qualificadas têm entre si justo e contratado o presente instrumento de Prestação de Serviços de Aceleração Comercial, denominado <strong>FAST START</strong>, que se regerá pelas cláusulas e condições a seguir.</p>

<div class="bloco">${secao("01", "Objeto")}
${p("1.1", "O presente contrato tem por objeto a participação da CONTRATANTE no programa de aceleração comercial <strong>FAST START</strong>, com duração de 3 (três) meses, voltado à estruturação comercial da empresa, abrangendo desde a construção do time de vendas até a implantação de estratégias comerciais.")}</div>
${p("1.2", "O programa será executado por meio de encontros semanais <strong>em grupo</strong>, realizados de forma remota (online e ao vivo), com a seguinte estrutura:")}
${dia("1.2.1", "Terças", "Recrutamento, Treinamento e Acompanhamento de Novos Vendedores", [
  "Estruturação do processo de recrutamento e seleção de vendedores;",
  "Treinamento e integração (onboarding) de novos vendedores;",
  "Acompanhamento da evolução e da performance dos vendedores contratados."
])}
${dia("1.2.2", "Quintas", "Funil Comercial e Implantação de Estratégias de Vendas", [
  "Construção e análise do funil comercial e de seus indicadores;",
  "Definição e implantação de estratégias de vendas e de canais de aquisição de clientes;",
  "Acompanhamento da execução das estratégias implantadas."
])}
${dia("1.2.3", "Quintas", "Treinamento de Apresentação de Proposta Comercial", [
  "Treinamento da equipe na apresentação de propostas comerciais;",
  "Técnicas de condução de reunião, contorno de objeções e fechamento."
])}
${dia("1.2.4", "Bônus", "Plataforma de Gestão Financeira", [
  "Disponibilização à CONTRATANTE de acesso a uma plataforma de gestão financeira durante a vigência deste contrato, para apoio ao controle financeiro da operação."
])}
${p("1.3", "Os encontros serão realizados em grupo, com a participação de outras empresas também inscritas no programa. Os dias e horários poderão ser ajustados pelo CONTRATADO mediante comunicação prévia aos participantes, preservada a quantidade de encontros prevista.")}
${p("1.4", "Os serviços serão prestados de maneira autônoma e independente, sem vínculo empregatício entre as partes, sendo a CONTRATANTE responsável pela execução e implementação das estratégias apresentadas, bem como pelo cumprimento dos prazos e das metas estabelecidas.")}
${p("1.5", "O CONTRATADO assume obrigação de meio, e não de resultado. O programa não garante faturamento, volume de vendas ou lucro específicos, uma vez que os resultados dependem da dedicação, da execução e das condições de mercado da CONTRATANTE.")}

<div class="bloco">${secao("02", "Prazo de vigência")}
${p("2.1", "O presente contrato terá vigência de 3 (três) meses, contados a partir da data de início do programa, informada pelo CONTRATADO à CONTRATANTE no momento da inscrição.")}</div>
${p("2.2", "O acesso à plataforma de gestão financeira e aos encontros em grupo será mantido durante todo o período de vigência e encerrado automaticamente ao seu término.")}
${p("2.3", "O contrato poderá ser prorrogado ou convertido em outro programa do CONTRATADO, mediante acordo entre as partes, formalizado por aditivo contratual ou novo instrumento.")}

<div class="bloco">${secao("03", "Investimento e condições de pagamento")}
<table class="invest"><tr>
  <td class="invest-esq"><div class="invest-rot">INVESTIMENTO</div><div class="invest-valor">${valorTotalTexto}</div></td>
  <td class="invest-dir"><div class="invest-dest">${fsEsc_(pagamento.destaque)}</div><div class="invest-det">${fsEsc_(pagamento.detalhe)}</div></td>
</tr></table></div>
${p("3.1", `Pela participação no programa FAST START, a CONTRATANTE pagará ao CONTRATADO o valor total de <strong>${valorTotalTexto} (quatro mil, novecentos e noventa e sete reais)</strong>, ${fsEsc_(pagamento.clausula)}`)}
${p("3.2", "O acesso aos encontros e à plataforma de gestão financeira será liberado após a confirmação do pagamento.")}
${p("3.3", "A ausência da CONTRATANTE ou de sua equipe em qualquer encontro não gera direito a reposição individual, abatimento ou devolução de valores. Sempre que disponível, a gravação do encontro poderá ser disponibilizada aos participantes.")}

<div class="bloco">${secao("04", "Obrigações das partes")}
<h3>4.1  Obrigações do CONTRATADO</h3>
${p("4.1.1", "Conduzir os encontros semanais em grupo previstos na Cláusula 1, com alto grau de excelência técnica e adotando as melhores práticas de mercado em gestão e estruturação comercial.")}</div>
${p("4.1.2", "Disponibilizar os materiais de apoio, modelos e ferramentas utilizados nos encontros, bem como o acesso à plataforma de gestão financeira durante a vigência do contrato.")}
${p("4.1.3", "Informar com antecedência os dias, horários e links de acesso aos encontros, bem como eventuais alterações de agenda.")}
${p("4.1.4", "Manter confidencialidade sobre as informações estratégicas, operacionais e comerciais da CONTRATANTE, nos termos da Cláusula 6.")}
${p("4.1.5", "Garantir que os serviços sejam prestados com independência técnica, sem qualquer subordinação hierárquica à CONTRATANTE.")}
<div class="bloco"><h3>4.2  Obrigações da CONTRATANTE</h3>
${p("4.2.1", "Efetuar os pagamentos nos prazos e condições estabelecidos.")}</div>
${p("4.2.2", "Participar dos encontros com o gestor responsável e, quando pertinente, com a equipe comercial, garantindo pontualidade e engajamento.")}
${p("4.2.3", "Executar as tarefas, implantações e estratégias definidas nos encontros, sendo responsável pela sua implementação na empresa.")}
${p("4.2.4", "Fornecer as informações e os indicadores comerciais necessários ao acompanhamento do programa.")}
${p("4.2.5", "Manter conduta respeitosa e colaborativa com o CONTRATADO e com os demais participantes do grupo.")}
${p("4.2.6", "Utilizar a plataforma de gestão financeira de acordo com seus termos de uso, sendo vedado o compartilhamento do acesso com terceiros não vinculados à empresa.")}

<div class="bloco">${secao("05", "Propriedade intelectual e uso de imagem")}
${p("5.1", "Todo o conteúdo do programa FAST START – incluindo metodologias, aulas, gravações, apresentações, planilhas, modelos e materiais de apoio – é de propriedade exclusiva do CONTRATADO, sendo concedida à CONTRATANTE apenas licença de uso interno, pessoal e intransferível.")}</div>
${p("5.2", "É vedado à CONTRATANTE gravar, reproduzir, revender, distribuir ou compartilhar o conteúdo do programa com terceiros, sob pena de rescisão imediata e de responder por perdas e danos.")}
${p("5.3", "A CONTRATANTE autoriza a gravação dos encontros em grupo para fins de disponibilização aos participantes. A divulgação de depoimentos, imagem ou resultados da CONTRATANTE em materiais de marketing do CONTRATADO dependerá de autorização prévia e expressa.")}

<div class="bloco">${secao("06", "Confidencialidade")}
${p("6.1", "O CONTRATADO manterá sigilo sobre as informações estratégicas, comerciais, operacionais e financeiras da CONTRATANTE às quais tiver acesso em razão deste contrato (\"Informações Confidenciais\"), não as divulgando nem utilizando para fim diverso da execução do programa.")}</div>
${p("6.2", "Por se tratar de programa em grupo, a CONTRATANTE compromete-se a manter sigilo sobre as informações de outras empresas participantes compartilhadas durante os encontros, não podendo divulgá-las ou utilizá-las em benefício próprio ou de terceiros.")}
${p("6.3", "As obrigações de confidencialidade não se aplicam às informações que:")}
${alineas([
  ["a", "já eram de conhecimento público ou se tornarem públicas sem violação deste contrato;"],
  ["b", "forem comprovadamente desenvolvidas de forma independente, sem uso das Informações Confidenciais;"],
  ["c", "forem exigidas por determinação judicial, administrativa ou regulatória, hipótese em que a parte notificará previamente a outra, na extensão permitida pela lei."]
])}
${p("6.4", "O dever de confidencialidade permanecerá vigente durante o contrato e por 5 (cinco) anos após seu término, independentemente do motivo.")}
${p("6.5", "Em caso de violação desta cláusula, a parte prejudicada poderá adotar as medidas legais cabíveis, incluindo a rescisão imediata do contrato e a indenização por perdas e danos.")}

<div class="bloco nova-pagina">${secao("07", "Rescisão e cancelamento")}
${p("7.1", "A CONTRATANTE poderá desistir do programa em até 7 (sete) dias corridos contados da assinatura deste contrato, com devolução integral dos valores pagos, desde que não tenha participado de nenhum encontro.")}</div>
${p("7.2", "Após esse prazo, ou após a participação em qualquer encontro, por se tratar de programa em grupo com vagas e agenda previamente reservadas, não haverá devolução do valor pago, salvo disposição expressa em contrário entre as partes.")}
${p("7.3", "O contrato será rescindido de pleno direito, independentemente de notificação judicial ou extrajudicial, nas seguintes hipóteses:")}
${alineas([
  ["a", "inadimplemento de qualquer obrigação por uma das partes, não regularizado em prazo razoável após notificação da parte adimplente;"],
  ["b", "violação das cláusulas de propriedade intelectual ou de confidencialidade;"],
  ["c", "conduta desrespeitosa ou prejudicial ao grupo por parte da CONTRATANTE;"],
  ["d", "decretação de falência ou recuperação judicial ou extrajudicial de qualquer das partes que comprometa o cumprimento do contrato;"],
  ["e", "caso fortuito ou força maior que inviabilize, de forma definitiva, a continuidade do programa."]
])}
${p("7.4", "Na hipótese de o CONTRATADO deixar de entregar o programa por motivo a ele imputável, a CONTRATANTE terá direito à devolução proporcional aos encontros não realizados.")}

<div class="bloco">${secao("08", "Disposições gerais")}
${p("8.1", "O CONTRATADO poderá contar com profissionais de sua equipe ou convidados para a condução de encontros, permanecendo integralmente responsável pela qualidade, sigilo e cumprimento das obrigações deste contrato.")}</div>
${p("8.2", "Para dirimir quaisquer questões oriundas deste contrato que não possam ser resolvidas de forma consensual, fica eleito o Foro da Comarca de Belém/PA, com renúncia expressa a qualquer outro, por mais privilegiado que seja.")}
${p("8.3", "O presente contrato poderá ser formalizado e assinado eletronicamente, por plataforma reconhecida no mercado que assegure a autenticidade, a integridade e a validade jurídica do documento, nos termos da Medida Provisória nº 2.200-2/2001, da Lei nº 14.063/2020 e do Código Civil. As assinaturas eletrônicas terão o mesmo valor legal das assinaturas manuscritas.")}

<div class="fecho">
${p("8.4", "E, por estarem justas e contratadas, as partes firmam o presente contrato, que passa a vigorar a partir da data de sua assinatura.")}
<p class="data">Belém/PA, ${fsDataExtenso_()}.</p>
<table class="assinaturas"><tr>
  <td><div class="ass-linha"><div class="ass-papel">CONTRATANTE</div>${assinaturaContratante}</div></td>
  <td><div class="ass-linha"><div class="ass-papel">CONTRATADO</div><div class="ass-nome">BENEDITO JOÃO VIEGAS DE MATOS</div><div class="ass-info">CPF: 925.437.152-15</div></div></td>
</tr></table>
</div>

</td></tr></tbody></table>
</body></html>`;
}
