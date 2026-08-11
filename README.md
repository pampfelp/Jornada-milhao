# Jornada do Milhão — Painel Financeiro + Funil Unificado + Gerador de Contrato

Frontend estático (HTML/CSS/JS puro, sem framework) hospedado no GitHub
Pages, com **Cloud Firestore** (Firebase) como banco de dados em tempo real,
e um Apps Script mínimo (`Code.gs`) usado **só como proxy de 3 APIs
externas** — Google Agenda, geração de PDF de contrato e envio pra
assinatura eletrônica (Autentique) — nunca como banco de dados.

**Importante sobre a Agenda: o fluxo é sempre sistema → Google Agenda,
nunca o contrário.** Nada é importado da Agenda pra dentro do sistema —
todo agendamento nasce aqui (manual, pelo botão), e o sistema é quem cria o
evento correspondente na Agenda, não o inverso.

Este sistema implementa o plano descrito em `plano_financeiro_funil.md`:
um único funil (Agendamento → Vendas → Administrativo) que alimenta
automaticamente o Painel Financeiro, com o Gerador de Contrato como a ponte
entre Vendas e Administrativo.

## ⚠️ Ação necessária: republicar as regras do Firestore

As `firestore.rules` deste pacote mudaram (o Funil de Agendamento passou a
usar `etapa` em vez de `status`, entre outras mudanças). **Enquanto as
regras publicadas no seu projeto Firebase não forem atualizadas, criar ou
mover agendamentos vai falhar com "permission-denied"** — o resto do
sistema (Vendas, Administrativo, Financeiro) continua funcionando
normalmente, já que essas coleções não mudaram de forma incompatível.

Pra corrigir: **Firestore Database → Regras** no console do Firebase →
apague o conteúdo → cole o de [`firestore.rules`](firestore.rules) →
**Publicar**.

## 1. Criar o projeto Firebase

