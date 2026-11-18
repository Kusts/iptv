# Evidência S3 — integração OpenMausBot × StreamMax (18/11/2026)

## Turno sintético real do bot
- Host: contabo-prod (vmi3630510); staging em feat/streammax-v1-final-integration@8ad9e18 (código pré-S2, S2 habilitado, catálogo aplicado no tenant StreamMax).
- Bot: Atendimento WhatsApp, ID f0aad234-5706-4104-92d4-a4fd506c53e2.
- Comando: `openmausbot run --bot <id> --task new --wait turn --timeout 5m --export /tmp/s3-export-20261118 "<prompt somente leitura>"`.
- Thread: 0a12f5a3-b9d9-43b4-9776-779feab77c7f. SendId cli-7Bq3Sbn-R4X22zwX. Job completou: 1 completed, 0 failed, 0 needsInput.
- Transcript: 7 mensagens; o bot executou Bash ×2 e Read ×1; usou efetivamente a CLI real `streammax list-plans` contra a API de staging e devolveu os planos oficiais (R$ 30/75/150/300) e as telas adicionais (R$ 20/60/100/150).
- Não houve envio de mensagem externa, criação de pedido, cobrança ou ativação. Um único reply final (com digest), sem duplicação.
- Limitação observada: a resposta do bot afirmou que a carga operacional do catálogo estava pendente (mensagem do código pré-S2 implantado), embora o catálogo já esteja aplicado. Isso será resolvido quando o código S2 for implantado em staging, o que exige autorização específica.

## Cobertura das cinco jornadas (suíte de integração)
- `streammax-v1-journey.integration.test.ts`: 6/6 testes passaram em PostgreSQL isolado descartável (ver validação S2), cobrindo identidade/conversa, catálogo neutro, pedido com PIX simulado não pago, confirmação autenticada com redelivery idempotente, ativação/fulfillment manual com ticket e consistência final.
- `bot-service-api.integration.test.ts`: 9/9; `streammax-bot-wiring.integration.test.ts`: 5/5; `@iptv/outbox-worker`: 62/62.
- Esses testes são API/backend; a prova de que o OpenMausBot consome o StreamMax está no turno real acima.

## Pendências para aprovação plena do S3
- Demonstrar o bot executando, via CLI real, as demais jornadas (trial, pedido com tela, suporte, renovação) — depende do código S2 implantado em staging ou de execução em ambiente isolado equivalente.
- Confirmação explícita de `channels: []` na thread (a CLI `run` não expõe essa inspeção; nenhum envio externo foi observado).
- Nenhum deploy, cobrança, ativação ou mensagem real foi executado nesta rodada.
