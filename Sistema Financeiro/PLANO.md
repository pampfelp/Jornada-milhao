# Sistema Financeiro dos Mentorados — plano

`2026-09-24` · rascunho pra validação

Sistema onde cada mentorado da Jornada do Milhão entra com login próprio e
enxerga o financeiro da empresa dele. Fontes analisadas: as duas planilhas
base (`PLANILHA DE CUSTOS 2026.xlsx` e `FOLHA DE PAGAMENTO.xlsx`), os dois
áudios do o gestor da empresa-piloto (gestor da a empresa-piloto) transcritos nos prints, e as seis
referências visuais (Finstack / Ledgerix).

---

## 1. O que as fontes dizem

### 1.1 O que a planilha de custos faz hoje

Uma aba por mês e por unidade (`JULHO`, `MAR UNIDADE A`, `FEV UNIDADE B`…),
uma linha por venda. As colunas, na ordem em que ela calcula:

| Bloco | Colunas |
|---|---|
| Identificação | Cliente, Vendedor |
| Técnico | kWh, kWp |
| Custo direto | Kit Solar, Vistoria, Engenharia, Instalação, Custos com obras |
| Soma | **Soma do Custo Base** |
| Precificação | % Margem de desconto, Valor de desconto, Valor do Projeto Unitário |
| Venda | Valor de Venda, Nº de Vendas, Total de Venda |
| Comissão | Comissão %, Comissão Vendedor, Comissão SDR, Comissão Prospectador |
| Fecho | Marjoramento, **CustoTotal**, **Lucro Bruto** |

No rodapé da mesma aba, um segundo bloco com custo fixo (imposto, insumos,
tráfego pago, custo operacional), o total deles, e o **Lucro Líquido** com a
**margem líquida** ao lado.

O mês de julho fechou assim, e esses números servem de teste de aceitação do
sistema: R$ 251.056 de venda, R$ 156.126 de custo total, R$ 94.929 de lucro
bruto (37,8%), R$ 81.075 de custo fixo, R$ 13.854 de lucro líquido (5,5%).

Na `PLANILHA BASE` a lista de custo fixo é mais longa e mostra a intenção
real: internet, insumos, tráfego pago, aluguel, pró-labore, energia, folha
salarial, comissão de prospecção, custo operacional.

Anotações soltas do lado, que são decisão de negócio e não cálculo: giro de
caixa de 4 meses de operação, divisão de lucro trimestral, não dividir lucro
no primeiro ano, retirada trimestral mediante alcance de meta.

### 1.2 O que a folha de pagamento faz hoje

Uma aba por mês de referência (`REF-FEV` a `REF-JUL`) mais uma aba de
comissões. Por pessoa: nome, função, salário, ajuda de custo, uma sequência
de antecipações e depósitos com data, unidade (loja), chave PIX, banco,
valor em caixa, total e situação (`PARCIAL`, `DEPOSITADO`).

Três grupos com regra de pagamento diferente, escrita na própria planilha:

- Administrativo e diretoria: salário fixo, com pró-labore de CEO e sócio
  gerente na mesma tabela.
- Vendedores (comercial): pagamento entre os dias 05 e 20 do mês.
- Prospectadores: pagamento toda segunda-feira.

A aba de comissões é separada porque a regra é outra: todo dia 15, sobre a
venda do mês anterior. Ela guarda nome, PIX, mês de referência, valor base
de venda, percentual e valor a pagar.

### 1.3 O que o o gestor da empresa-piloto descreveu nos áudios

Ele descreve a mesma cadeia, em três planilhas separadas que na cabeça dele
são um sistema só:

1. A DRE por projeto, com kit, instalação, engenharia e comissão de venda
   descontados do valor do projeto, chegando na **margem bruta**.
2. Uma segunda planilha com o custo fixo da empresa, que abatido do lucro
   bruto dá a **margem líquida**.
3. Uma terceira com custo fixo e custo operacional juntos.

E um quarto bloco que é o achado mais importante dos dois áudios:

> "Esse custo não previsto ele fica separado né? [...] só pra eu entender o
> que que a gente saiu do nosso caixa e só que eu não faço uma correlação ou
> ao cliente porque acaba que esse custo acontece mensalmente de obras mais
> antigas de clientes que já foram entregue [...] Aí eu só faço um
> levantamento mesmo pra eu saber o que que não estava previsto naquele mês
> e teve custo e pra eu poder deduzir lá do lucro bruto também."

**Custo não previsto é uma categoria própria.** Sai do caixa, não tem cliente
vinculado, vem de retrabalho de obra já entregue (goteira, revisita, visita
técnica), e é apurado por levantamento mensal. Nenhuma das duas planilhas
base tem essa linha, e é justamente onde a margem real vaza. Ele é deduzido
do lucro bruto, não do custo do projeto.

