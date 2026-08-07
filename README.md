# Jornada do Milhão — Painel Financeiro + Funil Unificado + Gerador de Contrato

Frontend estático (HTML/CSS/JS puro, sem framework) hospedado no GitHub
Pages, com **Cloud Firestore** (Firebase) como banco de dados em tempo real,
e um Apps Script mínimo (`Code.gs`) usado **só como proxy de 2 APIs
externas** — Google Agenda e geração de PDF de contrato — nunca como banco
de dados.

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

## 2. Apps Script — Google Agenda + geração de PDF de contrato

O `Code.gs` faz 3 coisas, e só essas três:
- Lista os **calendários** que a conta implantada enxerga (alimenta o seletor em Configurações).
- Cria um **evento na Google Agenda** quando um agendamento é criado no sistema (nunca lê nem importa nada da Agenda).
- Gera o **PDF do contrato** a partir de um modelo do Google Docs e salva no Drive.

### 2.1. Preparar o modelo do contrato (Google Docs)

1. Crie um Google Docs com o texto do seu contrato, usando placeholders entre chaves duplas no lugar dos dados que mudam por cliente: `{{CLIENTE}}`, `{{VALOR_TOTAL}}`, `{{FORMA_PAGAMENTO}}`, `{{DATA}}`.
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

## 3. Planilha administrativa

Este projeto inclui [`planilha.html`](planilha.html) — uma página que
funciona como uma planilha (abas por coleção, células editáveis,
exportar/importar CSV/XLSX) por cima do banco de dados, pra editar ou
apagar registros sem precisar entrar no console do Firebase. **Não há link
pra ela em nenhum menu do app** — o acesso é direto pela URL
`.../planilha.html` da hospedagem.

A senha padrão gerada neste pacote é `jornada2026` — troque assim que
puder (veja "Trocar a senha da planilha administrativa" abaixo). Ela é só
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

- **clientes/{id}**: `nome`, `telefone`, `email`, `cpfCnpj`, `endereco`, `origem`, `observacoes`, `createdAt` — tabela auxiliar de consulta.
- **etapasAgendamentoConfig/{id}**: `nome`, `ordem`, `entraFunilVendas` (bool — dispara a criação automática da oportunidade + evento na Agenda), `perda` (bool — pede motivo ao arrastar um card pra cá), `slaUnidade` (`dias`/`horas`), `slaAmarelo`, `slaVermelho`.
- **agendamentos/{id}**: `clienteId`, `clienteNome`, `telefone`, `data` (yyyy-MM-dd), `hora`, `etapa` (id de `etapasAgendamentoConfig`), `dataEntrouEtapa`, `convertido` (bool — já virou oportunidade?), `enviadoAgenda` (bool — já criou o evento no Google?), `googleEventId`, `motivoPerda`, `observacoes`, `createdAt`, `updatedAt` — Funil de Agendamento. Subcoleção `historico/` (create-only).
- **etapasVendaConfig/{id}**: `nome`, `ordem`, `fechamento` (bool — abre o gerador de contrato), `perda` (bool), `slaUnidade`, `slaAmarelo`, `slaVermelho`.
- **oportunidades/{id}**: `clienteId`, `clienteNome`, `telefone`, `agendamentoId`, `etapa` (id de `etapasVendaConfig`), `dataEntrouEtapa`, `valorProposto`, `observacoes`, `perdida` (bool), `motivoPerda`, `fechada` (bool), `contratoId`, `createdAt`, `updatedAt` — Funil de Vendas. Subcoleção `historico/`.
- **contratos/{id}**: `oportunidadeId`, `clienteId`, `clienteNome`, `valorTotal`, `formaPagamento` (`avista`/`entrada_parcelas`), `valorEntrada`, `numParcelas`, `diaVencimento`, `dataGeracao`, `pdfUrl`, `pdfFileId`, `status`.
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
- **Campos obrigatórios**: telefone + e-mail + data/hora são obrigatórios
  pra um agendamento chegar numa etapa marcada `entraFunilVendas` (por
  padrão, "Agendado") — tentar mover sem eles abre o modal de confirmação
  pedindo antes de completar o movimento. Telefone, CPF/CNPJ e endereço são
  obrigatórios pra gerar um contrato (e por consequência, pro card de
  Vendas chegar na etapa de fechamento) — o gerador de contrato é a própria
  "tela de completar os dados que faltam" antes de liberar.
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
  `dataPagamento` — um botão "Marcar pago" (na tabela e no modal de
  detalhe) grava a data de hoje. Lançamentos antigos, de antes desse campo
  existir, contam como pendentes por padrão (nunca foi registrado que
  foram pagos). A tela tem um filtro de período (data início/fim, "Ver
  tudo" limpa) e 3 KPIs calculados sobre o período filtrado: **A pagar até
  hoje** (pendentes com data ≤ hoje — o que já venceu ou vence hoje sem
  estar pago), **Total pendente** (todas as não pagas do período, incluindo
  as com vencimento futuro) e **Total pago**.
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
