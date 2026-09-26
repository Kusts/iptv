# Integration SPEC — MK Ativador / AtiveAPP Supplier Adapter

> Status: Draft based on public catalog analysis 2026-09-22; authenticated purchase flow still requires live validation.  
> Version: 1.0  
> Review: Auto-reviewed v0.14 — separates public catalog evidence, supplier balance, procurement and customer-facing pricing.

## Purpose

Represent MK Ativador as a **supplier of media-player app activations/licenses**, never as our customer catalog/source of commercial truth.

## Public catalog evidence snapshot

The observed public API returned 175 apps for `parametro=mkativador`: 48 annual at R$15, 124 annual at R$20, 2 annual at R$25, and SET IPTV at R$80 lifetime. Prices are a dated supplier snapshot and may change.

Store as `SupplierProduct` fields: external id, app name, annual/lifetime price, activation flags/method, availability and `last_verified_at`. Supplier changes may trigger margin review but never silently rewrite our retail price.

## Test-before-buy rule

The supplier/site communicates a free 7-day test. Our procurement invariant:

```text
customer chooses paid app candidate
→ configure/use free trial
→ customer confirms value/compatibility
→ Order settles
→ reserve supplier balance
→ purchase/activate
→ verify license postcondition
```

No speculative app-license purchase before customer payment.

## Activation input variants

Observed catalog flags imply different flows: default MAC, license/key, MAC+Key, Device ID, Cloudy email/password and specific IBO flow. Exact authenticated purchase semantics remain adapter-version/live evidence.

## Supplier balance

Tenant/operator may preload monetary balance. Maintain our own append-only `SupplierBalanceLedger` and reconcile with observed supplier balance when an authorized read path exists. Reservation occurs before activation procurement.

## Purchase channels

Potential channels: authenticated web and Telegram. Credentials/phone/account references stay in Secrets Manager. Telegram/web purchase automation is not assumed safe until live contract/flow validation; ambiguous financial actions require approval/HITL.

## Security

Never put supplier credentials into LLM prompt/history. Browser automation uses authorized normal session; CAPTCHA/2FA/security challenges → HITL.