Sobre a folha, ele fecha dizendo que ela tem "uma coluna que tem os
pró-labores, os pró-labores do sócio e os gastos extras". A folha base já
tem o pró-labore misturado com salário; os gastos extras não aparecem.

### 1.4 A cadeia que o sistema tem que reproduzir

Isso é a espinha de tudo. Todas as telas existem em função dela.

```
  Receita do período (Total de Venda)
− Custos variáveis VINCULADOS  (kit, instalação, vistoria, engenharia, obra…)
− Comissões                    (vendedor, SDR, prospectador)
────────────────────────────────────────────────────
= LUCRO BRUTO                                    → margem bruta %
− Custos variáveis AVULSOS     (tinta do escritório, retrabalho de obra entregue)
− Custos fixos e folha         (aluguel, internet, energia, salários, pró-labore)
− Impostos
────────────────────────────────────────────────────
= LUCRO LÍQUIDO                                  → margem líquida %
```

O "custo não previsto" que o o gestor da empresa-piloto descreve é um **custo variável avulso**,
e não precisa de conceito próprio: é um custo que aconteceu, saiu do caixa,
não está vinculado a nenhuma venda do mês, e por isso entra abaixo do lucro
bruto. A tinta pra pintar o escritório e a revisita da goteira caem na mesma
linha, pelo mesmo motivo.

E, por cima dela, a separação que já é regra da Jornada em
`negocios/jornada-do-milhao.md`: **faturamento não é caixa**. O que foi
vendido no mês e o que entrou no mês são duas linhas diferentes, e a tela
precisa deixar isso óbvio.

---

## 2. As referências visuais

As seis referências (Finstack e Ledgerix) compartilham o mesmo vocabulário:
fundo claro quase branco, cards brancos de canto bem arredondado, número
grande como protagonista, um verde neon usado com parcimônia só no que
importa, gráfico sem grade pesada, pílulas de filtro no topo, trilha de
ícones à esquerda.

Uma das referências carrega um dado de pesquisa que vale como diretriz de
produto, e é exatamente o público do sistema:

- 39% acham a gestão financeira frustrante por **relatório pouco claro**
- 61% dos donos ainda controlam **manualmente**
- 52% querem **clareza e orientação**, não só o número

Traduzido pro que a tela faz: ao lado de todo número importante vai uma
frase curta dizendo o que ele significa ou o que mudou, no lugar do número
sozinho.

O que vem das referências é a **composição**, não a cor. A paleta é a da
Jornada do Milhão, que já está no `style.css` do sistema atual:

```css
--bg:#0A0A0A; --panel:#151515; --panel-2:#1C1C1C;
--ink:#FFFFFF; --ink-soft:#B3B3B3; --ink-faint:#6E6E6E; --line:#2A2A2A;
--dourado:#FED116; --dourado-soft:rgba(254,209,22,.13); --dourado-deep:#D9AE00;
--credit:#22C55E; --debit:#EF4444; --warn:#F59E0B; --info:#3B82F6;
--display:'Sora'; --sans:'Manrope'; --mono:'IBM Plex Mono';
```

Fundo escuro com dourado, portanto, com a composição clara das referências
transposta pro escuro. O verde e o vermelho continuam sendo entrada e saída,
como manda o design system.

**Co-branding.** Topo com a logo da Jornada à esquerda, um divisor fino, e a
logo PNG da empresa do mentorado ao lado. Altura fixa, largura livre, fundo
transparente. Enquanto ele não sobe nada, aparece só a Jornada.

**A marca.** A bússola oficial e o lettering `JORNADA DO M1LHÃO` saem dos
arquivos do próprio repositório, recortados do fundo preto pra terem
transparência de verdade. A bússola aparece em três lugares: marca da trilha
lateral, tela de entrada, e gigante no fundo, girando devagar a 3,5% de
opacidade. A grafia `M1LHÃO` é a do manual, e não se corrige (crença 19).

**No computador, trilha de ícones à esquerda. No celular, barra inferior.**
Decidido por ele em 2026-09-24, com referência visual: barra flutuante em
formato de pílula presa no rodapé, fundo translúcido com desfoque, ícone
sozinho nos itens inativos e o item ativo virando uma pílula dourada com o
nome escrito. Ponto vermelho no item de Pendências quando houver custo em
aberto.

Isso é Jacob's Law aplicado: no celular, menu no rodapé é onde o dedo já
espera, e é onde todo app financeiro põe.

---

## 3. Decisões fechadas

### D1. Repositório e projeto Firebase novos ✅

O sistema de hoje (`financeirojornadamilhao`) é o financeiro **da** Jornada:
funis, contratos, entradas, despesas, clientes, tarefas. Quem usa é o
o mentor e a equipe. O sistema novo é o financeiro **dos clientes** da
Jornada, e cada um vê só o dele. Dois repositórios, dois projetos Firebase,
sem cruzamento.

