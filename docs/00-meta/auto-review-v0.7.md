# Auto-review — v0.7

> Data: 2026-09-20  
> Escopo: SPECs Support/HITL/Knowledge + Referral Core, migrations Platform/Identity/Trial, contratos e documentação canônica afetada.

## 1. Resultado

Status final: **PASS estático/documental**.

A revisão combinou:

- releitura semântica de cada arquivo novo/alterado;
- comparação cruzada com state machines/Event Model/Logical Data Model;
- validação automatizada por `scripts/validate_docs.py`;
- revisão manual das constraints tenant-aware e das regras de Trial.

## 2. Arquivos principais revisados

### Novos

- `docs/04-specs/07-support-hitl-knowledge/SPEC.md`;
- `docs/04-specs/08-referral-core/SPEC.md`;
- `docs/03-architecture/migrations/mvp-bootstrap-v0.7.md`;
- `db/migrations/202609201530_001_platform.sql`;
- `db/migrations/202609201531_002_identity_crm.sql`;
- `db/migrations/202609201532_003_trial.sql`;
- `db/migrations/README.md`;
- `docs/00-meta/review-process.md`;
- `scripts/validate_docs.py`.

### Atualizados

- `README.md`;
- `CHANGELOG.md`;
- `docs/04-specs/README.md`;
- `docs/04-specs/02-trial/SPEC.md`;
- `docs/03-architecture/logical-data-model.md`;
- `docs/03-architecture/physical-database-schema.md`;
- `docs/03-architecture/README.md`;
- `docs/05-contracts/openapi/openapi.yaml`.

## 3. Findings corrigidos

### F-01 — FK de risco poderia ser cross-tenant

Primeiro rascunho do Trial ligava `risk_assessment_id` apenas pelo UUID.

Correção:

```text
(tenant_id, risk_assessment_id)
→ security.risk_assessments(tenant_id, id)
```

A tabela de risk assessments ganhou `UNIQUE (tenant_id, id)` para suportar a FK composta.

### F-02 — regra de “Trial válido” era difícil de representar fisicamente

Refinamento:

```text
TRIAL   = primeira oportunidade gratuita
RETRIAL = exceção justificada posterior
```

Agora o banco impõe um único `TRIAL` primário por Person, enquanto Domain/Risk/Policy decide se um `RETRIAL` é legítimo.

### F-03 — corrida poderia abrir dois acessos gratuitos

Adicionado índice único parcial para impedir mais de um Trial em:

```text
REQUESTED / PROVISIONING / ACTIVE
```

por Person/tenant.

### F-04 — Support e HITL poderiam ficar semanticamente acoplados

A nova SPEC explicita:

- Ticket `WAITING_INTERNAL` não transfere automaticamente ConversationControl;
- HumanReview é lifecycle separado;
- takeover humano é decisão explícita.

### F-05 — knowledge poderia ser promovido cedo demais

A nova SPEC define:

```text
human guidance + successful outcome
→ Candidate Knowledge
≠ VERIFIED automaticamente
```

External content permanece quarantined/untrusted até validação.

### F-06 — referral poderia corromper attribution

A SPEC de Referral diferencia:

- first/primary acquisition attribution;
- referral touch/assist;
- referral qualification.

Referral tardio não sobrescreve automaticamente a origem histórica.

### F-07 — reward de conexão extra precisava manter custo futuro

Foi reforçado que conexão/tela adicional como Reward possui:

```text
recurring benefit
+
recurring provider COGS
```

em cada ciclo concedido.

### F-08 — schemas OpenAPI de Support/HITL/Referral estavam permissivos demais

Os estados agora usam enums alinhados às state machines canônicas.

## 4. Checks automatizados

Após a criação deste relatório, `scripts/validate_docs.py` deve verificar:

- links Markdown internos;
- eventos usados pelas SPECs contra Event Model;
- YAML OpenAPI/AsyncAPI;
- `$ref` locais OpenAPI;
- eventos do AsyncAPI contra Event Model;
- estrutura estática básica das migrations SQL.

Na revisão anterior à criação deste arquivo:

- 0 eventos ausentes nas novas SPECs;
- 90 OpenAPI `$ref` resolvidas;
- 18 eventos AsyncAPI presentes no Event Model;
- 3 migrations com parênteses balanceados e `BEGIN/COMMIT`;
- estados de Lead/Customer/Trial presentes e alinhados.

## 5. Limitação explícita

As migrations foram revisadas e validadas **estaticamente**, mas não executadas contra um servidor PostgreSQL nesta rodada porque não há runtime PostgreSQL disponível no ambiente atual.

Portanto o gate para considerar DDL pronto para merge de implementação continua sendo:

```text
PostgreSQL real em CI
+ apply from empty DB
+ integration tests
+ concurrency tests
+ tenant-isolation tests
```

Não deve ser declarado “migration runtime tested” antes disso.

## 6. Regressões prioritárias verificadas

- [x] uma Person possui um Trial primário; exceções são RETRIAL;
- [x] PASSED é technical outcome, não Trial lifecycle;
- [x] Order SETTLED não é sinônimo de Payment PAID;
- [x] conexão adicional continua recorrente em receita e COGS;
- [x] provider não virou fonte da verdade;
- [x] retry/replay não autoriza efeito duplicado;
- [x] external knowledge não altera Policy;
- [x] Referral CONFIRMED não significa clique/cadastro;
- [x] reward arbitrário pelo LLM continua proibido;
- [x] relações críticas novas foram revisadas para tenant isolation.

## 7. Próximo gate

Antes da implementação do Slice 0/1:

1. executar estas migrations em PostgreSQL real;
2. criar testes de corrida Identity/Trial;
3. criar migrations Commerce/Billing/Ledger;
4. atualizar OpenAPI com endpoints adicionais estabilizados nas SPECs 07/08;
5. criar fixtures e eval dataset inicial de Support/Referral.
