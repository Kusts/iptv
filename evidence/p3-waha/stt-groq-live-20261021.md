# STT-Groq live PASS — PTT transcrito em pt no pilot (2026-10-21)

- TASK_ID: TRANSCRICAO-GROQ-20261021 (+ FIX 063 + FIX-REVIEW) · lane pilot (`iptv-pilot-api` imagem `d597df0`, migration 063 aplicada: `applied=1 skipped=62`)
- Chave: primeira das 3 `GROQ_API_KEYS` do telegran (todas http 200 em `/models`), salva como `GROQ_API_KEY` nos dois envs (gitignored, 56 chars)
- Scheduler: pilot roda com tick desligado por padrão; ligado temporariamente (`API_SCHEDULER_ENABLED=1`, outbox 19/19 PUBLISHED + inbox pendente 0 → sem efeito colateral), removido e recriado após a prova (`scheduler is disabled`, ready 200, edge 200)
- Prova: PTT → `message_transcripts` = par CLAIMED→TRANSCRIBED (`groq/whisper-large-v3-turbo`, texto pt, ex. "Olá, bom dia!"); backlog das 2 provas de mídia anteriores (16:06, 16:28) transcrito no primeiro tick sem duplicar (1 par por mensagem, attempts=1)
- Modelo final: tabela append-only `platform.message_transcripts` (063 + prova 030, 10 NOTICEs + ROLLBACK); `messages` segue intocável (trigger 009); elegibilidade SQL antes do LIMIT; re-claim de CLAIMED órfão após 30min com fence por attempt; erros sanitizados por code
- Review: 4 findings corrigidos e revalidados (tester PASS 6/6 integração + 60/60 units); reviewer indisponível (cota da assinatura) → verificação direta do Planner (030 exit 0 + 4 pontos conferidos no código + 3 gates Python OK)
- Limites: `evaluateInbound` pós-transcrição é best-effort; reaper dedicado de CLAIMED órfão segue opcional; outbound de mídia segue test-only
