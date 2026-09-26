# Visual Direction

> Status: Proposed
> Versão: 0.13
> Data: 2026-09-20
> Review: Auto-reviewed v0.13 — designed for high-density operational SaaS screens.

## Direction

**Operational clarity with AI-native accents.**

The product should look like a serious modern operations console, not a flashy AI demo.

## Visual principles

1. Light-first operational UI; dark mode optional.
2. Dense information with strong hierarchy, not excessive card nesting.
3. Blue as operational/action color; cyan as synchronization/flow accent.
4. Violet reserved for AI-specific states/insights, not generic decoration.
5. Semantic colors only for semantic states.
6. Charts prioritize readability over visual spectacle.
7. AI status is visible but never dominates business state.

## Proposed palette

| Token | Value | Use |
|---|---|---|
| Ink 950 | `#0B1220` | primary text / dark surfaces |
| Slate 700 | `#334155` | secondary text |
| Slate 200 | `#E2E8F0` | borders |
| Slate 50 | `#F8FAFC` | app background |
| White | `#FFFFFF` | surfaces |
| Flow Blue 600 | `#2563EB` | primary actions/navigation |
| Flow Cyan 500 | `#06B6D4` | sync/flow accent |
| AI Violet 500 | `#8B5CF6` | AI-specific states |
| Success 600 | `#16A34A` | verified success |
| Warning 600 | `#D97706` | degraded/review |
| Danger 600 | `#DC2626` | destructive/error |

All final component combinations must pass contrast checks; tokens may be adjusted without changing semantic roles.

## Typography

Primary: **Geist / system sans fallback**.

Operational numbers should support tabular numerals.

## Shape language

- radius: medium, not overly rounded;
- borders more common than heavy shadows;
- shadows only for overlays/elevation;
- subtle gradients permitted in brand surfaces, not critical data panels.

## Motion

Motion communicates state change, not decoration. Respect reduced-motion preference.
