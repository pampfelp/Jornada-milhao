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
