# ADR-0003 — Ports & Adapters nas bordas

- **Status:** Accepted
- **Data:** 2026-09-20

## Context

O produto depende inicialmente de CINEVISION, Asaas e WhatsApp não oficial, mas nenhuma dessas dependências deve determinar o Domain Core.

## Decision

Integrações externas serão implementadas atrás de ports/contracts próprios.

Exemplos:

```text
PaymentGateway
MessagingGateway
IPTVProvider
AdsPlatform
AppLicenseProvider
```

## Consequences

### Positivas

- substituição de providers;
- testes melhores;
- domínio mais estável.

### Custos

- camada adicional de mapping;
- necessidade de contratos internos claros.