Três motivos, cada um já documentado como problema real: cliente externo
escrevendo no banco do negócio é o que a crença 12 proíbe; a cota do
Firestore compartilhada já quase derrubou o SolarGreen-ERP em produção
(crença 10); e o `app.js` atual tem 297 KB com oito telas, bem além do ponto
de divisão da crença 8.

### D2. Todos de energia solar ✅

Os custos variáveis de uma venda já nascem sugeridos com as linhas do ramo:
**kit solar, instalação, vistoria, engenharia**. O usuário acrescenta o que
quiser por cima (custo de obra, guindaste, o que for), e o que ele criar fica
salvo pra reaparecer na próxima venda.

Fixo como padrão, aberto na ponta. Não é catálogo configurável por segmento,
é uma lista padrão com acréscimo livre.

### D3. Receita por competência, custo no mês em que foi pago ✅

Decisão delegada a mim, e eu escolhi o regime misto, que é o que a planilha
dele já faz e o que o o gestor da empresa-piloto descreve:

- **Venda entra no mês em que foi vendida.** Faturamento é competência.
- **Custo entra no mês em que foi pago.** Foi confirmado por ele
  explicitamente, e é o que faz o custo não previsto funcionar.

A consequência honesta disso: a margem de uma venda pode mudar depois, se um
custo dela chegar atrasado. Isso não é defeito, é o motivo de existir a tela
de pendências da T3. Enquanto tiver custo esperado em branco, o lucro bruto
daquela venda está provisório, e a tela diz isso.

O que **não** muda retroativamente é mês fechado. Custo que chega depois do
fechamento bate no mês em que foi pago, nunca reabre o anterior.

A tela de Caixa da fase 2 mostra o realizado por data, e é lá que faturamento
e caixa aparecem lado a lado.

### D3b. Todo número calculado é KPI, nunca campo digitado ✅

Regra dele, e vale pro sistema inteiro: **operação matemática mora no
sistema, não no formulário.** Se o sistema consegue calcular, ele calcula e
mostra; ninguém digita resultado.

Some dos campos de digitação, por serem calculados:

| Sai do formulário | Vira |
|---|---|
| Soma do Custo Base | soma das linhas de custo da venda |
| CustoTotal | custo base + comissões |
| Lucro Bruto e margem | receita − custo total, calculado ao vivo no modal |
| Valor do Projeto Unitário | preço antes do desconto |
| Nº de Vendas | contagem, KPI do topo da tela |
| Total de Venda | soma, KPI do topo da tela |

E dois campos viram **par com escolha**, onde a pessoa digita um e o sistema
preenche o outro:

- **Desconto:** percentual ou valor fixo, ela escolhe qual digita.
- **Comissão:** percentual ou valor fixo, mesma coisa.

### D3c. kWh sai do cadastro ✅

Fica só o **kWp**. O kWh da planilha não alimenta cálculo nenhum e vira campo
a mais pra errar.

### D4. Histórico: a empresa-piloto importa do xlsx, o resto começa vazio ✅

A a empresa-piloto entra com o máximo de dado que der pra tirar das planilhas que ele
mandou. Todo mentorado novo começa com a lista vazia.

O que dá e o que não dá está detalhado no item 6. Tem armadilha ali.

### D5. Logo em base64, sem Blaze ✅

Nada de Storage. A logo vai em base64 dentro de `empresas/{id}`, com três
cuidados que tiram o veneno do gatilho B10:

- Redimensionada no navegador antes de salvar, com largura máxima de 480px.
- Teto de 120 KB, com recusa e aviso claro se o arquivo passar disso. O
  documento do Firestore tem limite de 1 MB, e a logo não pode ser o que o
  estoura.
- Guardada no documento da **empresa**, que é lido uma vez por sessão, nunca
  numa coleção que aparece em lista.

O gatilho B10 fala de foto embutida em documento de coleção listada, que é o
caso caro. Um documento só, lido uma vez, é seguro.

---

## 4. As telas

Nove ao todo, divididas em duas fases. A fase 1 é o que precisa existir pro
mentorado fechar um mês inteiro sozinho.

### Fase 1

**T1. Login.** Logo da Jornada, e-mail e senha. Sem cadastro aberto: quem
cria o acesso do mentorado é a Jornada.

**T2. Visão Geral.** A tela que justifica o sistema. A cadeia de margem do
item 1.4 desenhada de cima a baixo, com faturamento, lucro bruto e lucro
líquido como os três números grandes, cada um com a margem em percentual e
uma frase curta de leitura ao lado. Pílula de período no topo.

Três leituras abaixo dos números:

1. **Vendas por dia.** O mesmo gráfico de linha da tela de Vendas, já aberto
   no mês que está filtrado no topo.
2. **Mês a mês.** Barra do faturado pra cima, resultado pra baixo, verde
   quando sobrou e vermelho quando faltou, com o valor escrito. Clicar numa
   barra troca o mês filtrado do sistema inteiro.
