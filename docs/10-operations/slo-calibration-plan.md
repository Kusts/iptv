# SLO Calibration Plan

> Status: Baseline method defined; numeric targets require pilot evidence
> Versão: 0.13
> Data: 2026-09-20
> Review: Auto-reviewed v0.13 — avoids fabricated SLA numbers.

## Calibration period

Collect at least a representative pilot window before freezing production SLOs.

## Candidate SLIs

- API availability/latency;
- inbound webhook durable-ingest latency;
- message send success/latency;
- provider fulfillment success/latency;
- workflow delay/backlog;
- Human Review queue time;
- Trial provisioning latency;
- payment-to-entitlement latency;
- reconciliation drift age;
- agent tool success and policy-block rate.

## Rule

SLO must be tied to a user/business outcome, not chosen only because the number looks industry-standard.

## Review

Targets are proposed from baseline, stress/failure tests and business tolerance, then approved before pilot GA.
