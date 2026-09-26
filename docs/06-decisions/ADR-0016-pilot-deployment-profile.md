# ADR-0016 — Pilot Deployment Profile

> Status: Proposed
> Data: 2026-09-20
> Review: Auto-reviewed v0.13 — operational complexity and portability considered.

## Decision proposed

For the pilot, run web/API/workers/browser in containers on a VPS behind Cloudflare, use standard PostgreSQL with managed hosting preferred initially, use S3-compatible object storage and keep every external service behind an adapter/interface.

## Why

This minimizes operational burden while preserving self-hosting portability. Browser Worker remains isolated from public web/API containers.

## Validation before Accepted

- staging deployment;
- backup/restore evidence;
- secret injection through production mechanism;
- worker restart/recovery;
- browser profile isolation;
- telemetry and alerts;
- deployment rollback.