3. **Para onde foi o dinheiro.** Rosca fina com a composição do custo do mês.
   Cinco fatias: custos variáveis, custos fixos e folha, impostos, comissões
   e custos não previstos. Legenda ao lado com percentual e valor, e o custo
   total no miolo.

A fatia de **custos não previstos é a única em vermelho**, de propósito: é a
categoria que o o gestor da empresa-piloto descreve como a que come a margem sem aparecer, e a
cor faz ela saltar mesmo quando é a menor de todas.

**T3. Vendas.** A aba mensal da planilha de custos virando tela. Uma linha
por venda, com KPI no topo (crença 17).

No alto da tela, um **gráfico de linha que é o filtro do sistema**. Ele abre
mostrando mês a mês do ano corrente. Clicar num mês abre os dias daquele mês;
clicar num dia isola o dia. Cada nível refiltra a lista, os KPIs e o rótulo
de período do topo, e uma migalha (`2026 › Julho › dia 12`) mostra onde se
está e deixa voltar.

Isso substitui o seletor de período por um controle único: o mesmo gesto que
lê o gráfico é o que filtra a tela.

Clicar na venda abre o modal dela **já com os quatro custos esperados do
ramo**, cada um com o campo em branco esperando valor: kit solar, instalação,
vistoria e engenharia. Abaixo deles, um botão de acrescentar linha.

**Só essas quatro vêm esperadas.** Linha que o usuário cria (custo de obra,
guindaste) fica guardada no catálogo e disponível pra acrescentar quando
fizer sentido, mas não entra sozinha em venda nova nem gera pendência.
Corrigido em 2026-09-24 a pedido dele.

Conforme os valores entram, o lucro bruto e a margem daquela venda se
recalculam ali mesmo, sem salvar pra descobrir o resultado.

**T3b. Pendências.** A lista do que falta preencher, em cima da mesma venda:
`Cliente | Data da venda | Custo pendente`. Cada custo esperado que ainda
está em branco vira uma linha, e ela some sozinha quando o valor entra.

É a tela que faz o regime de custo por data de pagamento ser honesto: ela diz
quais vendas ainda têm margem provisória, em vez de deixar o painel mostrar
um lucro bruto que ainda vai mudar.

**T4. Custos.** A tela onde a conta acontece de verdade. Todo custo do
período aparece aqui, venha de onde vier:

- custo digitado dentro de uma venda (vinculado)
- custo avulso lançado aqui mesmo (a tinta do escritório, a revisita)
- **a ocorrência mensal de cada custo fixo e de cada linha da folha**

A tabela de custos fixos da T5 é só a **base**. Ela gera a ocorrência do mês,
a ocorrência cai aqui, e é daqui que sai o número que entra na DRE. Isso
significa que o custo fixo do mês pode ser editado, adiado ou marcado como
não pago sem mexer na base, que é o comportamento que o FinanceiroPamplona já
tem com `recorrentes` gerando `movimentacoes`.

Filtros no topo: vinculado, avulso, fixo, folha, e **unidade**. Vínculo é
opcional e editável dos dois lados, então dá pra soltar um custo da venda ou
amarrar depois.

Uma tela só com tudo dentro é o que cumpre a crença 32: nada que foi gravado
some de todas as telas por ter sido digitado noutro lugar.

**T5. Custos Fixos e Folha (a base).** Uma tela só, porque pra ele é a mesma
coisa: dinheiro que sai todo mês independente de ter vendido. Duas abas.

A aba de **custo fixo** tem aluguel, internet, energia, tráfego pago,
ferramentas, imposto. Cada linha tem valor e dia de vencimento, e gera a
ocorrência do mês na T4.

A aba de **folha** tem as pessoas agrupadas por categoria, com a regra de
pagamento de cada grupo visível (administrativo mensal, vendedores entre os
dias 05 e 20, prospectadores toda segunda). Por pessoa: salário, ajuda de
custo, pró-labore marcado como tal, gastos extras, antecipações com data, e a
situação (parcial, depositado).

Nenhum total sai daqui. O total é da T4, porque é lá que está o que foi pago
de verdade.

**T6. Configurações.** Dados da empresa, upload da logo PNG, linhas de custo
padrão, percentual padrão de comissão por papel, unidades, mês de abertura, e
a chave **"Autorizar acesso da Jornada"**.

A chave é do mentorado. Ligada, a empresa dele aparece na lista da Jornada e
o mentor consegue filtrar por ela. Desligada, a Jornada não vê o dado. Sem
chave ligada não existe leitura, e isso vale na regra do Firestore, não só na
tela.

### Fase 2 (construir, e depois avaliar se valem)

Ele pediu pra fazer e julgar a utilidade com a tela na frente, em vez de
decidir agora no papel.

