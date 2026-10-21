# M1-media live PASS — inbound áudio+imagem com attachment persistido (2026-10-21)

- TASK_ID: M1-MEDIA-LIVE-20261021 · lane pilot (`iptv-pilot-api` imagem nova do main, `WAHA_SESSION=ted`, canal `synkroo-iptv` ACTIVE, segredo webhook rotacionado)
- Sessão WAHA `ted` WORKING (engine NOWEB, Contabo); remetente com identidade WHATSAPP LID (`…125842558599202`, UNVERIFIED) + conversa OPEN pré-aberta
- Webhooks `POST /v1/webhooks/waha/synkroo-iptv` → **202** (2×, ~14s cada com download real), inbox `waha.raw` PROCESSED
- Resultado: `communication.messages` = 2 rows INBOUND (`IMAGE`, `AUDIO`), `attachment_ref` `in-*` preenchida, conversa OPEN; `platform.inbound_attachments` = 2 rows (bytes validados e persistidos tenant-scoped); zero exceção nova
- Download via base pública WAHA + `X-Api-Key` (código do main); localhost recusado pelo fail-closed nas tentativas anteriores (evidência do caminho negativo no mesmo ciclo)
- Cobertura: M1-media (inbound mídia→attachment→mensagem) PASS ao vivo; outbound de mídia segue test-only (sem envio live neste ciclo)

## Limites desta prova
- Transcrição segue `PENDING_FOLLOW_UP` (sem pipeline)
- Multi-sessão, reconnect profundo, restriction/timelock: fora do escopo (nunca provocar)
- Segredos (WAHA_API_KEY nova, webhook secret) viveram só em-processo/host; nenhum valor neste arquivo ou no repo
- Customer de teste + identities LID/phone permanecem no pilot como resíduo de prova
