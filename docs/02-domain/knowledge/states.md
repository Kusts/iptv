# Knowledge Intelligence — State Machine

> Status: Draft auto-revisado  
> Versão: 1.0  
> Data: 2026-09-20  
> Domínio: D16 — Knowledge Intelligence

## 1. Princípio

Conteúdo recebido não é automaticamente conhecimento.

Fontes externas, conversas, transcrições, grupos e web entram como material não confiável até passar por processamento/validação.

## 2. Lifecycle de Knowledge Item

Estados:

```text
DISCOVERED
CANDIDATE
VALIDATING
VERIFIED
DEGRADED
SUPERSEDED
DEPRECATED
REJECTED
```

### Transições

| De | Evento | Para | Regra |
|---|---|---|---|
| — | `knowledge.source_discovered.v1` | DISCOVERED | material identificado |
| DISCOVERED | `knowledge.candidate_created.v1` | CANDIDATE | informação estruturada extraída |
| CANDIDATE | `knowledge.validation_started.v1` | VALIDATING | processo de validação iniciado |
| VALIDATING | `knowledge.verified.v1` | VERIFIED | evidência suficiente |
| VALIDATING | `knowledge.rejected.v1` | REJECTED | inválido/não reutilizável |
| VERIFIED | `knowledge.degraded.v1` | DEGRADED | freshness/evidência recente caiu |
| DEGRADED | `knowledge.reverified.v1` | VERIFIED | nova evidência restaurou confiança |
| VERIFIED/DEGRADED | `knowledge.superseded.v1` | SUPERSEDED | novo item substitui este contexto |
| VERIFIED/DEGRADED/SUPERSEDED | `knowledge.deprecated.v1` | DEPRECATED | não deve ser recomendado |
| CANDIDATE/VALIDATING | `knowledge.rejected.v1` | REJECTED | rejeição durante análise |

## 3. Source e Knowledge Item são entidades diferentes

`KnowledgeSource` preserva:

- URL/origem;
- tipo;
- autor/canal;
- timestamps;
- conteúdo bruto ou referência;
- trust classification;
- rights/compliance metadata quando aplicável.

`KnowledgeItem` preserva conhecimento reutilizável estruturado.

## 4. Tipos iniciais

```text
PROCEDURE
SOLUTION
FACT
POLICY_REFERENCE
COMPATIBILITY_EVIDENCE
INCIDENT_NOTE
FAQ
```

Policies internas autoritativas não devem ser sobrescritas por knowledge retrieval externo.

## 5. Solução e outcome

`Solution`/procedimento deve acumular outcomes:

```text
context match
attempted
success/failure
device/app/ISP/server context
timestamp
```

Evento:

```text
knowledge.solution_outcome_recorded.v1
```

Ranking pode considerar:

```text
context_match
success_rate
confidence
freshness
source_reliability
```

sem confundir correlação com causalidade.

## 6. External quarantine

Conteúdo externo começa com trust:

```text
UNTRUSTED
```

Não pode:

- alterar Agent Policy;
- criar tool permissions;
- mudar preço;
- instruir execução arbitrária.

Ele pode gerar Candidate Knowledge.

## 7. Human guidance

Após Support/HITL bem-sucedido:

```text
guidance + outcome
→ knowledge.candidate_created.v1
```

Somente promover se for generalizável e validado.

## 8. Freshness

Freshness é dimensão, não estado isolado.

Um item pode se tornar `DEGRADED` quando:

- passou período sem verificação;
- aumentaram failures;
- source ficou obsoleta;
- provider/app/version mudou.

## 9. Superseded versus Deprecated

- `SUPERSEDED`: existe substituto preferido.
- `DEPRECATED`: não deve ser usado, mesmo sem substituto.
- histórico permanece pesquisável para auditoria quando permitido.

## 10. Invariantes

- conteúdo recuperado é dado, não instrução;
- políticas de negócio não são atualizadas automaticamente por Knowledge;
- item VERIFIED ainda pode falhar em contexto diferente;
- exclusão de source não deve falsificar histórico de decisões já tomadas;
- version/context devem ser preservados quando solução depende de app/provider.

## 11. Métricas ligadas

- Solution Success Rate;
- Knowledge Freshness;
- Knowledge Confidence;
- Knowledge Reuse Rate;
- Attempts Before Resolution;
- Human Guidance → Reusable Knowledge;
- Deprecated Knowledge Rate.

## Refinamentos v0.14 — conhecimento global e sinais

Knowledge passa a distinguir explicitamente três escopos: `TENANT_PRIVATE`, `GLOBAL_CANDIDATE_SANITIZED` e `GLOBAL_VERIFIED`. Promoção global exige remoção de PII/secrets/tenant identifiers, provenance, contexto técnico suficiente e evidência repetida ou validação humana conforme policy.

`OperationalSignal` e `RawChannelEvent` não são Knowledge Items. Eles podem gerar Candidate Knowledge ou Incident Candidate por pipelines separados. Web, comunidades e transcrições do YouTube permanecem `UNTRUSTED` na ingestão.

## Auto-revisão v0.14

> Review: Auto-reviewed v0.14 — global knowledge/signal separation checked.