**T7. Comissões.** Por vendedor, com base de venda, percentual, valor a pagar
e status, seguindo a regra do dia 15 sobre o mês anterior. Na fase 1 a
comissão já é calculada dentro da venda; esta tela é a visão de quem paga.

**T8. Caixa.** Recebimentos e pagamentos por data, com o realizado do mês ao
lado do faturado. É aqui que faturamento e caixa ficam lado a lado.

**T9. Fechamento do Mês.** A DRE do mês em uma página, pronta pra exportar
em PDF e levar pra reunião de mentoria. Fecha o ciclo: o mentorado fecha o
mês no sistema e leva o resultado pro o mentor.

### Do lado da Jornada

Uma tela de administração onde a Jornada cria a empresa do mentorado, gera o
primeiro acesso, e enxerga quem está usando e quem parou de lançar.

O dado financeiro só aparece pras empresas com a chave `autorizaJornada`
ligada, e a Jornada filtra por elas. A chave é do mentorado, não da Jornada.

### A dashboard funciona por filtro cruzado

Decisão dele de 2026-09-24, com o Power BI como referência: **um gráfico
filtra os outros e os KPIs.** Não existe número solto na tela; tudo responde
ao mesmo recorte.

| Você clica em | O que muda |
|---|---|
| Uma barra do mês a mês | Mês inteiro do sistema: KPIs, cadeia da DRE, gráfico diário, rosca, listas |
| Um ponto do gráfico de linha | Mês, ou dia, conforme o nível em que ele está |
| Uma fatia da rosca, ou a linha dela na legenda | Abre a composição daquele número |
| Uma linha da cadeia da DRE | Abre a composição daquele número |
| Uma pílula de filtro em Custos | Filtra a lista e recalcula os KPIs da tela |
| A pílula de unidade no topo | Recorta o sistema por unidade |

**Todo número grande abre.** Clicar em qualquer linha da cadeia da DRE ou da
legenda da rosca abre um modal com os lançamentos que formaram aquele valor,
cada um com o percentual que representa e o total no rodapé. O faturamento
abre as vendas do mês; o custo fixo abre linha por linha; os custos não
previstos abrem com o motivo e a obra de origem.

Ao passar o mouse, a fatia da rosca e a linha da legenda se realçam juntas, e
as outras fatias esmaecem.

### Como o sistema fala

Regra dele, de 2026-09-24: **a tela nunca comenta a si mesma nem cita
pessoas.** Nada de explicar por que um campo é calculado, de que planilha o
número saiu, ou quem sugeriu a regra. Só a informação que o dono da empresa
precisa pra decidir.

O que isso proíbe na prática: legenda tipo "calculado, não digitado", nota de
rodapé explicando a arquitetura, e qualquer frase que cite alguém pelo nome.
O que continua valendo: a frase curta de leitura ao lado do número, desde que
fale do negócio dele e não do sistema.

### Movimento

Pedido dele na mesma data. O sistema tem transição e animação em toda
interação, feitas em CSS e JavaScript, sem biblioteca:

- Entrada escalonada dos cartões ao trocar de tela.
- Linha do gráfico desenhada de ponta a ponta, barras crescendo da base,
  arcos da rosca preenchendo em sequência.
- Modal entrando com escala e saindo pelo mesmo caminho.
- Barra inferior do celular com a pílula do item ativo se expandindo.
- Fundo vivo: a bússola girando devagar, dois brilhos dourados respirando em
  ciclos diferentes, e uma malha sutil deslizando.
- Tudo desligado sob `prefers-reduced-motion`.

---

## 5. Dados

Multi-empresa desde a primeira linha. Tudo pendurado embaixo da empresa, e
nunca em coleção raiz compartilhada.

```
empresas/{empresaId}
  nome, cnpj, logoBase64, mesAbertura, unidades:[…],
  autorizaJornada: bool          ← a chave da T6

  membros/{uid}            papel: dono | financeiro | leitura
  linhasCusto/{id}         nome, padrao:bool, ordem
                           ← kit, instalação, vistoria, engenharia vêm semeados;
                             o que o usuário criar entra aqui e reaparece depois

  vendas/{id}              cliente, vendedor, unidade, data, mesRef, kwp,
                           valorVenda, descontoTipo: pct|valor, descontoValor,
                           comissoes:[{papel, tipo: pct|valor, valor}],
                           custosEsperados:[linhaCustoId],
                           pendencias: int          ← quantos custos ainda em branco

  custos/{id}              descricao, linhaCustoId, dataPagamento, mesRef,
                           valor, unidade,
                           origem: venda | avulso | fixo | folha,
                           vendaId | null, clienteId | null, fixoId | null

  custosFixos/{id}         nome, valor, diaVencimento, ativo, tipo: fixo|folha
                           ← só a BASE; a ocorrência do mês vira doc em custos/

  folha/{mesRef}/pessoas/{id}
                           nome, funcao, grupo, unidade, salario, ajudaCusto,
                           proLabore, extras, antecipacoes:[{data,valor}],
                           situacao

  fechamentos/{mesRef}     os totais consolidados do mês, gravados no fecho

usuarios/{uid}             empresaId, papel        ← fonte da permissão
```

