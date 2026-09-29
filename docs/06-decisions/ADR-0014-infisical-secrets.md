# ADR-0014 — Infisical for Production Secrets

- Status: Accepted
> Review: Auto-reviewed v0.13 — rechecked against stack baseline and current research.
- Data: 2026-09-20

## Context

A plataforma armazenará credenciais para billing, WhatsApp, provider browser, Ads e outros integrations. `.env` distribuído não oferece governança suficiente.

## Decision proposed

Usar Infisical em produção para:

- centralização de secrets;
- environment separation;
- machine identities;
- scoped RBAC;
- audit;
- rotation quando suportada.

Secret values não entram no banco de domínio; tabelas guardam `secret_ref`.

## Alternative

HashiCorp Vault continua alternativa forte se requisitos futuros justificarem maior complexidade operacional.

## Validation before Accepted

- machine identity por worker;
- secret fetch sem exposição em logs;
- rotation test;
- tenant/provider scope;
- restore/disaster path.

## Aceitação (2026-09-29)

Aceito pelo operador em 2026-09-29 após dossiê de decisão (explorer MVP-ADR-01).
Aceitar NÃO implanta: faltam projeto Infisical, identities por worker, migração para `secret_ref` e runbook de rotation; até a integração existir, as credenciais CINEVISION/MK permanecem no cofre do operador conforme `AGENTS.md`.
