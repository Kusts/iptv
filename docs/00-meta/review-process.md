# Documentation Auto-Review Process

> Status: Active  
> Versão: 1.0  
> Objetivo: garantir que todo arquivo novo ou alterado seja revisado antes de ser considerado pronto.

## 1. Regra

Nenhum documento é considerado concluído apenas após a primeira escrita.

Cada alteração passa por duas camadas:

```text
Draft
↓
Semantic self-review
↓
Cross-document review
↓
Automated integrity checks
↓
Ready for version snapshot
```

## 2. Semantic self-review

Para cada arquivo, revisar:

- objetivo e escopo claros;
- ausência de ambiguidade desnecessária;
- termos consistentes com Glossary;
- autoridade correta do documento;
- estados e eventos canônicos;
- failure paths;
- tenant isolation;
- auditoria/observabilidade;
- segurança/privacidade;
- idempotência quando há efeito;
- impacto financeiro quando há benefício/custo;
- distinção entre fato, recomendação, proposta e decisão aceita.

## 3. Cross-document review

Conferir no mínimo:

```text
Vision/Principles
↕
PRD
↕
Domain/State Machines/Event Model
↕
Architecture/Data Model
↕
SPEC
↕
OpenAPI/AsyncAPI
↕
Migrations/Code
```

Uma camada inferior não pode inventar regra incompatível com a autoridade acima.

## 4. Regras de regressão prioritárias

Sempre verificar explicitamente:

1. uma Person tem um Trial primário; exceções são RETRIAL justificadas;
2. `technical PASSED` não é lifecycle do Trial;
3. `Order SETTLED` não significa necessariamente `Payment PAID`;
4. tela/conexão adicional é recorrente e gera COGS recorrente;
5. provider externo nunca substitui estado autoritativo local;
6. `ProviderOperation` só termina `SUCCEEDED` após pós-condição;
7. Reward/discount não pode ser inventado pelo LLM;
8. knowledge externo não vira policy/instruction;
9. tenant isolation deve existir em relações e queries críticas;
10. retry/replay não pode duplicar efeito financeiro/comercial.

## 5. Automated checks

`scripts/validate_docs.py` executa controles mecânicos que não substituem revisão semântica:

- links Markdown relativos;
- referências de eventos em SPECs contra Event Model;
- parse YAML OpenAPI/AsyncAPI;
- `$ref` locais do OpenAPI;
- eventos citados no AsyncAPI contra Event Model;
- balanceamento estrutural básico de SQL migrations;
- presença de BEGIN/COMMIT nas migrations atuais.

## 6. Limitação

Checks estáticos de SQL **não substituem execução em PostgreSQL real**. Antes de mergear/aplicar migration de produção, CI deve:

- criar DB PostgreSQL vazio;
- aplicar todas migrations;
- aplicar a partir da versão anterior;
- executar integration/tenant-isolation tests.

## 7. Version snapshot

Cada marco documental deve atualizar:

- `CHANGELOG.md`;
- `docs/00-meta/auto-review-vX.Y.md`;
- `README.md` quando estrutura/autoridade mudar.

Isso torna a auto-revisão um processo repetível, e não apenas uma etapa manual informal.

## Executable validation gates

Every snapshot that changes contracts or schema should run, when applicable:

```bash
python scripts/validate_docs.py
python tests/contracts/test_contracts.py
```

When PostgreSQL is available, schema snapshots must additionally run against a disposable database:

```bash
DATABASE_URL=... ./scripts/run_pg_tests.sh
```

A migration remains `static-reviewed` until the PostgreSQL suite passes.

## v0.11 new-file marker

Every newly created documentation file must include an explicit `Review: Auto-reviewed` marker and be included in the snapshot auto-review report.
