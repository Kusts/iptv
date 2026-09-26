# Acceptance Scenarios — Wave 01

> These scenarios are executable specifications, not a second source of domain rules.

## A01 — Cross-tenant isolation

**Given** User A is an active member of Tenant A  
**And** Person B belongs to Tenant B  
**When** User A requests Person B by UUID  
**Then** the resource is not returned  
**And** no existence-sensitive data leaks through error detail.

## A02 — Idempotent Person creation

**Given** the same normalized identity and idempotency key  
**When** two equivalent create-Person requests are processed  
**Then** exactly one Person exists  
**And** both callers observe the same canonical resource.

## A03 — Identity ambiguity

**Given** identity evidence conflicts with existing ownership  
**When** resolution is attempted  
**Then** no automatic merge occurs  
**And** a review path is created/audited.

## A04 — Outbox atomicity

**Given** a command changes canonical state and creates a domain event  
**When** the database transaction rolls back  
**Then** neither canonical state nor publishable outbox message survives.

## A05 — Duplicate webhook

**Given** an external event ID has already been processed  
**When** the same provider event is received again  
**Then** inbox dedupe prevents a second domain side effect.

## A06 — Kill switch

**Given** `browser.provider.enabled=false` for Tenant A  
**When** an operation requiring Browser Worker is requested  
**Then** execution is refused/paused according to policy  
**And** Tenant B remains unaffected.

## A07 — Synthetic fixture integrity

**Given** migrations 001–011 are installed  
**When** pilot seed is applied twice  
**Then** no duplicate-domain effect occurs  
**And** monthly price remains BRL 30.00  
**And** additional connection remains recurring with no invented sale price.
