# Accessibility Baseline

> Status: Canonical baseline
> Versão: 0.13
> Data: 2026-09-20
> Review: Auto-reviewed v0.13 — intended target WCAG 2.2 AA where applicable.

## Requirements

- semantic HTML first;
- keyboard navigation for all core workflows;
- visible focus;
- no information conveyed by color alone;
- charts require textual summaries/tooltips;
- form errors tied to fields;
- dialogs trap/restore focus correctly;
- reduced motion respected;
- loading/progress announced where appropriate;
- contrast target AA;
- destructive actions use text + icon + confirmation, not red alone.

## AI-specific accessibility

Streaming responses must not cause uncontrollable focus/scroll jumps. Tool status updates should be readable by assistive technology without announcing every internal micro-step.