1. Acesse o [console do Firebase](https://console.firebase.google.com) e crie um projeto novo (gratuito, plano Spark).
2. Ative o **Firestore**: menu lateral → "Bancos de dados e armazenamento" → **Firestore** → **Criar banco de dados** → escolha uma região (ex: `southamerica-east1` / São Paulo) → **modo de produção**.
3. Publique as regras de segurança: **Firestore Database → Regras** → apague o conteúdo → cole o de [`firestore.rules`](firestore.rules) → **Publicar**.
4. Registre um app Web: ícone de engrenagem → **Configurações do projeto** → role até "Seus apps" → ícone `</>` (Web) → dê um nome (ex: "Jornada do Milhão") → **não** marque Firebase Hosting → **Registrar app**. Copie o bloco `firebaseConfig = {...}`.
5. Abra [`firebase-init.js`](firebase-init.js) e substitua os valores `COLE_AQUI_...` pelos que você copiou.

Essas chaves (`apiKey`, `projectId` etc.) são **públicas por design** no Firebase Web — pode subir pro GitHub sem problema. A segurança de verdade vem das regras do Firestore (passo 3).

## 2. Apps Script — Google Agenda + geração de PDF de contrato + assinatura eletrônica

O `Code.gs` faz 4 coisas, e só essas quatro:
- Lista os **calendários** que a conta implantada enxerga (alimenta o seletor em Configurações).
- Cria um **evento na Google Agenda** quando um agendamento é criado no sistema (nunca lê nem importa nada da Agenda).
- Gera o **PDF do contrato** a partir de um modelo do Google Docs e salva no Drive.
- Envia o **PDF do contrato pra assinatura eletrônica** via [Autentique](https://autentique.com.br) (veja 2.4).

### 2.1. Preparar o modelo do contrato (Google Docs)

1. Crie um Google Docs com o texto do seu contrato, usando placeholders entre chaves duplas no lugar dos dados que mudam por cliente. O sistema preenche estes automaticamente ao gerar o PDF:

   | Placeholder | O que vira |
   |---|---|
   | `{{CLIENTE}}` | Nome do cliente (empresa ou pessoa física) |
   | `{{CONTRATANTE_QUALIFICACAO}}` | Parágrafo de qualificação já pronto — "pessoa jurídica..., inscrita no CNPJ sob o nº..., com sede em..., neste ato representada por..., portador(a) do CPF nº..." (PJ) ou "pessoa física, portador(a) do CPF nº..., residente e domiciliado(a) em..." (PF, sem representante) |
   | `{{VALOR_TOTAL}}` | Valor total formatado, ex: "R$ 30.000,00" |
   | `{{VALOR_TOTAL_EXTENSO}}` | O mesmo valor por extenso, ex: "trinta mil reais" |
   | `{{FORMA_PAGAMENTO}}` | Ex: "À vista", "Entrada de R$ 5.000,00 + 6x" ou "7x personalizadas" |
   | `{{PRAZO_TEXTO}}` | Ex: "6 (seis) meses" — conta os meses-calendário distintos cobertos pelas parcelas |
   | `{{TABELA_PARCELAS}}` | Lista com marcadores, uma linha por parcela: "• Parcela 1: R$ 2.000,00 (dois mil reais), com vencimento em 10/08/2026." — cobre à vista, entrada+parcelas e parcelas personalizadas automaticamente |
   | `{{DATA}}` | Data do contrato, formatada (ex: "10/08/2026") |
   | `{{DATA_CONTRATO_EXTENSO}}` | A mesma data por extenso, ex: "10 de agosto de 2026" (sem a cidade — escreva "Belém, " fixo antes, se for o caso) |
   | `{{CONTRATANTE_REPRESENTANTE_LINHA}}` | Linha extra no bloco de assinatura ("Nome: Fulano de Tal") — só aparece se o cliente for PJ com representante cadastrado; some do documento pra PF |

   Um modelo completo pronto pra colar (baseado no contrato real usado com a BRDF Energia Solar, generalizado com esses placeholders) foi entregue no chat — é só substituir o conteúdo do Google Docs por ele.
2. Copie o **ID do documento** (a parte da URL entre `/d/` e `/edit`).

### 2.2. Implantar o Code.gs

1. Crie uma planilha Google Sheets em branco (só serve de "casa" pro script).
2. Menu **Extensões → Apps Script**.
3. Apague o conteúdo padrão e cole todo o conteúdo de [`Code.gs`](Code.gs).
4. Menu **⚙️ Configurações do projeto → Script Properties → Add script property**, e adicione:

   | Propriedade | Valor |
   |---|---|
   | `CONTRATO_TEMPLATE_DOC_ID` | o ID copiado no passo 2.1 |
   | `AGENDA_CALENDAR_ID` | opcional — usado só como calendário **padrão** antes de escolher um em Configurações (veja 2.3). Deixe em branco pra cair no calendário principal ("primary") até lá. |
   | `AUTENTIQUE_API_TOKEN` | opcional — só se for usar o botão "Enviar para assinatura digital" (veja 2.4). |
   | `AUTENTIQUE_SANDBOX` | opcional — `true` pra testar sem gastar documento/crédito real na Autentique. Deixe em branco (ou `false`) em produção. |

5. Rode a função `autorizar` uma vez direto no editor (▶) — vai pedir permissão de acesso à Agenda e ao Drive.
6. **Implantar → Nova implantação** → tipo **"Aplicativo da Web"**:
   - Executar como: **Eu** (a conta do Google cujos calendários você quer poder escolher — veja 2.3)
   - Quem pode acessar: **Qualquer pessoa**
   Copie a URL `.../exec` gerada.
7. Cole essa URL na constante `APPS_SCRIPT_PROXY_URL`, em [`firebase-init.js`](firebase-init.js).

**Toda vez que editar `Code.gs`**, é preciso fazer uma nova implantação (ou "Gerenciar implantações → editar → Nova versão") pra que a URL publicada reflita o código novo.

Enquanto isso não estiver configurado, o resto do sistema funciona
normalmente — só a criação do evento na Agenda e a geração de PDF do
contrato mostram um aviso (o agendamento e a oportunidade são salvos no
Firestore de qualquer forma).

### 2.3. Escolher em qual calendário lançar os agendamentos

A conta que "Executa como" no passo 2.2 só enxerga os calendários dela (os
que criou + os que foram compartilhados com ela). Em **Configurações →
Calendário do Google Agenda**, clique em "🔄 Recarregar lista" pra ver
esses calendários e escolha em qual os agendamentos criados no sistema são
lançados — sem precisar editar Script Properties. Essa escolha fica salva
no Firestore (`config/geral`), então vale pra todo mundo que usa o
sistema.

Se o calendário que você quer é de **outra pessoa** (ex: um calendário
dedicado a clientes do Benedito): ou ele compartilha esse calendário com a
conta que implantou o `Code.gs` (Google Agenda → configurações do
calendário dele → "Compartilhar com pessoas específicas"), ou o `Code.gs`
precisa ser implantado a partir da própria conta dele (repita o passo 2.2
logado como ele).

### 2.4. Assinatura eletrônica (Autentique)

No detalhe de um contrato que já tem PDF gerado, aparece o botão **"✍️
Enviar para assinatura digital"** (só se o cliente já tiver e-mail
cadastrado). Ele manda o PDF pra [Autentique](https://autentique.com.br)
via API — ela mesma dispara, sozinha, um e-mail pro cliente com o link de
assinatura (o sistema não manda esse e-mail, só aciona a Autentique). O
link também fica salvo no contrato, como cópia de backup caso seja preciso
reenviar por WhatsApp.

1. Gere um token em [painel.autentique.com.br/perfil/api](https://painel.autentique.com.br/perfil/api).
2. Adicione como Script Property `AUTENTIQUE_API_TOKEN` (passo 2.2.4) —
   **nunca** cole o token direto no código do `Code.gs` nem em nenhum
   arquivo do repositório: como o `Code.gs` fica versionado no GitHub
   junto com o resto do site, qualquer coisa escrita nele é pública. Script
   Properties é o único lugar seguro — só existe dentro do projeto do Apps
   Script, nunca é exportado.
3. (Opcional) Enquanto estiver testando, adicione `AUTENTIQUE_SANDBOX` =
   `true` — os documentos de teste não consomem crédito e são apagados
   automaticamente depois de alguns dias pela própria Autentique. Remova
   (ou troque pra `false`) quando for usar de verdade.
4. Sem essas properties configuradas, o resto do sistema funciona
   normalmente — só o botão de assinatura mostra um erro explicando o que
   falta.

Cada nova implantação do `Code.gs` (passo 2.2.6) já cobre essa integração,
não precisa de nenhum passo extra além dos de sempre.

**Erro "Você não tem permissão para chamar UrlFetchApp.fetch"**: acontece
se o `Code.gs` foi autorizado (passo 2.2.5) antes de o `enviarParaAssinatura`
existir — a autorização antiga não inclui o escopo de "conectar a serviço
externo", que só esse botão usa. Corrige assim: no editor do Apps Script,
rode a função `autorizar` de novo (▶) — ela agora força esse escopo a
aparecer na tela de permissão — aceite a tela que aparecer, depois faça
uma **nova implantação** (Implantar → Gerenciar implantações → editar →
Nova versão). Não precisa repetir isso de novo depois, só na primeira vez.

### 2.5. Leads automáticos (YayForms → Funil de Agendamento)

Toda resposta enviada em qualquer formulário da [YayForms](https://yayforms.com)
vira um lead novo, sozinho, na 1ª etapa do Funil de Agendamento (a de menor
"ordem" — normalmente "Novo Lead"). O sistema tenta identificar nome,
telefone e e-mail entre as perguntas respondidas (por palavras-chave no
título da pergunta e pelo formato da resposta); **todas** as respostas,
identificadas ou não, ficam guardadas nas observações do lead, então nada
se perde mesmo se a identificação errar. O campo **"Origem"** do cliente
(o mesmo que já existe no cadastro) recebe o nome do formulário — é assim
que dá pra saber de qual formulário cada lead veio, tanto no detalhe do
cliente quanto no detalhe do lead no funil.

**Como funciona por baixo dos panos**: como não tem ninguém com o
navegador aberto esperando o lead chegar, o `Code.gs` escreve o cliente e
o lead **direto no Firestore** (via a API REST dele, sem login — as
mesmas regras de formato que valem pro `app.js` valem aqui) assim que a
YayForms avisa (webhook) que uma resposta foi enviada.

1. Gere um token de API em [yayforms.com/help/how-to-generate-a-yay-forms-api-token](https://yayforms.com/help/how-to-generate-a-yay-forms-api-token).
2. Adicione como Script Property `YAYFORMS_API_TOKEN` (mesmo lugar dos
   outros — passo 2.2.4).
3. Invente uma senha longa e aleatória e adicione como Script Property
   `YAYFORMS_WEBHOOK_TOKEN`. **Essa senha é o que impede qualquer pessoa
   na internet de forjar leads falsos** — a URL do `Code.gs` já é pública
   (está no `app.js`, que é público), então sem esse token qualquer um que
   descobrisse a URL poderia criar leads inventados no seu funil.
4. Em cada formulário que deve alimentar o funil: no painel da YayForms,
   abra o formulário → **Integrate → Webhooks → Add webhook** → cole a
   URL do `Code.gs` (a mesma `.../exec` de sempre) **acrescentando
   `?origem=yayforms&token=SEU_TOKEN_DO_PASSO_3` no final**. Método POST
   (padrão). Salve.
5. Repita o passo 4 pra cada formulário que deve criar leads — a
   integração vale por formulário, não é automática pros que forem
   criados depois.
6. Teste: no próprio formulário, use o botão de teste do webhook (⋮ →
   Test) ou responda o formulário de verdade uma vez — o lead deve
   aparecer em "Novo Lead" no Funil de Agendamento em poucos segundos.

**Respostas parciais (quem começou e não terminou) também viram lead** —
por padrão a YayForms só dispara o webhook quando a resposta é enviada até
o fim; pra também capturar quem abandonou no meio, ative a opção "enviar
respostas incompletas" nas configurações do formulário/webhook. O sistema
não filtra por status — cria o lead do mesmo jeito, só marca nas
observações se foi "respondido até o fim" ou "PARCIAL", pra você priorizar
o contato sabendo disso. Um lead parcial pode ter menos dados (só o que a
pessoa preencheu antes de sair) — o que faltar fica em branco, como
qualquer outro lead incompleto criado manualmente.

**Limitações conhecidas** (aceitáveis pro uso atual, mas bom saber):
- Não há verificação criptográfica do webhook (o Apps Script não
  consegue ler cabeçalhos HTTP da requisição recebida) — a segurança é
  só o token na URL, que precisa continuar em segredo.
- Não há proteção contra a YayForms reenviar o mesmo webhook duas vezes
  (poderia criar um lead duplicado) — na prática é raro, e duplicar um
  lead é fácil de perceber/mesclar manualmente.
- A identificação de nome/telefone/e-mail é por palavra-chave no título
  da pergunta ("nome", "whatsapp", "telefone"...) — perguntas fraseadas
  de um jeito muito diferente podem não ser reconhecidas, mas a resposta
  continua salva (só cai em "observações" em vez do campo certo).

## 3. Planilha administrativa

Este projeto inclui [`planilha.html`](planilha.html) — uma página que
funciona como uma planilha (abas por coleção, células editáveis,
exportar/importar CSV/XLSX) por cima do banco de dados, pra editar ou
apagar registros sem precisar entrar no console do Firebase. **Não há link
pra ela em nenhum menu do app** — o acesso é direto pela URL
`.../planilha.html` da hospedagem.

A senha atual da planilha é `jornada123` (veja "Trocar a senha da
planilha administrativa" abaixo pra trocar de novo). Ela é só
um cadeado contra acesso acidental, **não é segurança de verdade** —
qualquer pessoa com conhecimento técnico consegue escrever direto no
Firestore ignorando essa senha.

## 4. Rodar o app

O app é 100% estático — todos os arquivos ficam juntos, sem subpastas
(`index.html`, `style.css`, `app.js`, `firebase-init.js`, `Code.gs`,
`planilha.html`, `manifest.json`, `service-worker.js`, os ícones
`.png`/`.ico`). Isso é proposital: uploads pela interface web do GitHub não
preservam pastas ao arrastar arquivos soltos.

- **Não abra `index.html` direto do disco (duplo clique) para testar** —
  módulos ES são bloqueados por CORS no protocolo `file://`. Use um
  servidor local (`python -m http.server` / `npx serve`) ou teste direto na
  hospedagem.
- Suba a pasta em qualquer hospedagem estática com HTTPS (GitHub Pages,
  Netlify, Vercel) pra usar de verdade e pro "Instalar app" funcionar.

## Estrutura de dados no Firestore

Os 3 funis (Agendamento, Vendas, Administrativo) seguem o mesmo padrão:
uma coleção `etapasXConfig` guarda as colunas do kanban (nome, ordem, SLA),
e os cards referenciam a etapa atual pelo id do documento. Todos os cards
guardam `dataEntrouEtapa` (Timestamp) — é a partir dela que o badge de SLA
é calculado, ao vivo, no navegador (não é um valor gravado, recalcula toda
vez que a tela renderiza).

- **clientes/{id}**: `nome`, `telefone`, `email`, `cpfCnpj`, `endereco`, `representanteNome`, `representanteCpf` (só relevantes/exigidos pra CNPJ — o modal mostra esses 2 campos automaticamente quando detecta 12+ dígitos no CPF/CNPJ), `origem`, `observacoes`, `createdAt` — tabela auxiliar de consulta.
- **etapasAgendamentoConfig/{id}**: `nome`, `ordem`, `entraFunilVendas` (bool — dispara a criação automática da oportunidade + evento na Agenda), `perda` (bool — pede motivo ao arrastar um card pra cá), `slaUnidade` (`dias`/`horas`), `slaAmarelo`, `slaVermelho`.
- **agendamentos/{id}**: `clienteId`, `clienteNome`, `telefone`, `data` (yyyy-MM-dd), `hora`, `etapa` (id de `etapasAgendamentoConfig`), `dataEntrouEtapa`, `convertido` (bool — já virou oportunidade?), `enviadoAgenda` (bool — já criou o evento no Google?), `googleEventId`, `motivoPerda`, `observacoes`, `createdAt`, `updatedAt` — Funil de Agendamento. Subcoleção `historico/` (create-only).
- **etapasVendaConfig/{id}**: `nome`, `ordem`, `fechamento` (bool — abre o gerador de contrato), `perda` (bool), `slaUnidade`, `slaAmarelo`, `slaVermelho`.
- **oportunidades/{id}**: `clienteId`, `clienteNome`, `telefone`, `agendamentoId`, `etapa` (id de `etapasVendaConfig`), `dataEntrouEtapa`, `valorProposto`, `observacoes`, `perdida` (bool), `motivoPerda`, `fechada` (bool), `contratoId`, `createdAt`, `updatedAt` — Funil de Vendas. Subcoleção `historico/`.
- **contratos/{id}**: `oportunidadeId`, `clienteId`, `clienteNome`, `valorTotal`, `formaPagamento` (`avista`/`entrada_parcelas`/`personalizada` — a última tem cada parcela com valor/vencimento digitados à mão, em vez de divisão igual), `valorEntrada`, `numParcelas`, `diaVencimento`, `dataGeracao`, `pdfUrl`, `pdfFileId`, `status`, `autentiqueDocId`, `linkAssinatura`, `statusAssinatura`, `enviadoAssinaturaEm` — os 4 últimos só existem depois de enviado pra assinatura eletrônica (veja seção 2.4).
- **parcelas/{id}**: `contratoId`, `clienteId`, `clienteNome`, `numero` (0 = entrada), `valor`, `vencimento` (yyyy-MM-dd), `status` (`esperado`/`realizado`), `dataPagamento` — geradas automaticamente ao gerar um contrato.
- **despesas/{id}**: `descricao`, `categoria`, `tipo` (`despesa`/`outro_custo`), `valor`, `data`, `recorrente` (bool), `diaVencimento`, `ultimoMesLancado`, `origemRecorrenteId`.
- **etapasAdminConfig/{id}**: `nome`, `ordem`, `slaUnidade`, `slaAmarelo`, `slaVermelho`.
- **cardsAdmin/{id}**: `contratoId`, `clienteId`, `clienteNome`, `valorTotal`, `etapa` (id de `etapasAdminConfig`), `dataEntrouEtapa`, `createdAt`, `updatedAt` — Funil Administrativo, criado automaticamente ao gerar um contrato. Subcoleção `historico/`.
- **config/geral**: documento único — `calendarioAgendaId`, `calendarioAgendaNome` — o calendário escolhido em Configurações para onde os agendamentos são lançados.

## Decisões tomadas

`plano_financeiro_funil.md` deixava várias perguntas em aberto, e os
pedidos foram evoluindo ao longo do desenvolvimento. As decisões abaixo
são as que valem **na versão atual** — todas ajustáveis depois, direto no
app (Configurações) ou na `planilha.html`:

- **Despesas e outros custos** entram por lançamento manual (aba "Despesas
  & Custos"), com opção de marcar como **recorrente** — nesse caso o
  sistema relança sozinho uma nova instância todo mês (checagem feita no
  navegador de quem abrir o sistema, sem precisar de servidor).
- **Saldo estimado** é sempre o saldo do período isolado (mês selecionado),
  não acumulado entre meses. Se quiser visão acumulada/projeção futura,
  isso fica para uma v2.
- **Contrato**: só geração de PDF por enquanto, sem assinatura eletrônica.
  Um único modelo de contrato (Google Docs com placeholders) — se precisar
  de mais de um modelo por tipo de serviço, dá pra estender
  `CONTRATO_TEMPLATE_DOC_ID` para um mapa de modelos. O modal de contrato
  também coleta telefone/e-mail do cliente se estiverem faltando no
  cadastro (só preenche o que estava em branco, nunca sobrescreve).
- **Data do contrato ≠ data de lançamento no sistema**: cada contrato tem
  `dataContrato` (a data da assinatura, editável — é ela que conta pro
  "Faturamento do período" no Painel Financeiro) separado de `dataGeracao`
  (timestamp automático de quando o registro foi criado, só pra
  auditoria). Lançar hoje um contrato assinado há meses não deveria contar
  como faturamento deste mês — por isso o campo é editável tanto na
  criação quanto depois (✏️ no modal de detalhe). Contratos de antes desse
  campo existir caem no fallback de `dataGeracao` até alguém corrigir; dá
  pra corrigir vários de uma vez pela `planilha.html` (coluna
  `dataContrato`) em vez de um por um.
- **Etapas dos 3 funis são 100% configuráveis** — nome, ordem, e um SLA
  (verde/amarelo/vermelho) contado em horas ou dias a partir do momento em
  que o card entrou na etapa. Os defaults que vêm no pacote (editáveis a
  qualquer momento em **Configurações**):
  - **Agendamento**: Novo Lead → Tentativa de Contato → Retomar Contato →
    Qualificação → Agendado → Reagendar → Perdido. Só "Agendado" é marcada
    `entraFunilVendas` — é a única etapa com qualquer automação; todas as
    outras (inclusive "Reagendar") são só pra acompanhamento manual, sem
    nenhum efeito colateral ao arrastar o card pra elas. "Perdido" é a
    etapa de perda.
  - **Vendas**: Reunião Agendada → Follow Up → Negociação → Fechado →
    Perdido. "Fechado" é a etapa de fechamento; "Perdido" é a etapa de
    perda.
  - **Administrativo**: Recebimento da Entrada → Criação do Grupo → Envio
    do Contrato → Enviado para Mentoria.
- **Gatilho de conversão em oportunidade**: quando um agendamento chega
  numa etapa marcada `entraFunilVendas` (só "Agendado", por padrão), o
  sistema cria a oportunidade automaticamente (como novo lead, na 1ª etapa
  do Funil de Vendas) e o evento na Google Agenda — sem precisar de nenhum
  botão manual. Os flags `convertido`/`enviadoAgenda` evitam duplicar caso
  o card volte a passar por essa etapa depois.
- **"+ Novo Lead" cria um lead, não um agendamento**: o modal de criação só
  pede cliente (combobox com "+ Criar cliente" embutido), telefone,
  e-mail, nível de interesse e observações — sem pedir data/hora, porque
  nesse ponto ainda não existe reunião marcada. Os campos de data/hora só
  aparecem quando o card é arrastado pra "Agendado": o sistema abre um
  modal "Confirmar agendamento" pedindo telefone + e-mail + data/hora (os
  três obrigatórios só a partir daí) antes de completar o movimento — o
  mesmo padrão do gerador de contrato no Vendas.
- **Nível de interesse**: escala fixa de 5 pontos com emoji (😠🙁😐🙂🤩),
  editável no lead (Agendamento) e na oportunidade (Vendas), mostrada como
  uma "tag" ao lado do nome do cliente nos dois kanbans. Como é uma escala
  fixa (não uma lista que cresce), o seletor é uma linha de 5 botões
  clicáveis — não um combobox filtrável (essa regra é só pra listas que
  crescem, tipo cliente/etapa).
- **Convite de reunião pro cliente**: quando o agendamento tem e-mail
  preenchido, ele é adicionado como convidado do evento (`guests` +
  `sendInvites: true` no `CalendarApp.createEvent`) — o cliente recebe o
  convite nativo do Google Agenda (aceitar/recusar, lembrete, etc.), não é
  um e-mail à parte enviado pelo sistema.
- **Título e descrição do evento na Agenda são fixos**: o Google Calendar
  mostra o MESMO título e a MESMA descrição pra todo mundo que vê o evento
  (organizador e convidados) — não existe personalização por destinatário,
  então não dá pra ter um texto só pro cliente e outro só pro Benedito no
  mesmo evento. O título usa a frase do ponto de vista do Benedito
  ("Reunião Consultoria Jornada do Milhão com {Cliente}", já que é ele quem
  organiza e vê primeiro na própria Agenda) e a descrição usa a frase do
  ponto de vista do cliente ("Reunião Consultoria {Cliente} com Benedito
  Viegas - Jornada do Milhão") — os dois textos ficam visíveis pras duas
  pessoas, só em campos diferentes do mesmo evento. Isso é definido dentro
  do `Code.gs` (`acaoCriarEventoAgenda_`), não vem do formulário.
- **Perda (Agendamento e Vendas)**: arrastar um card pra qualquer etapa
  marcada `perda` abre um modal pedindo o motivo antes de mover de
  verdade — o card só sai da etapa atual depois de confirmar.
- **Gerador de contrato obrigatório no fechamento**: arrastar um card do
  Funil de Vendas pra etapa marcada `fechamento` **não move o card** —
  abre o modal do contrato na hora, já com cliente/valor pré-preenchidos.
  O card só entra de fato em "Fechado" depois de gerar o contrato (que já
  cria as parcelas no financeiro e o card no Funil Administrativo,
  automaticamente).
- **Quem move o card entre etapas**: por padrão é manual (arrastar no
  Kanban), exceto as transições automáticas descritas acima.
- **Cliente em qualquer formulário do sistema** (agendamento, oportunidade,
  contrato): sempre um combobox que só aceita alguém já cadastrado (busca
  com filtro ao digitar) ou a criação explícita de um cliente novo pelo
  botão "+ Criar cliente" dentro do próprio campo — nunca um `<select>` ou
  `<input list>` nativo (no Android eles jogam as sugestões coladas no
  teclado), e nunca cria um cliente sem essa escolha deliberada, pra
  evitar duplicata por erro de digitação.
- **SLA é calculado ao vivo, não gravado**: a cor do badge (verde/amarelo/
  vermelho) é recalculada toda vez que a tela renderiza (inclusive por um
  `setInterval` de 1 minuto) a partir de `dataEntrouEtapa` — não existe um
  campo "prazo" gravado que precise ser recalculado a cada mudança de SLA.
- **Padrão "ver antes de editar" em toda linha/card do sistema**: clicar
  numa linha de tabela ou num card do kanban nunca abre a edição direto —
  abre um modal de detalhe só leitura, com um botão ✏️ (editar) e 🗑
  (excluir) no topo. Isso vale pra clientes, despesas, contratos, parcelas,
  as 3 configurações de etapas, e os 3 tipos de card dos funis. Contratos
  só permitem editar o `status` (ativo/cancelado) — valor, forma de
  pagamento e parcelas já geradas não são editáveis por ali (excluir e
  gerar de novo é o caminho pra corrigir esses dados). Cards do Funil
  Administrativo só permitem editar o valor total (cliente e contrato
  vinculado vêm de quando o contrato foi gerado).
- **CPF/CNPJ**: campo único no cadastro do cliente, com máscara automática
  aplicada a cada tecla — até 11 dígitos vira `000.000.000-00` (CPF), 12+
  vira `00.000.000/0000-00` (CNPJ). É só formatação, não valida dígito
  verificador.
- **Endereço com busca de sugestões**: usa a API pública do **Nominatim**
  (OpenStreetMap) em vez do Google Places — o Places exigiria criar um
  projeto no Google Cloud com faturamento ativado só pra usar a cota
  grátis, o que não parece um requisito razoável pra uma sugestão de
  endereço. O campo nunca bloqueia: digitar o endereço na mão sem clicar
  em nenhuma sugestão funciona normalmente.
- **Campos obrigatórios por etapa do Agendamento**: cada etapa tem duas
  travas independentes e configuráveis (Configurações → Funil de
  Agendamento), separadas de `entraFunilVendas` (que só controla a
  automação de Vendas/Agenda — por padrão, só "Agendado"):
  - `exigeContato` — telefone, e-mail, origem (no cadastro do cliente) e
    data/hora (do agendamento) precisam existir. Padrão: "Agendado" e
    "Reagendar" (as duas, propositalmente — "Reagendar" também é uma
    reunião marcada, então precisa das mesmas informações; antes só
    "Agendado" exigia isso).
  - `exigeQualificacao` — os campos de qualificação DO LEAD (Instagram da
    empresa, estabelecimento, time comercial, faturamento dos últimos 6
    meses, onde a empresa trava, nível de comprometimento 0-10) + o nível
    de interesse precisam existir. Padrão: "Qualificação", "Agendado" e
    "Reagendar".
  Nenhuma das duas trava a etapa de perda ("Perdido"), verificada antes.
  Tentar mover sem tudo preenchido abre o modal do lead pedindo o que
  falta (e, se for algo do cadastro do cliente — telefone/e-mail/origem —,
  o botão "✏️ Editar cliente" dentro dele leva direto pra lá) antes de
  completar o movimento — em qualquer etapa sem essas exigências o card
  transita livre, sem pedir nada. Telefone, CPF/CNPJ e endereço são
  obrigatórios pra gerar um contrato (e por consequência, pro card de
  Vendas chegar na etapa de fechamento) — o gerador de contrato é a própria
  "tela de completar os dados que faltam" antes de liberar.
- **Qualificação vive no lead (agendamento), não no cadastro do
  cliente**: Instagram da empresa, estabelecimento (ponto fixo/remoto —
  botão), time comercial e faturamento dos últimos 6 meses (seletores de
  opção fixa, não combobox — são listas curtas e fixas, não crescem), onde
  a empresa trava (múltipla escolha, checkboxes) e nível de comprometimento
  de 0 a 10 (botões) ficam no modal do lead, junto com o nível de
  interesse — um mesmo cliente pode gerar mais de um lead ao longo do
  tempo, com respostas de qualificação diferentes a cada vez, então não
  faria sentido isso ser um dado fixo do cadastro. Ao virar oportunidade em
  Vendas, esses campos são copiados junto (mesmo princípio do nível de
  interesse). Preenchimento sempre opcional no lead em si; só vira
  obrigatório quando ele entra numa etapa com
  `exigeQualificacao` (ver acima).
- **Contato do cliente só se edita na ficha do cliente**: os modais de
  Agendamento e Oportunidade não têm mais campos de telefone/e-mail
  digitáveis — eles mostram o contato do cliente selecionado só leitura,
  com um botão "✏️ Editar cliente" que abre o cadastro completo por cima
  (o modal atual fica escondido e reabre sozinho depois de salvar ou
  cancelar). Telefone/e-mail salvos no agendamento/oportunidade são sempre
  uma cópia do que está no cadastro do cliente naquele momento, nunca um
  valor digitado à parte — evita duas versões divergentes do mesmo dado.
  O "+ Criar cliente" dentro de qualquer combobox de cliente segue o mesmo
  princípio: abre o cadastro completo (nome já preenchido) em vez de criar
  na hora só com o nome — só o nome é obrigatório pra salvar, o resto
  (inclusive contato) pode ficar em branco por enquanto.
- **PDF do contrato**: o modal de detalhe do contrato mostra o PDF
  embutido (iframe, via `drive.google.com/file/d/{id}/preview`) e um link
  de download direto — não é preciso sair do sistema pra ver ou baixar.
- **Despesas do mês no Painel Financeiro**: além dos KPIs agregados, uma
  tabela lista cada despesa/custo lançado no período selecionado.
- **Status de pagamento nas Despesas & Custos**: cada lançamento tem
  `status` ("esperado"/"realizado", mesmo vocabulário das parcelas) +
  `dataPagamento`. Lançamentos antigos, de antes desse campo existir,
  contam como pendentes por padrão (nunca foi registrado que foram pagos).
  A tela tem um filtro de período (data início/fim, "Ver tudo" limpa) e 3
  KPIs calculados sobre o período filtrado: **A pagar até hoje** (pendentes
  com data ≤ hoje — o que já venceu ou vence hoje sem estar pago), **Total
  pendente** (todas as não pagas do período, incluindo as com vencimento
  futuro) e **Total pago**. Cada lançamento também tem um campo opcional de
  **Chave PIX** (pra quem vai receber aquele pagamento), visível na tabela
  (fonte monoespaçada, seleciona tudo num clique pra copiar) e no modal de
  detalhe.
- **Marcar como pago/recebido sempre pede a data** (parcelas, despesas e
  entradas) — um modalzinho ("Marcar como pago") pede a data real do
  pagamento antes de gravar, em vez de assumir "hoje" na hora do clique.
  Isso importa porque a data de pagamento é o que decide em qual mês o
  Caixa realizado do Painel Financeiro conta aquele valor — marcar hoje uma
  parcela antiga sem poder escolher a data fazia ela contar como
  faturamento/caixa do mês errado (o dia do clique, não o dia real do
  pagamento).
- **Entradas** (nova aba, coleção `entradas`): recebimentos que não vêm de
  parcela de contrato — venda avulsa, reembolso, qualquer entrada de caixa
  lançada manualmente. Mesmo padrão de Despesas & Custos (status
  esperado/realizado, filtro de período, 3 KPIs — **A receber até hoje**,
  **Total pendente**, **Total recebido**), só que do lado da receita. Entra
  somada com as parcelas no **Caixa esperado**/**Caixa realizado** do
  Painel Financeiro (mas não no **Faturamento do período**, que continua
  sendo só o valor de contratos fechados). Como é uma coleção nova, exige
  republicar `firestore.rules` antes de funcionar (mesmo passo de sempre —
  Firestore Database → Regras → colar → Publicar).
- **Log de movimentação do funil**: toda mudança de etapa (arrastar,
  perda, fechamento) grava um registro em `historico/` com `de` (etapa
  anterior) e `para` (etapa nova). O botão "📊 Relatório" em cada funil usa
  esse histórico pra calcular quantos cards já passaram por cada etapa, a
  conversão entre etapas consecutivas, e o tempo médio (a partir de
  `dataEntrouEtapa`) dos cards que estão em cada etapa agora. Como o funil
  é de trânsito livre (sem ordem obrigatória), a conversão é uma
  aproximação — mesmo princípio usado no funil do SolarGreen, só que
  calculada automaticamente a partir do histórico real em vez de depender
  de lançamento manual.

## Observações

- **Sem servidor "oficial"**: como não há Cloud Functions, a validação de
  regras de negócio (cálculo de parcelas, transições automáticas entre
  funis) roda no `app.js`, no navegador de cada usuário — protegida contra
  gravações mal-formadas pelas regras do Firestore, mas não contra alguém
  tecnicamente hábil abrindo o DevTools. Trade-off aceitável pro uso
  interno da equipe; como este sistema guarda dados financeiros, vale
  reconsiderar Firebase Auth se o número de pessoas com acesso crescer.
- **Fuso horário do evento na Agenda**: o horário digitado no agendamento é
  enviado como está (sem conversão de fuso) — o sistema assume que quem
  usa o app está no mesmo fuso do projeto Apps Script (Brasil). Se algum
  dia isso passar a ser um problema (ex: equipe em fusos diferentes), vale
  reconsiderar enviar o horário já em UTC.
