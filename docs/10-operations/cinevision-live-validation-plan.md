# CINEVISION Live Validation Plan

> Status: Ready for execution when authenticated environment is available
> Versão: 0.13
> Data: 2026-09-20
> Review: Auto-reviewed v0.13 — no selectors/endpoints invented.

## Goal

Convert the semantic operation catalog into an evidence-backed adapter contract.

## For each operation

Capture:

- operation name;
- panel version/date;
- route/page;
- prerequisite state;
- stable semantic locators;
- inputs;
- confirmation/preview step;
- network calls observed (if authorized to inspect);
- expected postcondition;
- evidence before/after;
- timeout behavior;
- duplicate/retry behavior;
- challenge/CAPTCHA/2FA behavior;
- rollback/repair path;
- trace/screenshot reference.

## Order of validation

1. read-only customer lookup/status;
2. create Trial via official/available API;
3. sync customer;
4. renew customer in safe test account;
5. migrate server;
6. change connections;
7. block/unblock;
8. courtesy extension;
9. playlist/credential reads;
10. destructive actions last and only in controlled test account.

## Safety

No anti-bot bypass. Security challenges generate HITL. Never validate destructive flows on a real customer without explicit controlled test setup.
