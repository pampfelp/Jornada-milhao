# Plano — Painel Financeiro + Gerador de Contrato + Funil Unificado

> Documento de planejamento a partir do áudio/mensagens de 30/07/2026. Objetivo: sair do
> controle solto (planilhas/tabelas soltas) para um sistema onde **um único funil**
> (agendamento → vendas → administrativo) alimenta automaticamente o financeiro.

---

## 1. Visão geral do fluxo

```
Google Agenda (agendamentos/reagendamentos)
        │  (todo evento entra automaticamente)
        ▼
FUNIL DE AGENDAMENTO  ──── topo do ────▶  FUNIL DE VENDAS
                                                │
                                     venda fechada = gera contrato
                                                │
                                                ▼
                                     FUNIL ADMINISTRATIVO
                                     (pós-venda: prazos, grupo,
                                      recebimento, execução)
                                                │
                                                ▼
                                     PAINEL FINANCEIRO
                                     (faturamento, caixa, lucro)
```

**Regra central:** o fim de um funil é o início do próximo. Não existem mais tabelas
soltas — as tabelas que hoje existem separadas (AppSheet, planilhas de clientes, etc.)
passam a ser **tabelas auxiliares**, referenciadas pelo funil, mas não fontes primárias
de verdade.

---

## 2. Painel Financeiro

### 2.1 Definições de cada métrica

| Métrica | Definição | Origem do dado |
|---|---|---|
| **Faturamento do período** | Soma do **valor total vendido** no mês (todos os contratos fechados no período), independente de estar parcelado ou não. | Contratos gerados no período (campo `valor_total`) |
| **Fluxo de caixa esperado** | Soma de todas as parcelas com vencimento **dentro do período**, de contratos ativos (passados ou presentes), que ainda não foram pagas. | Parcelas com `status = esperado` e `vencimento` no mês |
| **Fluxo de caixa realizado** | Soma de todas as parcelas efetivamente **pagas** no período, independente de quando venceram. | Parcelas com `status = realizado` e `data_pagamento` no mês |
| **Despesas do mês** | Custos operacionais do período: tráfego pago, folha de funcionários, ferramentas, etc. | Lançamentos manuais de despesa |
| **Lucro operacional do período** | `Fluxo de caixa realizado − Despesas do mês` | Calculado |
| **Outros custos** | Impostos e custos que não são "despesa operacional" direta (ex. tributos, taxas). | Lançamentos manuais |
| **Saldo estimado** | `Lucro operacional do período − Outros custos`. Considera **apenas o que está dentro do "bolso" da empresa** — não é necessariamente igual ao saldo da conta bancária (pode haver dinheiro em trânsito, reservas, etc.) | Calculado |

### 2.2 Regras de negócio — parcelas

1. Toda vez que um **contrato é gerado**, o sistema cria automaticamente as parcelas
   esperadas vinculadas ao cliente (uma linha por parcela, com valor e data de
   vencimento).
2. Cada parcela nasce com `status = esperado`.
3. Quando a parcela é **paga**, o status muda para `realizado` e passa a contar no
   fluxo de caixa realizado do mês em que foi paga (não necessariamente o mês em que
   venceu).
4. Parcela **vencida e não paga** (data de vencimento < hoje e `status = esperado`)
   fica sinalizada para cobrança.
   - **Fase 1 (agora):** cobrança manual — o sistema apenas destaca/lista essas
     parcelas para alguém entrar em contato.
   - **Fase 2 (futuro):** cobrança automática (WhatsApp/e-mail/mensagem programada).
5. Faturamento **não é igual a** caixa: o painel precisa deixar visualmente claro que
   "faturamento do período" é a venda fechada, e "fluxo de caixa" é o dinheiro que
   efetivamente entra, mês a mês, conforme as parcelas vencem/pagam.

### 2.3 Perguntas em aberto

- [ ] Despesas e "outros custos" (impostos) entram por lançamento manual mês a mês, ou
      alguma parte é recorrente/automática (ex. folha fixa todo mês)?
- [ ] "Saldo estimado" deve acumular de mês pra mês (saldo acumulado) ou é sempre o
      saldo daquele período isolado?
- [ ] Existe necessidade de projeção futura (ex. ver o fluxo de caixa esperado dos
      próximos 3 meses, não só do mês corrente)?

---

## 3. Gerador de Contrato integrado ao CRM

### 3.1 Objetivo
Gerar o contrato **rápido, durante a própria reunião**, com o mínimo de campos
possível — e, ao gerar, o sistema já cria automaticamente as parcelas esperadas no
financeiro.

