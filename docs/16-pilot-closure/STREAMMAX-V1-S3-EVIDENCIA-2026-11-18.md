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

## Rodada 2 — staging com código S2 (deploy autorizado)
- Deploy controlado em 18/11: HEAD 5a5913d, tags rollback-pre-s2 para api/web/migrate, migrate applied=0 skipped=70, smoke 200, rota bot 401 sem credencial, roles/secret_values inalterados (26/7), untracked preservados.
- Turno bot (thread 7542f538-76dc-4786-82de-6fd1c89fc9c8, sendId cli-kfNHsK0LhnF3jjri): bot consultou `get-trial` da pessoa sintética 01a1ebf5-436f-73bb-8fea-bbfda38f37f0 → elegível `FIRST_PRIMARY_TRIAL`, 6h, 1 uso; consultou `quote` de Mensal + 1 tela (1 mês) → R$ 50,00, quoteId 01a1ec5d-6b2f-722d-8b4f-0c04f8126a2f, early:false. Nenhuma mensagem externa, cobrança ou ativação.
- Turno bot (thread bb580827-335a-4220-ba96-f6a88b977153, sendId cli-jl-9mHr9eFmWJIQF): `open-ticket` TECHNICAL criou ticket 01a1ec5d-f1c8-7739-b427-625c2c9ca877; `get-ticket` confirmou status NEW, prioridade NORMAL, categoria bot:TECHNICAL; `get-subscription` retornou subscription:null; `renewal-quote` retornou 404 not_found (pessoa sem assinatura), sem valor informado, sem renovação confirmada. Nenhuma mensagem externa, cobrança ou ativação.
- Defeito encontrado e corrigido: a CLI traduzia todo 404 como "Endpoint StreamMax não encontrado"; agora exibe o código de domínio (`HTTP 404 not_found`). CLI atualizada no host, 10/10 testes locais passaram. Isso evita que o bot interprete erro de domínio como rota inexistente.
- Limitação remanescente: pagamento/ativação simulados não foram executados pelo bot porque isso criaria cobrança real (mesmo Sandbox), fora do escopo; a cobertura vem dos testes de integração (`streammax-v1-journey` 6/6). Renovação com ordem liquidada também não foi executada pelo bot (a pessoa sintética não tem assinatura); o fluxo é coberto por renewal-quote/renew com testes unitários e de integração.

## Pendências para aprovação plena do S3
- Demonstrar o bot executando, via CLI real, pagamento/ativação e renovação com ordem liquidada em ambiente isolado equivalente e autorizado.
- Confirmação explícita de `channels: []` na thread (a CLI `run` não expõe essa inspeção; nenhum envio externo foi observado).
- Nenhuma cobrança, ativação ou mensagem real foi executada nesta rodada. O deploy de código S2 em staging ocorreu conforme registrado acima.
