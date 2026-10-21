# M1-media pós-rotação WAHA_API_KEY — PASS (2026-10-21)

- Rotação: nova `WAHA_API_KEY` 64-hex via arquivo (`scp`, nunca em comando/log); `sed` substituído por `grep -v` + `printf` (imune a `\r`); backup `.env.bak-ROTATE-20261021` mantido no host como rollback; chave transitória destruída (`shred -u`); script remoto removido.
- Host: container `waha` recriado (`--force-recreate`); self-test: nova chave → 200, chave inválida → 401, sessão `ted` WORKING.
- Consumidores locais atualizados a partir do mesmo arquivo (linhas com 64 chars): `.env` + `deploy/staging/.env.pilot` (ambos gitignored, nenhum valor no repo); `iptv-pilot-api` recriado com fail-closed `DATABASE_URL=""`/`POSTGRES_PASSWORD=""`; ready 200 local + edge 200.
- Prova live: 2 webhooks `POST /v1/webhooks/waha/synkroo-iptv` → 202; `communication.messages` = 2 rows INBOUND (`AUDIO` + `IMAGE`, refs `in-*`, conversa OPEN); `platform.inbound_attachments` 2 → 4 rows; zero exceção nova (últimas seguem as antigas de 15:59).
- Limites: transcrição segue `PENDING_FOLLOW_UP`; outbound de mídia segue test-only; backup do host não apagar sem aval.
