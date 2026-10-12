# Vault smoke — 2026-10-12 (somente presença/metadata, nenhum valor lido)

- Infisical API identity: login OK (sem 401/403).
- Infisical Browser identity: login OK.
- `TEST_SECRET`: ausente. `CINEVISION_URL` em `dev`/`development` (path `/`): ausente.
- Listagem de nomes em `dev` e `prod` (paths `/` e `/browser-worker/`): **vazia**.
- Conclusão: cofre acessível, identidades válidas, mas **nenhuma credencial
  CINEVISION/MK armazenada** — Steps 3/6–9 travados até o operador provisionar
  `environment/path/key` e informar os caminhos para o smoke de presença.
