#!/usr/bin/env python3
from pathlib import Path
import sys
ROOT=Path(__file__).resolve().parents[1]
FILES=['CHANGELOG.md', 'README.md', 'docs/00-meta/auto-review-v0.14.md', 'docs/00-meta/refinement-v0.14-summary.md', 'docs/00-meta/remaining-live-evidence.md', 'docs/00-vision/glossary.md', 'docs/01-product/PRD.md', 'docs/01-product/journeys.md', 'docs/01-product/scope.md', 'docs/02-domain/commerce-payments/states.md', 'docs/02-domain/conceptual-data-model.md', 'docs/02-domain/domain-map.md', 'docs/02-domain/entitlements/states.md', 'docs/02-domain/event-model.md', 'docs/02-domain/knowledge/states.md', 'docs/02-domain/subscriptions/states.md', 'docs/02-domain/support/states.md', 'docs/03-architecture/logical-data-model.md', 'docs/04-specs/01-identity-crm/SPEC.md', 'docs/04-specs/02-trial/SPEC.md', 'docs/04-specs/03-commerce-billing/SPEC.md', 'docs/04-specs/04-subscription-entitlements/SPEC.md', 'docs/04-specs/05-provider-fulfillment/SPEC.md', 'docs/04-specs/07-support-hitl-knowledge/SPEC.md', 'docs/04-specs/08-referral-core/SPEC.md', 'docs/04-specs/09-compatibility-engine/SPEC.md', 'docs/04-specs/10-inventory-procurement/SPEC.md', 'docs/04-specs/12-communication-policy/SPEC.md', 'docs/04-specs/13-knowledge-ingestion/SPEC.md', 'docs/04-specs/19-next-best-action/SPEC.md', 'docs/04-specs/integrations/README.md', 'docs/04-specs/integrations/cinevision-operation-catalog.md', 'docs/04-specs/integrations/cinevision.md', 'docs/04-specs/integrations/mk-ativador.md', 'docs/04-specs/integrations/whatsapp.md', 'docs/06-decisions/ADR-0017-whatsapp-evolution-provisional.md', 'docs/06-decisions/ADR-0018-whatsapp-waha-first-spike.md', 'docs/06-decisions/README.md', 'docs/07-agent/eval-plan.md', 'docs/07-agent/policy-architecture.md', 'docs/07-agent/tool-contracts.md', 'docs/09-security-compliance/rbac-permissions.md', 'docs/10-operations/incident-problem-management.md', 'docs/11-research/cinevision-one-panel-evidence-2026-09-19.md', 'docs/11-research/mkativador-analysis-2026-09-22.md', 'docs/12-roadmap/epics/EPIC-04-subscription-entitlements.md', 'docs/12-roadmap/mvp-implementation-sequence.md', 'docs/12-roadmap/tasks/wave-03/cb_06.md', 'docs/12-roadmap/tasks/wave-04/se_06.md', 'docs/13-product-design/admin-experience.md', 'docs/13-product-design/onboarding.md', 'docs/13-product-design/screen-inventory.md', 'docs/14-user-docs/admin/billing-renewals.md', 'docs/14-user-docs/admin/customer-support.md', 'docs/14-user-docs/admin/provider-operations.md']
errors=[]
for rel in FILES:
 p=ROOT/rel
 if not p.exists(): errors.append(f"missing: {rel}"); continue
 text=p.read_text(encoding="utf-8", errors="ignore")
 if "Auto-reviewed v0.14" not in text:
  errors.append(f"missing v0.14 review marker: {rel}")
if errors:
 print(f"FAILED: {len(errors)} review issue(s)")
 for e in errors: print("-",e)
 sys.exit(1)
print(f"OK: v0.14 review markers validated for {len(FILES)} changed Markdown files")