**Nada de valor calculado gravado no documento da venda.** `custoTotal` e
`lucroBruto` saíram do modelo de propósito: são a soma dos `custos` daquela
venda, e gravar o resultado junto criaria o gatilho C1, com dois números pra
divergir quando um custo chegasse atrasado. O que fica gravado é
`pendencias`, que é contagem e não resultado, e serve pra T3b não precisar
varrer os custos de toda venda pra montar a lista (gatilho A11).

O único lugar onde total calculado é gravado é `fechamentos/{mesRef}`, e de
propósito: mês fechado não muda mais, então o número congelado ali é o certo.

O campo que carrega a regra toda é o `vendaId` de `custosVariaveis`. Ele
preenchido põe o custo dentro do lucro bruto; ele nulo põe embaixo. É um
campo só decidindo os dois lados da conta, o que evita o erro do gatilho C1,
de o mesmo valor existir em dois lugares e divergir.

**Custo vinculado a cliente sem estar vinculado a venda fica embaixo do lucro
bruto.** É o caso do o gestor da empresa-piloto: a revisita da goteira é de um cliente
identificável, mas de uma obra entregue meses atrás. Amarrar no cliente serve
pra ele enxergar quem dá prejuízo depois de entregue; reabrir a margem de um
mês já fechado não serve pra nada. Mês fechado fica fechado, e o custo bate
no mês em que foi pago. **Isso é premissa minha, confirma se está certo.**

Três coisas que valem registrar agora porque são caras de mudar depois:

**A empresa do usuário nunca é escrita pelo próprio usuário.** `usuarios/{uid}`
é gravado só pela Jornada no momento de criar o acesso, e a regra usa
`hasOnly` pra impedir campo extra. Esse é o gatilho A7, que já custou uma
escalada de privilégio encontrada na revisão de segurança de 02/09.

**Nunca escutar coleção inteira.** Toda leitura de `vendas` e `custos` vem
filtrada por empresa e por período, com índice composto. Gatilho A1, que é o
que estourou a cota do SolarGreen em produção.

**Os totais do mês ficam gravados em `fechamentos`.** Recalcular a DRE de
doze meses a cada abertura do painel é leitura demais (gatilho A11). O
fechamento grava o consolidado; o mês corrente é o único recalculado ao vivo.

---

## 6. A importação da a empresa-piloto

Abri as treze abas e conferi o que dá pra aproveitar de verdade. Tem coisa
boa e tem armadilha, e as armadilhas mudam o que dá pra prometer.

### O que existe

| Aba | Vendas com dado | Tem nome do cliente? |
|---|---|---|
| FEV UNIDADE A | 2 | não |
| FEV UNIDADE B | 4 | não |
| MAR UNIDADE A | 7 | não |
| MAR UNIDADE B | 6 | não |
| ABR UNIDADE A | 7 | não |
| ABR UNIDADE B | 5 | não |
| MAI UNIDADE A | 7 | não |
| JUN UNIDADE A | 7 | não |
| JULHO | 12 | **sim** |
| PLANILHA BASE | 0 (é o gabarito em branco) | — |

Mais seis abas de folha (`REF-FEV` a `REF-JUL`) e uma de comissões.

### As cinco armadilhas

