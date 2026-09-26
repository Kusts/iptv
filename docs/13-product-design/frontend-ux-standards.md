# Frontend & UX Implementation Standards

> Status: Canonical implementation baseline
> Versão: 0.13
> Data: 2026-09-20
> Review: Auto-reviewed v0.13 — intended for frontend implementation agents.

## Rules

1. Do not invent business state in the UI.
2. Use contract/domain enums, never duplicate handwritten status lists.
3. Every async action has idle/loading/success/failure/unknown-effect states.
4. External success is rendered only after postcondition/evidence when required.
5. Tables require sorting/filtering only when backed by server/query semantics.
6. Preserve URL state for navigable filters where useful.
7. Use optimistic UI only for low-risk reversible local state.
8. Financial/provider actions default to pessimistic confirmation.
9. Provide skeletons for predictable layouts; use spinners only for local actions.
10. Error boundaries must preserve actionable context/correlation ID.

## Recommended frontend stack

- Next.js App Router;
- TypeScript strict;
- Tailwind CSS;
- shadcn/ui primitives with project-owned wrappers;
- TanStack Table for dense operational tables;
- TanStack Query where client cache/invalidation is justified;
- React Hook Form + Zod for complex forms;
- generated/typed API client from OpenAPI contract.

Component wrappers in the product design system are authoritative over raw third-party defaults.
