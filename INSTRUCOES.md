# Jornada do Milhão — Como colocar no ar

Este pacote tem estes arquivos:
- `firebase-init.js` → liga o sistema ao seu banco de dados (Firestore)
- `index.html`, `style.css`, `app.js` → o sistema que a equipe vai usar no navegador
- `firestore.rules` → regras de segurança, cola no console do Firebase
- `Code.gs` → a ponte com o Google Agenda e com a geração de PDF do contrato
- `planilha.html` → uma página separada pra você editar ou apagar dados direto, como se fosse uma planilha (veja o Passo 4 abaixo)
- `manifest.json`, `service-worker.js`, ícones (`.png`/`.ico`) → deixam o sistema instalável como aplicativo. **Precisam ficar na mesma pasta que o `index.html`**, sempre que for hospedar — não são opcionais.

## ⚠️ Já tem o sistema rodando? Duas coisas antes de tudo

O sistema passou a exigir login (2026-09-02). Antes disso, qualquer pessoa
com o link conseguia ler e alterar tudo, inclusive o financeiro. Pra ligar
o login, na ordem:

1. **Ligar o login.** No [console do Firebase](https://console.firebase.google.com),
   menu **Authentication → Começar** → habilite **E-mail/senha** → salvar.
   Sem esse passo, nenhum login funciona.
2. **Publicar as regras.** **Firestore Database → Regras** → apague o
   conteúdo → cole o de `firestore.rules` → **Publicar**.
3. Abra o sistema. Ele vai pedir pra **criar o primeiro acesso**: essa
   conta nasce administradora, e essa tela não aparece nunca mais.
4. Em **Configurações → Contas de acesso**, cadastre as outras pessoas.

Faça o passo 2 depois que a versão nova do site já estiver no ar. Se as
regras subirem antes do código, o sistema antigo (que ainda não sabe fazer
login) para de carregar dado até a versão nova chegar.

## Passo 1 — Criar o banco de dados (Firebase)

1. Acesse [console.firebase.google.com](https://console.firebase.google.com) e crie um projeto novo (gratuito).
2. Ative o **Firestore Database** (modo produção).
3. Em **Regras**, cole o conteúdo de `firestore.rules` e publique.
4. Registre um "app Web" nas configurações do projeto e copie a configuração (`firebaseConfig`).
5. Abra `firebase-init.js` num editor de texto simples e cole essa configuração no lugar dos valores de exemplo (`COLE_AQUI_...`).

## Passo 2 — Ligar a Agenda e a geração de PDF do contrato

1. Crie uma planilha Google Sheets em branco (só serve de "casa" pro script).
2. **Extensões → Apps Script**, cole o conteúdo de `Code.gs`.
3. Rode a função `autorizar` uma vez (▶) e autorize o acesso à Agenda e ao Drive.
4. **Implantar → Nova implantação → Aplicativo da Web** → Executar como "Eu" → Acesso "Qualquer pessoa" → Implantar. Copie a URL.
5. Cole essa URL no `firebase-init.js`, na constante `APPS_SCRIPT_PROXY_URL`.

O texto do contrato **não vem mais de um Google Docs** — ele já está pronto
dentro do `app.js` (função `montarHtmlContrato`) e o `Code.gs` só converte
em PDF. Se quiser mudar alguma cláusula, é lá que edita.

Enquanto você não fizer isso, o resto do sistema já funciona normal — só a criação do evento na Agenda e a geração do PDF do contrato ficam pendentes (aparece um aviso, sem travar o resto).

**Importante**: o fluxo é sempre sistema → Agenda, nunca o contrário — o sistema não lê nem importa nada da sua Agenda, só cria eventos novos quando você cria um agendamento por aqui. Em **Configurações → Calendário do Google Agenda**, escolha em qual calendário esses eventos são criados (pode ser um calendário dedicado a clientes, separado do seu pessoal).

### Ligar a assinatura eletrônica (Autentique) — opcional

Depois de gerar o PDF de um contrato, dá pra mandar ele direto pra
assinatura digital: a Autentique manda um e-mail pro cliente com o link
pra assinar, sozinha. Pra ligar isso:

1. Gere um token em [painel.autentique.com.br/perfil/api](https://painel.autentique.com.br/perfil/api).
2. No mesmo Apps Script do Passo 2 (⚙️ Configurações do projeto → Script
   Properties), adicione `AUTENTIQUE_API_TOKEN` com esse token.
   **Nunca cole esse token dentro do `Code.gs` nem em nenhum outro
   arquivo que vá pro GitHub** — como esses arquivos ficam públicos no
   repositório, o token vazaria pra qualquer pessoa. Script Properties é
   o único lugar seguro (fica só dentro do projeto do Apps Script).
3. Se quiser testar sem gastar documento de verdade, adicione também
   `AUTENTIQUE_SANDBOX` = `true` — depois troque pra `false` (ou apague)
   quando for usar pra valer.

Sem isso configurado, o resto do sistema continua funcionando normal — só
o botão "Enviar para assinatura digital" mostra um aviso do que falta.

**Deu o erro "Você não tem permissão para chamar UrlFetchApp.fetch"?**
Isso acontece se você já tinha autorizado o `Code.gs` antes desse botão
existir. No editor do Apps Script, rode a função `autorizar` de novo (▶)
— vai aparecer uma tela de permissão nova, pedindo acesso a "serviço
externo" — aceite, e depois faça uma **nova implantação** (Implantar →
Gerenciar implantações → editar → Nova versão). Só precisa fazer isso uma
vez.

### Ligar os leads automáticos da YayForms — opcional

Toda resposta enviada em qualquer formulário da YayForms pode virar um
lead sozinho, direto em "Novo Lead" no Funil de Agendamento, com o nome
do formulário salvo no campo "Origem" do cliente. Pra ligar:

1. Gere um token de API da YayForms em [yayforms.com/help/how-to-generate-a-yay-forms-api-token](https://yayforms.com/help/how-to-generate-a-yay-forms-api-token).
2. No mesmo Apps Script do Passo 2, adicione a Script Property
   `YAYFORMS_API_TOKEN` com esse token.
3. Invente uma senha longa (ex: uma sequência aleatória de letras e
   números) e adicione como Script Property `YAYFORMS_WEBHOOK_TOKEN`.
   Essa senha é o que impede qualquer pessoa que descubra a URL do
   sistema de criar leads falsos — guarde ela como guardaria qualquer
   senha.
4. Em cada formulário na YayForms: **Integrate → Webhooks → Add webhook**
   → cole a mesma URL `.../exec` do `Code.gs`, acrescentando no final
   `?origem=yayforms&token=` seguido da senha que você inventou no passo
   3. Salve. Repita pra cada formulário que deve virar lead.
5. Teste respondendo o formulário (ou usando o botão de teste do
   webhook) — o lead deve aparecer em "Novo Lead" em poucos segundos.

Sem isso configurado, o resto do sistema continua funcionando normal —
essa integração é só um jeito automático de criar leads, os manuais
continuam funcionando igual.

## Passo 3 — Colocar no ar

Este sistema **não funciona só abrindo o `index.html` no computador** (é
uma limitação de segurança do navegador). Ele precisa estar hospedado num
site com HTTPS. A forma mais simples e gratuita é o **GitHub Pages**:

1. Crie uma conta gratuita em [github.com](https://github.com), se ainda não tiver.
2. Crie um repositório novo.
3. Arraste todos os arquivos deste pacote pra dentro dele (soltos, sem pastas — menos o `Code.gs`, que fica só no Apps Script, não precisa subir pro GitHub).
4. Nas configurações do repositório, ative o **GitHub Pages** apontando pra branch principal.
5. Em alguns minutos, o link aparece — é esse link que a equipe vai usar.

## Passo 4 — Editar dados direto, como numa planilha

Se você quiser corrigir um dado, apagar um registro de teste, cadastrar as
etapas reais do funil administrativo, ou colar uma lista inteira de uma
vez, **não precisa entrar no site do Firebase**. Abra o link do seu site
com `/planilha.html` no final (ex: `https://seusite.github.io/planilha.html`).
Ela funciona como uma planilha: abas por tipo de dado, você edita a célula
e ela salva sozinha, seleciona várias linhas e apaga de uma vez, e tem
botões pra exportar em CSV/Excel ou importar um arquivo CSV/Excel de uma
vez.

**Só administrador entra nessa página**, com o mesmo login do sistema. Ela
edita o banco direto, sem nenhuma trava de negócio: dá pra apagar um
contrato, mudar um valor pago, zerar uma parcela. Use com calma.

## Quem entra no sistema, e o que cada um vê

Cada pessoa tem a própria conta, com um papel:

- **Administrador** — vê tudo, cria as contas das outras pessoas e é o
  único que abre a planilha administrativa.
- **Gerente** — vê tudo do negócio, inclusive Painel Financeiro, Entradas e
  Despesas. Não mexe em contas nem na planilha.
- **SDR** — trabalha os funis, os clientes e os contratos. Não vê Painel
  Financeiro, Entradas nem Despesas: esses itens nem aparecem no menu dela.

### Criar a conta de alguém

Em **Configurações → Contas de acesso**, clique em "+ Conta de acesso" e
preencha nome, e-mail, telefone e o papel. Ao salvar, a conta de login é
criada na hora (você não precisa entrar no site do Firebase) e a tela mostra
a **senha de primeiro acesso**, que é a mesma pra todo mundo:
`Jornada@2026`.

Repasse essa senha pra pessoa. No primeiro login ela cai direto numa tela
"Crie sua senha" e só entra depois de escolher uma senha própria — é isso
que faz a senha compartilhada ser descartável. O e-mail não pode ser trocado
depois.

Pra tirar o acesso de alguém que saiu, prefira **suspender** em vez de
excluir: o acesso é bloqueado na hora e o histórico de quem era continua
lá.

Você não consegue mudar o próprio papel nem suspender a própria conta. É de
propósito: se o único administrador se rebaixasse por engano, ninguém mais
conseguiria criar conta nenhuma.

## Sempre que atualizar o Code.gs

Depois de editar `Code.gs` no futuro, é preciso criar uma **nova
implantação** (ou "Gerenciar implantações → editar → nova versão") pra as
mudanças valerem.

## Como usar o funil no dia a dia

Os 3 funis moram numa tela só ("Funis" no menu) — use os botões
📅 Agendamento / 📈 Vendas / 🗂️ Administrativo no topo pra trocar qual
kanban está visível, sem sair da tela.

- **Etapas de cada funil são 100% suas** — vá em **Configurações** e crie,
  edite ou apague as etapas de Agendamento, Vendas e Administrativo. Cada
  etapa tem nome, ordem, e um SLA (🟡 amarelo / 🔴 vermelho) em horas ou
  dias — o card fica com essa cor a partir do tempo que passou desde que
  entrou na etapa, atualizado sozinho a cada minuto. As etapas que vêm de
  fábrica (edite à vontade):
  - **Agendamento**: Novo Lead, Tentativa de Contato, Retomar Contato,
    Qualificação, Agendado, Reagendado, Perdido.
  - **Vendas**: Reunião Agendada, Follow Up, Negociação, Fechado, Perdido.
  - **Administrativo**: Recebimento da Entrada, Criação do Grupo, Envio do
    Contrato, Enviado para Mentoria.
- **Funil de Agendamento**: clique em "+ Agendamento manual", busque o
  cliente já cadastrado (ou crie um novo direto no campo) e preencha
  data/hora. O card nasce na 1ª etapa (Novo Lead, por padrão) e você
  arrasta ele pelas etapas conforme o contato avança. Assim que o card
  chega em **Agendado** ou **Reagendado** (marcadas "Entra em Vendas" em
  Configurações), o sistema cria a oportunidade automaticamente no Funil
  de Vendas e o evento na Google Agenda, sem precisar de mais nenhum
  clique. Arrastar pra **Perdido** pede o motivo. Leads que chegam
  sozinhos por formulário (veja "Ligar os leads automáticos da YayForms"
  no Passo 2) também nascem aqui, na mesma etapa — clique no card pra ver
  em "Origem do lead" de qual formulário ele veio.
- **Funil de Vendas**: arraste o card entre as etapas normalmente. Ao
  arrastar pra etapa marcada como "fechamento" (vem como "Fechado" por
  padrão), o card **não é movido ainda** — abre o gerador de contrato com
  cliente e valor já preenchidos; complete o que faltar (telefone, e-mail,
  forma de pagamento) e gere. A forma de pagamento pode ser à vista,
  entrada + parcelas iguais, ou **parcelas personalizadas** (você digita o
  valor e o vencimento de cada uma — útil quando as parcelas não são todas
  do mesmo valor, tipo "1º e 2º mês R$4.000, 3º e 4º mês R$5.000..."). Só
  depois de gerado o contrato o card entra de fato em "Fechado", as
  parcelas aparecem no financeiro e um card novo nasce no Funil
  Administrativo. Arrastar pra "Perdido" pede o motivo. No detalhe do
  contrato (depois do PDF pronto), dá pra mandar direto pra assinatura
  eletrônica — veja "Ligar a assinatura eletrônica" no Passo 2.
- **Cliente pessoa jurídica (CNPJ)**: assim que você digita um CNPJ (12+
  dígitos) no CPF/CNPJ do cliente, aparecem 2 campos novos — "Nome do
  representante legal" e "CPF do representante" — obrigatórios pra gerar
  contrato com esse cliente. É o sócio/representante que assina pela
  empresa; entra automaticamente no texto do PDF (parágrafo de
  qualificação e assinatura). Cliente pessoa física não precisa disso.
- **Funil Administrativo**: arraste o card entre as etapas conforme o
  atendimento avança — a cor do SLA no card reflete quanto tempo falta
  (ou já passou) do prazo daquela etapa.
- **Painel Financeiro**: escolha o mês no seletor do topo pra ver as
  métricas daquele período. Parcelas vencidas e não pagas aparecem
  destacadas pra cobrança manual.
