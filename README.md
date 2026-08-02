# Jornada do Milhão — Painel Financeiro + Funil Unificado + Gerador de Contrato

Frontend estático (HTML/CSS/JS puro, sem framework) hospedado no GitHub
Pages, com **Cloud Firestore** (Firebase) como banco de dados em tempo real,
e um Apps Script mínimo (`Code.gs`) usado **só como proxy de 2 APIs
externas** — Google Agenda e geração de PDF de contrato — nunca como banco
de dados.

Este sistema implementa o plano descrito em `plano_financeiro_funil.md`:
um único funil (Agendamento → Vendas → Administrativo) que alimenta
automaticamente o Painel Financeiro, com o Gerador de Contrato como a ponte
entre Vendas e Administrativo.

## 1. Criar o projeto Firebase

1. Acesse o [console do Firebase](https://console.firebase.google.com) e crie um projeto novo (gratuito, plano Spark).
2. Ative o **Firestore**: menu lateral → "Bancos de dados e armazenamento" → **Firestore** → **Criar banco de dados** → escolha uma região (ex: `southamerica-east1` / São Paulo) → **modo de produção**.
3. Publique as regras de segurança: **Firestore Database → Regras** → apague o conteúdo → cole o de [`firestore.rules`](firestore.rules) → **Publicar**.
4. Registre um app Web: ícone de engrenagem → **Configurações do projeto** → role até "Seus apps" → ícone `</>` (Web) → dê um nome (ex: "Jornada do Milhão") → **não** marque Firebase Hosting → **Registrar app**. Copie o bloco `firebaseConfig = {...}`.
5. Abra [`firebase-init.js`](firebase-init.js) e substitua os valores `COLE_AQUI_...` pelos que você copiou.

Essas chaves (`apiKey`, `projectId` etc.) são **públicas por design** no Firebase Web — pode subir pro GitHub sem problema. A segurança de verdade vem das regras do Firestore (passo 3).

## 2. Apps Script — Google Agenda + geração de PDF de contrato

O `Code.gs` faz 2 coisas, e só essas duas:
- Lê eventos do **Google Agenda** num intervalo de datas (o navegador sozinho não acessa a Agenda).
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
   | `AGENDA_CALENDAR_ID` | opcional — o e-mail/ID do calendário do Henry, se não for o calendário principal da conta que implantar o script. Deixe em branco pra usar o calendário principal ("primary"). |

5. Rode a função `autorizar` uma vez direto no editor (▶) — vai pedir permissão de acesso à Agenda e ao Drive.
6. **Implantar → Nova implantação** → tipo **"Aplicativo da Web"**:
   - Executar como: **Eu** (o e-mail que tem acesso à Agenda certa)
   - Quem pode acessar: **Qualquer pessoa**
   Copie a URL `.../exec` gerada.
7. Cole essa URL na constante `APPS_SCRIPT_PROXY_URL`, em [`firebase-init.js`](firebase-init.js).

**Toda vez que editar `Code.gs`**, é preciso fazer uma nova implantação (ou "Gerenciar implantações → editar → Nova versão") pra que a URL publicada reflita o código novo.

Enquanto isso não estiver configurado, o resto do sistema funciona normalmente — só os botões "Sincronizar Agenda" e a geração de PDF do contrato mostram um aviso.

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

- **clientes/{id}**: `nome`, `telefone`, `email`, `origem`, `observacoes`, `createdAt` — tabela auxiliar de consulta.
- **agendamentos/{id}**: `clienteNome`, `telefone`, `data` (yyyy-MM-dd), `hora`, `status` (`agendado`/`realizado`/`reagendado`/`nao-veio`), `origem` (`agenda`/`manual`), `googleEventId`, `convertido` (bool), `observacoes`, `createdAt`, `updatedAt` — Funil de Agendamento. Subcoleção `historico/` (create-only).
- **etapasVendaConfig/{id}**: `nome`, `ordem`, `fechamento` (bool) — colunas configuráveis do Funil de Vendas; a marcada como `fechamento` dispara o Gerador de Contrato quando um card é solto nela.
- **oportunidades/{id}**: `clienteNome`, `telefone`, `agendamentoId`, `etapa`, `valorProposto`, `observacoes`, `perdida` (bool), `motivoPerda`, `fechada` (bool), `contratoId`, `createdAt`, `updatedAt` — Funil de Vendas. Subcoleção `historico/`.
- **contratos/{id}**: `oportunidadeId`, `clienteId`, `clienteNome`, `valorTotal`, `formaPagamento` (`avista`/`entrada_parcelas`), `valorEntrada`, `numParcelas`, `diaVencimento`, `dataGeracao`, `pdfUrl`, `status`.
- **parcelas/{id}**: `contratoId`, `clienteId`, `clienteNome`, `numero` (0 = entrada), `valor`, `vencimento` (yyyy-MM-dd), `status` (`esperado`/`realizado`), `dataPagamento` — geradas automaticamente ao gerar um contrato.
- **despesas/{id}**: `descricao`, `categoria`, `tipo` (`despesa`/`outro_custo`), `valor`, `data`, `recorrente` (bool), `diaVencimento`, `ultimoMesLancado`, `origemRecorrenteId`.
- **etapasAdminConfig/{id}**: `nome`, `ordem`, `prazoDiasPadrao` — colunas configuráveis do Funil Administrativo.
- **cardsAdmin/{id}**: `contratoId`, `clienteId`, `clienteNome`, `valorTotal`, `etapa`, `dataEntrouEtapa`, `prazoEtapaAtual`, `createdAt`, `updatedAt` — Funil Administrativo, criado automaticamente ao gerar um contrato. Subcoleção `historico/`.

## Decisões tomadas nas perguntas em aberto do plano original

`plano_financeiro_funil.md` deixava várias perguntas em aberto (seções 2.3,
3.4, 4.3). Para poder construir a v1 inteira de uma vez, as seguintes
decisões padrão foram tomadas — todas ajustáveis depois, direto no app ou
na `planilha.html`:

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
  `CONTRATO_TEMPLATE_DOC_ID` para um mapa de modelos.
- **Etapas do Funil Administrativo**: como a lista completa e os prazos
  reais ainda não foram confirmados, o sistema já sobe com 4 etapas
  padrão de exemplo ("Pagamento da entrada", "Criação do grupo",
  "Execução", "Entrega") — edite, apague ou crie as etapas reais em
  **Configurações**, a qualquer momento.
- **Reagendamento**: se um evento da Agenda já convertido em oportunidade
  for reagendado, o card de **agendamento** é atualizado (nova data/hora,
  status "Reagendado") mas a **oportunidade** no Funil de Vendas não é
  movida automaticamente — ela continua de onde estava.
- **Quem move o card entre etapas**: por padrão é manual (arrastar no
  Kanban). As duas transições automáticas pedidas no plano — fim do
  agendamento → topo de vendas (via botão "Converter em oportunidade") e
  venda fechada → contrato gerado → topo do administrativo — já estão
  implementadas.

## Observações

- **Sem servidor "oficial"**: como não há Cloud Functions, a validação de
  regras de negócio (cálculo de parcelas, transições automáticas entre
  funis) roda no `app.js`, no navegador de cada usuário — protegida contra
  gravações mal-formadas pelas regras do Firestore, mas não contra alguém
  tecnicamente hábil abrindo o DevTools. Trade-off aceitável pro uso
  interno da equipe; como este sistema guarda dados financeiros, vale
  reconsiderar Firebase Auth se o número de pessoas com acesso crescer.
- **Sincronização da Agenda**: roda automaticamente (silenciosa) sempre que
  alguém abre o sistema, e também pelo botão manual "🔄 Sincronizar
  Agenda" no Funil de Agendamento. Sem Cloud Functions não existe um
  "servidor" verificando a Agenda sozinho o tempo todo.
- **Convenção assumida no evento da Agenda**: o **título do evento** vira o
  nome do cliente no card. Ajuste a forma como o Henry nomeia os eventos na
  Agenda se quiser um padrão diferente (ex: "Nome — Telefone").
