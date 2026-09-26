# ADR-0005 — Um Trial válido por Person; Retrial por exceção

- **Status:** Accepted
- **Data:** 2026-09-20

## Context

Trial existe para qualificação técnica/comercial. Repetição livre cria abuso e custo sem intenção de compra.

Falhas legítimas de instalação/provider podem impedir o primeiro Trial de cumprir sua finalidade.

## Decision

Cada Person recebe um único Trial válido por padrão.

Retrial exige:

- motivo estruturado;
- vínculo com Trial original;
- evidência/approval conforme policy;
- Risk Engine quando necessário.

## Consequences

- reduz Trial abuse;
- preserva exceção legítima;
- exige Identity Resolution razoável;
- cria métricas específicas de Retrial/false positives.
