# Product Identity & Experience Design

> Status: Proposed baseline
> Versão: 0.13
> Data: 2026-09-20
> Review: Auto-reviewed v0.13 — checked against Product Vision, PRD, Agent Runtime and Control Center scope.

## Purpose

This directory is the canonical source for how the product should look, sound and behave. It exists so implementation agents do not invent brand, navigation, interaction or conversational behavior while coding.

## Authority order inside this area

1. `product-positioning.md`
2. `naming.md`
3. `brand-personality.md`
4. `brand-voice.md`
5. `agent-persona.md`
6. `information-architecture.md` + `navigation.md`
7. `design-system/*`
8. `user-flows.md` + `screen-specs/*`
9. `microcopy.md`

If a screen spec conflicts with Domain/PRD/Policy, Domain/PRD/Policy wins and the screen spec must be corrected.

## Files

- `product-positioning.md` — category, audience, value proposition and differentiation.
- `naming.md` — naming strategy and recommended working brand.
- `brand-personality.md` — personality traits and anti-traits.
- `brand-voice.md` — writing style of the product/brand.
- `agent-persona.md` — default customer-facing AI persona.
- `visual-direction.md` — visual language.
- `logo-system.md` — logo brief and usage rules; artwork remains gated by naming clearance.
- `information-architecture.md` — content hierarchy.
- `navigation.md` — Control Center navigation model.
- `screen-inventory.md` — screen catalog and priority.
- `user-flows.md` — UX flows.
- `admin-experience.md` — operational UX philosophy.
- `ai-experience.md` — UX patterns for agent/tool/HITL states.
- `onboarding.md` — tenant and customer onboarding.
- `landing-page.md` — marketing/lead experience.
- `microcopy.md` — canonical labels/messages.
- `responsive.md` — desktop/tablet/mobile behavior.
- `accessibility.md` — accessibility baseline.
- `frontend-ux-standards.md` — implementation rules for frontend agents.
- `design-system/` — design tokens, components and patterns.
- `screen-specs/` — high-priority screen specifications.

## Status rule

The visual system is `Proposed` until public naming/legal clearance and a first usability review. The UX structure is implementation-authoritative unless contradicted by higher-order product/domain documents.
