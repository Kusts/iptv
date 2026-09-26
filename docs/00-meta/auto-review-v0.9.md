# Auto-review — v0.9

> Data: 2026-09-20  
> Escopo: migrations 009–011, executable contract tests, PostgreSQL integration-test harness, documentation links and lifecycle consistency.

## Resultado

A revisão v0.9 foi concluída sem inconsistências estáticas remanescentes.

Snapshot revisado:

- 100 arquivos Markdown;
- 15 arquivos SQL, sendo 11 migrations + 4 integration tests;
- 2 arquivos Python;
- 149 links Markdown verificados pelo validador.

## Validações executadas

### Documentação e contratos

- links internos relativos;
- eventos usados pelas SPECs contra o Event Model;
- parsing dos contratos OpenAPI/AsyncAPI;
- resolução dos `$ref` locais do OpenAPI;
- eventos AsyncAPI contra o Event Model.

### Schema

- ordem crescente das migrations;
- `BEGIN/COMMIT` em todas as migrations;
- balanceamento estrutural básico de SQL;
- alvos de FKs presentes no conjunto de migrations;
- lifecycle constraints canônicas;
- invariantes físicos críticos do MVP.

### Executable contract tests

`tests/contracts/test_contracts.py` passou integralmente e verifica:

- OpenAPI lifecycle enums = PostgreSQL CHECK constraints para Trial, Order, Payment, Subscription, ProviderOperation, SupportTicket, HumanReview e Referral;
- AsyncAPI events pertencem ao Event Model;
- presença dos invariantes físicos que não podem regredir.

## Findings encontrados e corrigidos nesta rodada

### 1. Index predicate inválido para suppressions

O primeiro rascunho tentava usar `now()` em predicate de partial index de communication suppressions. Isso não é apropriado para um index predicate estável/imutável.

Correção:

- removido o predicate temporal;
- substituído por índice de lookup contendo `starts_at` e `ends_at`.

### 2. HumanReview cross-tenant assignment

O primeiro rascunho validava `assigned_to_user_id` apenas contra `control.users`, o que permitiria referenciar um usuário global sem comprovar membership no tenant.

Correção:

- assignee usa FK composta `(tenant_id, assigned_to_user_id)` → `control.tenant_memberships (tenant_id, user_id)`;
- HumanReview actions aplicam a mesma regra ao ator humano.

### 3. Self-referral determinístico

Referral já passava pelo Risk Engine, mas self-referral exato é uma condição determinística que não precisa depender de LLM ou scoring.

Correção:

- trigger bloqueia Referral ativo quando `advocate_customer.person_id == referred_person_id`;
- estados históricos/negativos (`REJECTED`, `EXPIRED`, `REVERSED`) continuam podendo representar o fato para auditoria quando necessário.

### 4. Testes SQL com possibilidade de falso positivo

Dois testes iniciais capturavam a mesma exceção gerada pela própria asserção do teste, podendo passar mesmo se o trigger esperado não tivesse ocorrido.

Correção:

- introduzidas flags explícitas de `*_blocked`;
- a asserção final é executada fora do bloco de captura da exceção esperada.

### 5. Conversation close semantics

O primeiro rascunho permitia `CLOSED/ARCHIVED` sem `closed_at`.

Correção:

- `OPEN` exige `closed_at IS NULL`;
- `CLOSED/ARCHIVED` exigem `closed_at IS NOT NULL`.

## Invariantes revalidados

- uma Person possui no máximo um Trial primário;
- Retrial exige Trial anterior + razão;
- uma Person não possui duas janelas gratuitas abertas em paralelo;
- Order `SETTLED` permanece independente de Payment `PAID`;
- conexão/tela adicional continua obrigatoriamente recorrente;
- receita e provider COGS da conexão adicional continuam registrados por ciclo;
- ProviderOperation usa `SUCCEEDED` somente no lifecycle canônico;
- Financial Ledger, provider-credit ledger e Reward Ledger são append-only;
- Message, ConversationControlEvent, KnowledgeVersion, SolutionOutcome e HumanReviewAction preservam histórico append-only;
- Referral `CONFIRMED` permanece distinto de invite/click/Trial;
- active self-referral exato é bloqueado;
- tenant-owned relações críticas usam FKs tenant-aware.

## Runtime status

O ambiente atual não possui PostgreSQL/`psql`, Docker ou Podman. Portanto:

- static review: **PASS**;
- executable Python contract tests: **PASS**;
- PostgreSQL integration tests: **READY / NOT EXECUTED**.

A v0.9 continua classificada como `static-reviewed` até `scripts/run_pg_tests.sh` passar em PostgreSQL real.

## Próximo gate recomendado

1. aplicar migrations 001–011 em banco PostgreSQL descartável;
2. executar `db/tests/*.sql`;
3. ampliar OpenAPI/AsyncAPI para todas as operações de Support/HITL/Knowledge/Referral/Rewards;
4. criar seed/fixtures do tenant piloto;
5. selecionar as Stories do primeiro sprint e detalhar Tasks/acceptance tests somente para elas.
