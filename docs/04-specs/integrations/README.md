# Integration Specifications

> Status: Canonical integration guidance  
> Version: 0.15  
> Review: Auto-reviewed v0.15 — added the CINEVISION Provider Runtime Hardening SPEC+PLAN (reviewed against the codebase 2026-10-01).

These documents define the boundary between the platform and external systems. External systems are adapters/fulfillment channels, never the platform source of truth.

- [Asaas](asaas.md)
- [CINEVISION Provider](cinevision.md)
- [CINEVISION Operation Catalog](cinevision-operation-catalog.md)
- [CINEVISION Provider Runtime Hardening](cinevision-runtime-hardening.md)
- [Unofficial WhatsApp Gateway](whatsapp.md)
- [WhatsApp Operation Catalog](whatsapp-operation-catalog.md)

Implementation must pin the external API/provider version actually used and update the corresponding integration document when behavior changes.

## Supplier integrations

- `mk-ativador.md` — supplier catalog/balance/app-license procurement.

## Auto-revisão v0.14

> Review: Auto-reviewed v0.14 — integration index reconciled with the MK Ativador supplier adapter and current provider boundaries.
