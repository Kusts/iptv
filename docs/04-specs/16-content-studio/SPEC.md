# SPEC — Content Studio & Publishing

> Status: Supporting detail — reconciled under v1.0 implementation baseline
> Version: 1.0  
> Review: Auto-reviewed v0.11 — checked for authority, state/event vocabulary, tenant isolation, failure paths and testability.

## Purpose

Create, manage and publish original/authorized content while preserving asset rights metadata and platform/channel policies.

## Asset rights states

```text
OWNED
LICENSED
OFFICIAL_PROMOTIONAL
PERMISSION_GRANTED
PUBLIC_DOMAIN
LICENSE_COMPATIBLE
UNKNOWN
RESTRICTED
```

`UNKNOWN`/`RESTRICTED` cannot auto-publish.

## Pipeline

Idea → brief/script → asset selection/generation → rights/compliance gate → approval → publish → performance → learning.

Editing third-party content does not create publishing rights. Rights evidence and permitted-use scope are stored with Asset.

## Auto-review result

Reviewed to prevent automation from treating modification as copyright permission.
