# Ponte PicPay do Fast Start

Publicada na Cloudflare em 28/10/2026; aguarda configuração do segredo e
validação contra a PicPay. O log do Apps Script confirmou que a tentativa de trocar o
User-Agent não funciona: o Google substitui o header e a criação retorna 403.

A ponte encaminha somente criação de link, consulta de transações e
inativação à origem fixa da PicPay. Exige segredo próprio e token PicPay;
não aceita destino arbitrário, não oferece CORS nem registra credenciais.
O client_secret permanece nas Script Properties. Sandbox e OAuth continuam
diretos. A aceitação da requisição pela PicPay precisa ser testada após publicar.

## Publicar

1. Na conta Cloudflare correta, criar um Worker `jornada-fast-start-picpay`
   e publicar o conteúdo de `worker.mjs`. Pela CLI autenticada, nesta pasta:
   `npx wrangler deploy`.
2. Configurar um segredo longo e aleatório com nome `BRIDGE_KEY` no Worker
   (CLI: `npx wrangler secret put BRIDGE_KEY`). Não usar a chave PicPay nem
   chave de site/Turnstile. Não registrar o valor em código, relatório ou chat.
3. Nas Script Properties do Apps Script existente, configurar:
   - `PICPAY_PROXY_URL`: raiz HTTPS do Worker, sem caminho ou parâmetros.
   - `PICPAY_PROXY_SECRET`: o mesmo valor do segredo `BRIDGE_KEY`.
   Preservar as credenciais PicPay e o ambiente atual.
4. Atualizar `Code.gs` com a versão que suporta essas propriedades. Executar
   `testarPicPay`: deve indicar transporte `ponte`, criação 201 e inativação
   200. Ele cria um link real de R$ 1,00 e tenta desativar; não efetua pagamento.
   Se a inativação falhar, desativar o link no painel antes de encerrar o teste.
5. Publicar Nova versão na implantação existente do Apps Script e testar a
   etapa 4 no checkout. Confirmar QR/copia e cola reais e abertura do cartão.
   Pagamento, retorno, confirmação e tarefa única ainda precisam de validação real.

Sem as duas propriedades, o código mantém o transporte direto anterior;
isso não resolve o bloqueio atual. Se só uma for configurada, a integração
recusa a configuração incompleta. Remover ambas reverte o transporte.

## Conferência local

`node verificar.mjs` testa autenticação, destinos/métodos restritos, transporte
e erros com fetch simulado. `node verificar-pix.mjs` confere os estados Pix,
cópia, validação, retentativa e consulta. Nenhum chama a PicPay ou cria cobranças.

Referências: [Cloudflare Workers](https://developers.cloudflare.com/workers/runtime-apis/handlers/fetch/),
[segredos](https://developers.cloudflare.com/workers/configuration/secrets/).
