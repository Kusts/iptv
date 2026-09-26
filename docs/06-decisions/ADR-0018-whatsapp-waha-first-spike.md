# ADR-0018 — WAHA as primary WhatsApp gateway

- Status: **ACCEPTED**
- Decision: WAHA is the first implementation behind the owned `MessagingGateway`. GOWS is the preferred engine subject to capability certification.
- Constraints: MessageIntent → Communication Policy → WhatsApp Risk Controller → queue → adapter. Account restrictions never justify evasion behavior. Timelock/capping degrade only affected capabilities where possible. Engine upgrades/switches require regression/canary certification.
