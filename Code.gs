/**
 * Jornada do Milhão — Apps Script mínimo, usado SÓ como proxy de APIs
 * externas (Google Agenda e geração de PDF de contrato). NÃO é o banco de
 * dados deste sistema (isso é o Firestore) e NÃO guarda nenhum dado de
 * negócio — só repassa 2 integrações que o navegador sozinho não consegue
 * fazer:
 *
 *   1. "listarEventosAgenda" — lê eventos do Google Agenda num intervalo de
 *      datas (o Firestore não tem acesso à Agenda; o app.js compara o que
 *      volta daqui com a coleção "agendamentos" pra criar/atualizar cards
 *      no Funil de Agendamento).
 *   2. "gerarContratoPDF" — copia um modelo do Google Docs, substitui os
 *      placeholders pelos dados do contrato, exporta como PDF pro Google
 *      Drive e devolve o link. Sem isso o navegador não tem como gerar um
 *      PDF formatado nem guardá-lo em algum lugar de graça.
 *
 * ESCOPO — SÓ LEITURA na Agenda, SÓ CRIAÇÃO de arquivo no Drive: nenhuma
 * ação aqui edita ou apaga evento da Agenda, nem apaga arquivo do Drive.
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
 *      CONTRATO_TEMPLATE_DOC_ID = (ID do Google Docs modelo do contrato)
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
// tela de autorização do Google (Agenda + Drive) de forma previsível.
function autorizar() {
  CalendarApp.getDefaultCalendar();
  DriveApp.getRootFolder();
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) {}
  return json_(rotear_(body));
}

function rotear_(body) {
  try {
    switch (body.action) {
      case "listarCalendarios": return acaoListarCalendarios_();
      case "listarEventosAgenda": return acaoListarEventosAgenda_(body.from, body.to, body.calendarId);
      case "gerarContratoPDF": return acaoGerarContratoPDF_(body.dados);
      default: return { ok: false, erro: "Ação desconhecida: " + body.action };
    }
  } catch (err) {
    return { ok: false, erro: String(err) };
  }
}

// ══════════════ GOOGLE AGENDA (só leitura) ══════════════

// Lista os calendários que a conta que implantou este Code.gs enxerga
// (os dela + os que foram compartilhados com ela) — alimenta o seletor de
// calendário em Configurações, pra escolher qual Agenda vira o Funil de
// Agendamento sem precisar editar Script Properties na mão.
function acaoListarCalendarios_() {
  var calendarios = CalendarApp.getAllCalendars().map(function (cal) {
    return { id: cal.getId(), nome: cal.getName() };
  });
  return { ok: true, calendarios: calendarios };
}

// Lista eventos do calendário entre "from" e "to" (strings ISO, ex:
// "2026-08-01T00:00:00"). O app.js usa isso pra alimentar o Funil de
// Agendamento — cada evento vira (ou atualiza) um card, comparado pelo
// campo "googleEventId". "calendarId" vem do calendário escolhido em
// Configurações (guardado no Firestore); se não vier, cai pra Script
// Property AGENDA_CALENDAR_ID e, por último, pro calendário principal.
function acaoListarEventosAgenda_(from, to, calendarId) {
  if (!from || !to) return { ok: false, erro: "Parâmetros from/to são obrigatórios." };
  var calendario = CalendarApp.getCalendarById(calendarId || obterCalendarId_());
  if (!calendario) return { ok: false, erro: "Calendário não encontrado: " + calendarId };

  var eventos = calendario.getEvents(new Date(from), new Date(to));
  var lista = eventos.map(function (ev) {
    return {
      // Eventos recorrentes compartilham o MESMO googleEventId em todas as
      // ocorrências (limitação do CalendarApp) — o app.js usa "recorrente"
      // pra saber quando precisa desambiguar ocorrências pela data, em vez
      // de tratar uma mudança de data como reagendamento de verdade.
      googleEventId: ev.getId(),
      recorrente: ev.isRecurringEvent(),
      titulo: ev.getTitle(),
      descricao: ev.getDescription(),
      inicio: ev.getStartTime().toISOString(),
      fim: ev.getEndTime().toISOString(),
      localizacao: ev.getLocation()
    };
  });
  return { ok: true, eventos: lista };
}

function obterCalendarId_() {
  var props = PropertiesService.getScriptProperties();
  return props.getProperty("AGENDA_CALENDAR_ID") || "primary";
}

// ══════════════ GERAÇÃO DE CONTRATO EM PDF ══════════════

// Copia o Google Docs modelo (CONTRATO_TEMPLATE_DOC_ID), substitui os
// placeholders {{...}} pelos dados do contrato, exporta como PDF pro Drive
// (pasta "Jornada do Milhão - Contratos") e devolve o link de leitura.
// "dados" é um objeto simples { chave: valorTexto } — cada chave vira um
// placeholder "{{CHAVE}}" procurado no modelo.
function acaoGerarContratoPDF_(dados) {
  if (!dados) return { ok: false, erro: "Faltam os dados do contrato." };
  var props = PropertiesService.getScriptProperties();
  var templateId = props.getProperty("CONTRATO_TEMPLATE_DOC_ID");
  if (!templateId) {
    return { ok: false, erro: "Configure CONTRATO_TEMPLATE_DOC_ID em Project Settings > Script Properties." };
  }

  var pasta = getContratosFolder_();
  var nomeArquivo = "Contrato - " + (dados.CLIENTE || "Cliente") + " - " + Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "GMT-3", "dd-MM-yyyy HH-mm");

  var copia = DriveApp.getFileById(templateId).makeCopy(nomeArquivo, pasta);
  var doc = DocumentApp.openById(copia.getId());
  var corpo = doc.getBody();

  Object.keys(dados).forEach(function (chave) {
    corpo.replaceText("{{" + chave + "}}", String(dados[chave] == null ? "" : dados[chave]));
  });
  doc.saveAndClose();

  var pdfBlob = DriveApp.getFileById(copia.getId()).getAs(MimeType.PDF);
  var arquivoPdf = pasta.createFile(pdfBlob).setName(nomeArquivo + ".pdf");
  arquivoPdf.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  // A cópia do Google Docs fica só como rascunho intermediário — o que
  // importa pro cliente é o PDF final.
  DriveApp.getFileById(copia.getId()).setTrashed(true);

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

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