### 3.2 Campos mínimos do formulário
- Cliente (vinculado ao card do funil de vendas)
- Valor total da venda
- Forma de pagamento:
  - À vista, **ou**
  - Entrada + parcelas (valor da entrada + quantidade de parcelas + valor de cada
    parcela, calculado automaticamente a partir do total)
- Datas de vencimento das parcelas (sugestão automática: todo dia X de cada mês, com
  opção de ajuste manual)

### 3.3 O que acontece automaticamente ao gerar o contrato
1. Documento de contrato é gerado (PDF/link) a partir de um modelo.
2. Parcelas esperadas são criadas no módulo financeiro (ver seção 2.2).
3. O card do cliente **sai do funil de vendas e entra no funil administrativo**
   (ver seção 4).

### 3.4 Perguntas em aberto

- [ ] O contrato precisa de assinatura eletrônica (ex. integração com alguma
      plataforma de assinatura) ou só geração do documento?
- [ ] Existe um modelo único de contrato ou varia por tipo de serviço/produto?

---

## 4. Funil Unificado (Agendamento → Vendas → Administrativo)

### 4.1 Estrutura

**a) Funil de Agendamento**
- Alimentado diretamente pela agenda do Google (agendamentos feitos pelo Henry e
  reagendamentos).
- Todo evento da agenda vira automaticamente um card nesse funil — com data e dados do
  cliente já preenchidos.
- Serve para controle de comparecimento e remarketing de quem não fechou.

**b) Funil de Vendas**
- O **topo** do funil de vendas é alimentado pelo **fim** do funil de agendamento
  (reunião realizada → vira oportunidade de venda).
- Etapas internas de venda (proposta, negociação, fechamento) ficam a critério do
  processo comercial existente.
- O **fim** do funil de vendas é a venda fechada → dispara o gerador de contrato.

**c) Funil Administrativo**
- O **topo** do funil administrativo é o **fim** do funil de vendas (contrato
  gerado).
- Cada etapa tem um **prazo associado**, específico por cliente. Exemplos de etapas
  citadas:
  - Prazo para recebimento (entrada/parcelas)
  - Criação de grupo (comunicação com o cliente/execução)
  - Outras etapas operacionais de entrega/execução do serviço
- O sistema deve permitir cadastrar quais são as etapas do funil administrativo e o
  prazo padrão de cada uma (com ajuste por cliente, se necessário).

### 4.2 Tabelas auxiliares
Tudo que hoje é tabela solta (ex. planilha de clientes do AppSheet, controles
paralelos) passa a existir **como apoio/consulta**, mas o funil é quem manda —
ou seja, elas deixam de ser atualizadas manualmente em paralelo e passam a refletir
(ou ser alimentadas por) o funil.

### 4.3 Perguntas em aberto

- [ ] Quais são, hoje, **todas** as etapas do funil administrativo (lista completa) e
      o prazo padrão de cada uma?
- [ ] Reagendamento: se o cliente reagenda depois de já estar no funil de vendas, ele
      volta para o funil de agendamento ou fica registrado só como um novo evento
      vinculado ao mesmo card?
- [ ] Quem são os responsáveis por mover o card entre as etapas (é manual, feito pelo
      vendedor/admin, ou existe alguma automação por gatilho, ex. "pagamento
      confirmado" move automaticamente)?

---

## 5. Modelo de dados (rascunho inicial)

| Entidade | Campos principais |
|---|---|
| `Cliente` | id, nome, contato, origem |
| `Agendamento` | id, cliente_id, data, status (agendado/realizado/reagendado/no-show) |
| `Oportunidade (Funil de Vendas)` | id, cliente_id, agendamento_id, etapa, valor_proposto |
| `Contrato` | id, oportunidade_id, valor_total, forma_pagamento, data_geração |
| `Parcela` | id, contrato_id, valor, vencimento, status (esperado/realizado/vencido), data_pagamento |
| `Despesa` | id, categoria, valor, data, periodo_referencia |
| `EtapaAdministrativa` | id, contrato_id, nome_etapa, prazo, status, responsável |

> Isso é um ponto de partida — ajusta comigo depois que as perguntas em aberto forem
> respondidas, antes de eu montar o schema definitivo no padrão de planilha/Sheets ou
> Firestore.

---

## 6. Próximos passos sugeridos

1. Responder as perguntas em aberto das seções 2.3, 3.4 e 4.3.
2. Definir stack de implementação (padrão planilha/Apps Script atual ou migração para
   Firebase — dado o volume de funil + financeiro em tempo real, vale avaliar).
3. Priorizar o que entra primeiro: funil unificado (base de tudo) → gerador de
   contrato → painel financeiro (que depende dos dois anteriores para ter dado real).
4. Prototipar o painel financeiro com dado fake pra validar a leitura das métricas
   antes de conectar tudo.
