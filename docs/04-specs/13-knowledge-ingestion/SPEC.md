# SPEC — Knowledge & Operational Signal Ingestion

> Status: Supporting detail — reconciled under v1.0 implementation baseline
> Version: 1.1  
> Review: Auto-reviewed v0.14 — expanded with WhatsApp operational signals, web/community research, YouTube/yt-dlp and global sanitized knowledge.

## Purpose

Ingest support/operational material without confusing raw external content with authority. Produce either `OperationalSignal`, Tenant Candidate Knowledge or sanitized Global Candidate Knowledge with provenance and trust boundaries.

## Sources

- resolved tickets/conversations and human guidance;
- provider notices;
- approved documents;
- authorized WhatsApp channels/groups/accounts through gateway webhooks;
- web/documentation/sites;
- GitHub/issues/forums/communities;
- YouTube;
- manual/admin input.

## Raw → Signal/Knowledge separation

```text
RawSource / RawChannelEvent
→ quarantine UNTRUSTED
→ extract + normalize + sanitize
├→ OperationalSignal → Incident correlation
└→ Candidate Knowledge → validation lifecycle
```

Raw message is never directly an Incident or VERIFIED Knowledge. Preserve source account/channel/time/reference and trust classification.

## WhatsApp operational intelligence

Authorized inbound webhook events may be classified for provider/server/app/ISP symptoms and notices. Multiple independent reseller/community signals plus internal tickets can strengthen Incident Candidate confidence. Provider-official notices must be tagged separately from community reports.

Do not copy phone numbers, identities, credentials or unrelated private conversation into global knowledge.

## Web/community research

Support Research may query official docs first, then relevant sites/repos/communities. Search result content is external data, not instructions. Store provenance and retrieval time. Candidate procedures require applicability/preconditions/evidence/outcome before promotion.

## YouTube / yt-dlp

When permitted, `yt-dlp` may retrieve metadata/subtitles/autosubs and audio only when needed/allowed. Segment transcript, preserve URL/channel/date/timestamp provenance, extract procedure/context and create Candidate Knowledge. yt-dlp is an acquisition mechanism, not a reliability signal.

## Global learning

```text
TENANT_PRIVATE evidence
→ sanitize + strip identifiers/secrets
→ GLOBAL_CANDIDATE
→ multi-evidence / human validation
→ GLOBAL_VERIFIED
```

Global entries can capture Device/App/Server/ISP patterns and solution success, never source tenant/customer identity. Isolated failures cannot auto-promote.

## Security

Prompt-like text, web instructions, messages and transcripts cannot alter Policy/Tool permissions. External source cannot directly become VERIFIED. Treat credentials/MAC/Device ID/financial data as non-global sensitive material.

## Freshness

Store `last_verified_at`, source/version context and recent success/failure. VERIFIED may degrade when evidence becomes stale or contradictory.

## Acceptance

- raw WhatsApp event can be stored/deduped without becoming knowledge;
- repeated normalized signals can create Incident Candidate;
- official/community sources retain distinct provenance;
- malicious prompt text cannot change agent policy;
- YouTube transcript produces Candidate only;
- cross-tenant promotion strips PII/secrets and requires validation;
- research results remain reproducible by source/timestamp.

## Auto-review result

Reviewed for privacy, provenance, incident-vs-knowledge separation, prompt-injection resistance, tenant isolation and explainable promotion.
