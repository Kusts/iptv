# Privacy & Data Lifecycle

> Status: Draft de produto/arquitetura; requer validação jurídica antes de produção comercial  
> Versão: 1.0  
> Data: 2026-09-20

## 1. Objetivo

Definir como o produto deverá registrar finalidade, preferência, retenção, acesso, correção, exportação e eliminação/anonymization de dados pessoais sem comprometer registros financeiros/auditoria que devam ser preservados.

## 2. Princípios

- minimização;
- finalidade explícita;
- necessidade;
- transparência;
- segurança;
- retenção limitada;
- rastreabilidade de mudanças;
- separação entre marketing e mensagens transacionais.

## 3. Data Purpose Registry

Criar catálogo interno de finalidades.

Exemplos:

| purpose_key | Finalidade | Exemplos de dados |
|---|---|---|
| `service_delivery` | prestar/operar serviço contratado | identity, subscription, provider binding |
| `support` | diagnosticar e resolver problemas | conversations, device/app, solution attempts |
| `billing` | cobrar, conciliar e auditar | orders, payments, ledger refs |
| `security_abuse` | prevenir abuso/fraude | trial/referral risk signals |
| `marketing` | promoções e campanhas | preferences, segments, attribution |
| `product_analytics` | melhorar operação/produto | pseudonymous events, outcomes |
| `knowledge_improvement` | transformar resoluções em conhecimento | sanitized support outcomes |

Cada dado/processing relevante deve mapear para uma finalidade autorizada.

## 4. Communication Preferences

Separar no mínimo:

- transactional/service;
- renewal/billing reminders;
- support;
- marketing/promotions;
- news/content;
- referral/loyalty communications.

`opt-out marketing` não deve impedir mensagem operacional essencial quando legitimamente necessária para execução do serviço.

## 5. Consent / authorization evidence

Quando consentimento for a base escolhida para uma finalidade, registrar:

- purpose;
- version;
- timestamp;
- source/channel;
- evidence;
- revoked_at.

Não usar um checkbox genérico como autorização universal para finalidades diferentes.

## 6. Data Subject Request workflow

Estados conceituais:

```text
REQUESTED
↓
IDENTITY_VERIFICATION
↓
SCOPING
↓
IN_PROGRESS
↓
COMPLETED | PARTIALLY_COMPLETED | REJECTED_WITH_REASON
```

Tipos:

- access;
- correction;
- portability/export quando aplicável;
- deletion/anonymization;
- communication preference change;
- review/escalation sobre decisão automatizada quando aplicável.

## 7. Delete versus anonymize

Nem toda solicitação deve resultar em `DELETE FROM` indiscriminado.

Estratégia:

- remover dados que não precisam mais existir;
- anonimizar/pseudonimizar histórico quando possível;
- preservar registros que precisem permanecer por obrigação legítima/financeira/auditoria, com acesso restrito;
- nunca quebrar integridade de ledger para “apagar” histórico econômico.

## 8. Retention Schedule — framework

Valores finais serão aprovados antes de produção. Categorias iniciais:

| Categoria | Retention principle |
|---|---|
| Active customer operational data | enquanto relação ativa + período necessário pós-relação |
| Lead não convertido | janela limitada configurável |
| Raw message/media | menor que histórico estruturado quando possível |
| Browser traces | curta, principalmente em sucesso; maior apenas para incident/debug justificado |
| Financial ledger | prazo definido com contabilidade/jurídico |
| Security audit | período suficiente para investigação/compliance |
| Knowledge verified | enquanto válido, sem PII desnecessária |
| Untrusted raw knowledge source | expirar se não promovido/necessário |
| Trial abuse signals | janela proporcional ao risco e finalidade |

## 9. Knowledge sanitization

Antes de promover uma solução de conversa real para conhecimento compartilhado:

- remover nome/telefone;
- remover credentials;
- remover IDs de cliente;
- retirar detalhes não necessários;
- manter contexto técnico útil;
- preservar provenance interna sem expor PII aos demais tenants.

Conhecimento entre tenants não é compartilhado automaticamente.

## 10. Automated decisions

Para decisões de impacto relevante, guardar:

- policy version;
- inputs principais;
- outcome;
- reason codes;
- actor/model release quando aplicável;
- caminho de review/HITL.

Exemplos:

- trial denied por abuse;
- reward rejected;
- high-risk action blocked.

## 11. Tenant responsibilities

No SaaS futuro, documentação e contratos deverão deixar claro:

- quais configurações cabem ao tenant;
- quais dados o tenant decide coletar;
- quais políticas são da plataforma;
- limites de uso de mensagens/marketing;
- como requests de titulares são roteadas.

## 12. Auto-revisão aplicada

Revisado para:

- não prometer base legal específica sem análise jurídica;
- preservar integridade financeira;
- separar consentimento por finalidade;
- incluir conhecimento e AI como processamento de dados;
- tratar retention como policy versionada, não hardcode.
