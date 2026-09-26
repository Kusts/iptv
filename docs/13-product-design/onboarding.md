# Onboarding Experience

> Status: Proposed baseline
> Versão: 0.14
> Data: 2026-09-20
> Review: Auto-reviewed v0.14 — safe defaults emphasized.

## Tenant onboarding sequence

1. Workspace/tenant identity.
2. Users + roles.
3. Catalog basics.
4. Billing integration.
5. Messaging integration.
6. Provider integration.
7. Brand/agent persona overlay.
8. Business rules and communication windows.
9. Test/sandbox verification.
10. Go-live checklist.

## Safety defaults

Until onboarding validation passes:

- outbound AI disabled;
- browser provider actions disabled;
- paid campaign actions disabled;
- destructive tools disabled;
- test data clearly separated.

## Customer onboarding after sale

- confirm service activation;
- show/install required app;
- validate first playback;
- explain support channel;
- explain renewal date;
- ask preferences where useful;
- do not immediately push referral before experience is confirmed.

## Refined tenant onboarding v0.14

Recommended sequence after integration connection:

1. connect provider and messaging accounts;
2. discover/import existing provider customers with preview/conflict review;
3. configure business defaults (adult default ON if chosen, Trial duration, default server, early-renewal offer, connection behavior);
4. configure per-operation autonomy: AUTO / APPROVAL / MANUAL;
5. configure inventory thresholds/budgets and supplier balances;
6. start in OBSERVE mode over imported base;
7. promote to RECOMMEND/APPROVAL/AUTO as evidence and operator confidence grow.

Manual Control Center remains fully usable even when automation is enabled.
