# StreamMax — estado do MVP (2026-11-12)

## Objetivo

Consolidar o estado do MVP StreamMax sem confundir código implementado, staging, operação controlada e certificação de integrações.

## Snapshot

A divergência principal a resolver é o staging reportado em `b46cec7` versus `main` em `7e273314`. Verificar o estado real antes de promover qualquer revisão.

## Entregas e mudanças desde o fechamento operacional do MVP

- Golden Loop/UX (#128/#129).
- Correções de renewals e suporte (`b6a06a8`).
- Validação de `externalRef` (`7e273314`, issue #131).
- Segredos em PostgreSQL cifrados com AES-256-GCM (PR #123, migration 068).
- Runtime browser CINEVISION incluído na imagem da API (PR #124).
- Adapter Sigma simulado.

## Evidências

Consultar entradas correspondentes em `CHANGELOG.md` e os documentos `MVP-OPERATIONAL-CLOSURE.md`, `SIMPLIFY-01.md` e `docs/10-operations/integrations-capability-status.md`.

## Limites e pendências

- Não há certificação live de integrações.
- Sigma permanece somente simulado.
- Não há evidência end-to-end de renovação pelo browser.
- Issues #86-#89 precisam de triagem.
- Manter higiene dos arquivos Compose temporários.

## Próximo gap mínimo

Verificar a divergência entre staging e `main`, executar renovação end-to-end no browser e triar #86-#89.

> Esta edição documental não altera código, banco de dados, credenciais ou staging.
