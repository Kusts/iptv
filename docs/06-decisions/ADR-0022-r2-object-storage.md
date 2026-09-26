# ADR-0022 — Cloudflare R2 object storage

- Status: **ACCEPTED**
- Decision: store attachments/audio/browser evidence/exports in private R2 buckets through the S3-compatible interface. Metadata/authorization remains application-owned. Active browser profiles are not run directly from object storage.