**1. Só julho tem cliente e vendedor.** As outras oito abas têm os números e
nenhum nome. Elas importam como vendas sem identificação ("Venda 3 de
JUN UNIDADE A"), o que serve pro gráfico de evolução e pra margem do mês, e
não serve pra olhar cliente por cliente. Julho é a única aba que entra
completa.

**2. As colunas mudam de aba pra aba.** FEV UNIDADE B tem 17 colunas, uma
"Comissão" só e nenhum "Custos com obras". JUN UNIDADE A tem 21, com as três
comissões separadas. JULHO tem 23, com Cliente e Vendedor na frente, o que
empurra todas as outras uma casa pra direita. O importador lê pelo **nome do
cabeçalho**, nunca pela posição da coluna. Ler por posição importaria kit
solar no campo de vistoria sem erro nenhum aparecer.

**3. Duas unidades, e o sistema não tem esse conceito.** UNIDADE A e UNIDADE B
rodam em paralelo de fevereiro a abril, cada uma com custo fixo próprio. De
maio em diante só sobra Unidade A. A folha também tem coluna de loja
(MATRIZ, UNIDADE A). **Isso é requisito que não estava no plano e preciso que
você decida:** as duas unidades viram uma empresa só com os números somados,
ou o sistema precisa de unidade como dimensão?

**4. Quatro células de kWp estão corrompidas.** O Excel entendeu "6.10" como
data e gravou `2026-10-06` no lugar do número. Estão em FEV UNIDADE B (2),
MAR UNIDADE B (1) e JULHO (1). O importador precisa detectar e desfazer, senão
entra data em campo de potência. É o mesmo tipo de estrago que já mordeu no
CRM Oliveira com ID virando notação científica.

**5. O custo fixo foi ficando opaco com o tempo.** FEV UNIDADE B discrimina
doze linhas (internet, extras, tráfego, Clicksign, aluguel, pró-labore, custo
operacional, energia, folha, Isales, imposto, comissão de prospecção).
JULHO tem quatro, e R$ 70.075 dos R$ 81.075 estão numa linha só chamada
"custo operacional". Importar julho traz um custo fixo praticamente cego.
Dá pra importar assim e ele detalha depois dentro do sistema, que é
justamente o ganho de sair da planilha.

### Uma coisa que ele precisa saber antes de ver a tela

**Dois meses fecharam no vermelho.** JUN UNIDADE A deu prejuízo de
R$ 31.247 (margem líquida de −23,2%) e FEV UNIDADE B de R$ 759 (−0,8%). Os
números estão corretos nas planilhas, é o resultado real. Digo isso porque o
gráfico de evolução vai mostrar isso logo na primeira abertura, e é melhor
saber antes de mostrar pro o gestor da empresa-piloto. O painel precisa tratar margem negativa
com naturalidade, em vermelho, sem quebrar escala de gráfico.

### Como a importação roda

Script rodado uma vez por mim, fora do sistema, gerando os documentos do
Firestore direto. Não é tela de upload de xlsx: é trabalho de uma vez só pra
uma empresa só, e a crença 34 diz pra não construir tela pra caso único.
Mentorado novo começa com a lista vazia, como você decidiu.

---

## 7. Economia de leitura, com um cliente só e pensando em trinta

Ele pediu pra já trazer o que o segundo cérebro sabe sobre economizar
requisição. Isso é a crença 10 e os gatilhos A1, A11 e E1, e o histórico é
concreto: a cota gratuita de 50.000 leituras por dia estourou em produção no
SolarGreen-ERP em 29/08 e o sistema ficou inutilizável até a virada do dia.

Sete regras que valem desde a primeira linha, mesmo com um cliente só:

1. **Filtrar na consulta, nunca no JavaScript.** Toda leitura de `vendas` e
   `custos` sai com `where('mesRef','==',…)` e `where` de empresa. Trazer o
   ano inteiro e filtrar com `.filter()` custa a leitura de todos os
   documentos do mesmo jeito.
2. **Uma escuta por coleção, compartilhada entre as telas.** Registro único
   de listeners, aberto pela primeira tela que precisa, reaproveitado pelas
   outras (crença 10).
3. **Persistência offline ligada.** Reabrir a mesma tela traz só o que mudou.
4. **Mês fechado vem de `fechamentos`, não da soma ao vivo.** O gráfico de
   doze meses custa doze leituras, não doze meses de vendas e custos.
5. **Nunca `getDocs` dentro de loop.** É o gatilho A11, que já apareceu neste
   projeto em 05/09 no `calcularAnaliseFunil`. Por isso `pendencias` é
   contador no documento da venda, atualizado na mesma escrita que já mexe
   nela.
6. **`get()` em vez de `onSnapshot` onde tempo real não importa.**
   Configurações, folha e a base de custos fixos mudam de vez em quando; não
   precisam de escuta contínua.
7. **Não recarregar a página em desenvolvimento com escuta de coleção
   aberta.** Testar assim consome cota de produção, e já derrubou app de
   gente trabalhando.

---

## 8. Ordem de construção

Cada etapa termina com algo que dá pra abrir no navegador e conferir.
A importação da a empresa-piloto foi movida pro fim de propósito, a pedido dele: o
sistema nasce e é testado com dado digitado à mão, e só depois recebe o
histórico.

1. **Telas em imagem.** Fase 1, as telas geradas como composição visual antes
   de qualquer código. Critério: ele aprova olhando.
2. **Esqueleto em HTML de uma tela**, a Visão Geral, sem dado real.
   Critério: abre no navegador, bate com a imagem, console limpo.
3. **Camadas.** Fundo, cards, gráfico, tipografia, uma de cada vez, com
   revisão entre elas.
4. **Firebase e regras**, com duas empresas de teste e dois usuários.
   Critério: o usuário da empresa A tenta ler a empresa B e é recusado, com
   o erro aparecendo no console.
5. **Vendas, com o modal de custos.** Critério: abrir uma venda mostra as
   quatro linhas esperadas em branco, acrescentar uma quinta funciona, ela
   reaparece sugerida na venda seguinte, digitar desconto em percentual
   preenche o valor sozinho (e vice-versa), e o lucro bruto se recalcula ao
   vivo sem salvar.
6. **Pendências.** Critério: uma venda com dois custos em branco aparece com
   duas linhas, e cada linha some no instante em que o valor entra.
7. **Custos e a base de Fixos e Folha.** Critério: cadastrar o aluguel na
   base gera a ocorrência do mês na tela de Custos, editar a ocorrência não
   mexe na base, e o filtro de unidade separa Unidade A de Unidade B.
8. **Visão Geral ligada no dado real**, com julho digitado à mão. Critério:
   lucro bruto de R$ 94.929,88 com 37,81%, lucro líquido de R$ 13.854,88 com
   5,52%, idênticos à planilha.
9. **Logo, co-branding, login e a chave da Jornada.** Critério: dois
   mentorados entram e cada um vê a própria logo e o próprio dado; desligar a
   chave tira a empresa da lista da Jornada, e a regra do Firestore recusa a
   leitura mesmo com a tela burlada.
10. **Importação da a empresa-piloto**, por último. Critério: julho bate com o que já
    foi conferido à mão na etapa 8, e cada aba importada fecha no total que
    está na própria planilha. O que não der pra mapear entra com o campo
    vazio, nunca impede a linha de ser gravada.

A planilha de julho é o gabarito. Se o sistema não fechar exatamente nela, é
o sistema que está errado.

**Sobre a importação, decisão dele:** preencher o que der e não travar a
linha por causa do que faltar. Venda sem nome de cliente entra sem nome,
kWp corrompido entra vazio, custo fixo agregado entra agregado. Dado
incompleto gravado vale mais que dado perfeito não gravado.

---

## 9. O que morde depois, e vale decidir antes

Levantado no catálogo de antecipação, com o gatilho de cada um.

| O que | Por que morde | Prevenção barata agora |
|---|---|---|
| Dado financeiro real de empresa de terceiro | Deixa de ser dado do Felipe e vira dado de cliente, com obrigação de LGPD junto | Repositório privado, regra por empresa desde o primeiro dia, e um aviso de privacidade no aceite do acesso |
| Senha inicial do mentorado | Senha padrão distribuída vira senha eterna (gatilho G3) | Senha aleatória por pessoa e troca obrigatória no primeiro acesso |
| Cota do Firestore com a turma inteira dentro | Não morde com dois testes, morde com trinta mentorados (gatilho E1) | Filtro por período em toda escuta, e fechamento mensal gravado |
| A Jornada enxergar o dado do mentorado | Ninguém pensa nisso até o primeiro mentorado perguntar | Decidir agora: acesso nenhum, acesso mediante autorização dele, ou acesso do mentor |
| Data e fuso | Já apareceu cinco vezes nos projetos (gatilho A3) | `America/Sao_Paulo` em toda gravação, e mês de competência guardado como `AAAA-MM` |
| Custo lançado num lugar sumindo do outro | O custo digitado dentro da venda não aparece na tela de custos, e o usuário acha que não salvou (crença 32) | T4 lista todo custo variável, venha de onde vier, com filtro de vinculado e avulso |
| Custo variável avulso chegar depois do mês fechado | Se ele reabrisse a margem do mês da venda, um mês já apresentado mudaria sozinho | Custo bate no mês em que foi pago, nunca no mês da venda de origem |
| Mentorado que para de lançar | O sistema fica certo e o dado fica velho, e ninguém percebe | Data do último lançamento visível no painel da Jornada |
| Importar planilha lendo coluna por posição | As abas têm de 17 a 23 colunas, e ler por posição grava kit solar no campo de vistoria sem erro nenhum | Importador lê pelo nome do cabeçalho, com conferência linha a linha contra o total da aba |

---

## 10. Situação das decisões

Tudo que travava a fase 1 está respondido. O que sobra é premissa registrada,
não pergunta em aberto.

| Tema | Onde ficou |
|---|---|
| Onde mora o sistema | Repositório e Firebase novos |
| Ramo | Todos solar; custos padrão fixos com acréscimo livre |
| Regime | Receita por competência, custo no mês pago |
| Número calculado | Sempre KPI, nunca campo digitado |
| kWh | Sai; fica só kWp |
| Desconto e comissão | Par percentual/valor, a pessoa escolhe qual digita |
| Custo fixo e folha | Base numa tela, conta na tela de Custos |
| Unidades | Campo com filtro, não empresa separada |
| Logo | base64, sem Blaze, teto de 120 KB |
| Acesso da Jornada | Chave `autorizaJornada` no controle do mentorado |
| Senha inicial | `Jornada@2026`, com troca no primeiro acesso |
| LGPD | Adiado por decisão dele |
| Escala | Um cliente agora; economia de leitura desde já (item 7) |
| Importação | Por último, depois do sistema testado à mão |
| Fase 2 | Construir e avaliar a utilidade com a tela pronta |
