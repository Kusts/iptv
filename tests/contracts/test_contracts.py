#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
import re
import sys
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[2]

sys.path.insert(0, str(ROOT / "scripts"))
import validate_docs as vd

EVENT_RE = re.compile(r"([a-z][a-z0-9_-]*\.[a-z][a-z0-9_.-]*\.v\d+)")
REGISTRY_START = "<!-- event-registry:start -->"
REGISTRY_END = "<!-- event-registry:end -->"


def all_sql() -> str:
    return "\n".join(p.read_text(encoding="utf-8") for p in sorted((ROOT / "db/migrations").glob("*.sql")))


def sql_enum(constraint: str, column: str = "status") -> set[str]:
    text = all_sql()
    pattern = rf"CONSTRAINT\s+{re.escape(constraint)}\s+CHECK\s*\(\s*{re.escape(column)}\s+IN\s*\(([^)]*)\)\s*\)"
    match = re.search(pattern, text, re.I | re.S)
    if not match:
        raise AssertionError(f"constraint not found: {constraint}")
    return set(re.findall(r"'([^']+)'", match.group(1)))


def registry_block(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    assert REGISTRY_START in text and REGISTRY_END in text, f"registry block missing in {path}"
    return text.split(REGISTRY_START, 1)[1].split(REGISTRY_END, 1)[0]


def registry_events(path: Path) -> set[str]:
    return set(EVENT_RE.findall(registry_block(path)))


def spec_operational_events(text: str) -> set[str]:
    refs: set[str] = set()
    heading_re = re.compile(r"^(#{1,4})\s+(.*)$", re.M)
    headings = list(heading_re.finditer(text))
    for i, match in enumerate(headings):
        title = match.group(2).strip().lower()
        if ("evento" not in title) and ("core events" not in title):
            continue
        start = match.end()
        end = len(text)
        for nxt in headings[i + 1 :]:
            if len(nxt.group(1)) <= 2:
                end = nxt.start()
                break
        refs.update(EVENT_RE.findall(text[start:end]))
    return refs


def collect_spec_operational_refs() -> set[str]:
    union: set[str] = set()
    for file in sorted((ROOT / "docs/04-specs").rglob("*.md")):
        union.update(spec_operational_events(file.read_text(encoding="utf-8")))
    return union


def asyncapi_channels(document: dict) -> set[str]:
    channels = document.get("channels") or {}
    return {k for k in channels if isinstance(k, str) and EVENT_RE.fullmatch(k)}


class ContractConsistencyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.openapi = yaml.safe_load((ROOT / "docs/05-contracts/openapi/openapi.yaml").read_text(encoding="utf-8"))
        cls.asyncapi = yaml.safe_load((ROOT / "docs/05-contracts/asyncapi/asyncapi.yaml").read_text(encoding="utf-8"))
        cls.asyncapi_raw = (ROOT / "docs/05-contracts/asyncapi/asyncapi.yaml").read_text(encoding="utf-8")
        cls.event_registry = registry_events(ROOT / "docs/02-domain/event-model.md")
        cls.baseline_registry = registry_events(ROOT / "docs/15-implementation-baseline/04-event-catalog.md")
        cls.spec_refs = collect_spec_operational_refs()
        cls.channels = asyncapi_channels(cls.asyncapi)

    def api_enum(self, schema: str, prop: str) -> set[str]:
        return set(self.openapi["components"]["schemas"][schema]["properties"][prop]["enum"])

    def test_openapi_states_match_database_constraints(self):
        mappings = [
            ("Trial", "lifecycleStatus", "trials_lifecycle_check", "lifecycle_status"),
            ("Order", "status", "orders_status_check", "status"),
            ("Charge", "status", "charges_status_check", "status"),
            ("Payment", "status", "payments_status_check", "status"),
            ("RefundRequest", "status", "refund_requests_status_check", "status"),
            ("Refund", "status", "refunds_status_check", "status"),
            ("Subscription", "status", "subscriptions_status_check", "status"),
            ("ProviderOperation", "status", "provider_operations_status_check", "status"),
            ("SupportTicket", "status", "support_tickets_status_check", "status"),
            ("HumanReview", "status", "human_review_status_check", "status"),
            ("Referral", "status", "referrals_status_check", "status"),
            ("Conversation", "status", "conversations_status_check", "status"),
            ("Conversation", "controlMode", "conversations_control_mode_check", "control_mode"),
            ("Incident", "status", "incidents_status_check", "status"),
            ("Problem", "status", "problems_status_check", "status"),
            ("KnowledgeItem", "status", "knowledge_items_status_check", "status"),
            ("ReferralQualification", "status", "referral_qualifications_status_check", "status"),
            ("Reward", "status", "rewards_status_check", "status"),
            ("GiftPass", "status", "gift_passes_status_check", "status"),
            ("Message", "deliveryStatus", "message_deliveries_status_check", "status"),
        ]
        for schema, prop, constraint, column in mappings:
            with self.subTest(schema=schema):
                self.assertEqual(self.api_enum(schema, prop), sql_enum(constraint, column))

    def test_canonical_state_sets_match_database_and_api(self):
        catalog = (ROOT / "docs/15-implementation-baseline/03-state-machines.md").read_text(encoding="utf-8")
        mappings = [
            ("Conversation", "Conversation", "status", "conversations_status_check"),
            ("CustomerOrder", "Order", "status", "orders_status_check"),
            ("Charge", "Charge", "status", "charges_status_check"),
            ("Payment", "Payment", "status", "payments_status_check"),
            ("RefundRequest", "RefundRequest", "status", "refund_requests_status_check"),
            ("Refund", "Refund", "status", "refunds_status_check"),
            ("CustomerSubscription", "Subscription", "status", "subscriptions_status_check"),
            ("ProviderOperation", "ProviderOperation", "status", "provider_operations_status_check"),
            ("Ticket", "SupportTicket", "status", "support_tickets_status_check"),
            ("HumanReviewRequest", "HumanReview", "status", "human_review_status_check"),
            ("Referral", "Referral", "status", "referrals_status_check"),
            ("Reward", "Reward", "status", "rewards_status_check"),
            ("KnowledgeItem", "KnowledgeItem", "status", "knowledge_items_status_check"),
        ]
        for heading, schema, prop, constraint in mappings:
            with self.subTest(aggregate=heading):
                section = catalog.split(f"## {heading}\n", 1)[1].split("\n## ", 1)[0]
                match = re.search(r"`([A-Z_]+(?: \| [A-Z_]+)+)`", section)
                self.assertIsNotNone(match, f"missing explicit canonical state set for {heading}")
                states = set(match.group(1).split(" | "))
                self.assertEqual(states, sql_enum(constraint))
                self.assertEqual(states, self.api_enum(schema, prop))

    def test_trial_lifecycle_and_kind_are_distinct_from_technical_outcome(self):
        catalog = (ROOT / "docs/15-implementation-baseline/03-state-machines.md").read_text(encoding="utf-8")
        section = catalog.split("## ServiceTrial\n", 1)[1].split("\n## ", 1)[0]
        lifecycle = re.search(r"`([A-Z_]+(?: \| [A-Z_]+)+)`", section)
        self.assertIsNotNone(lifecycle)
        self.assertEqual(set(lifecycle.group(1).split(" | ")), sql_enum("trials_lifecycle_check", "lifecycle_status"))
        self.assertEqual(set(lifecycle.group(1).split(" | ")), self.api_enum("Trial", "lifecycleStatus"))
        self.assertEqual({"TRIAL", "RETRIAL"}, sql_enum("trials_kind_check", "trial_kind"))
        self.assertEqual({"TRIAL", "RETRIAL"}, self.api_enum("Trial", "kind"))
        self.assertIn("`PENDING | PASSED | FAILED | INCONCLUSIVE`", section)
        self.assertEqual(sql_enum("trials_technical_check", "technical_outcome"), self.api_enum("Trial", "technicalOutcome"))

    def test_asyncapi_events_exist_in_event_model(self):
        self.assertFalse(
            self.channels - self.event_registry,
            f"unknown AsyncAPI events: {sorted(self.channels - self.event_registry)}",
        )

    def test_registry_contains_operational_refs_and_asyncapi(self):
        """Registry must cover every operational SPEC ref and AsyncAPI channel."""
        self.assertFalse(
            self.spec_refs - self.event_registry,
            f"registry missing SPEC refs: {sorted(self.spec_refs - self.event_registry)}",
        )
        self.assertFalse(
            self.channels - self.event_registry,
            f"registry missing AsyncAPI channels: {sorted(self.channels - self.event_registry)}",
        )
        # Spot-check that the registry is not an empty/gutted stub.
        for sample in [
            "person.created.v1",
            "trial.requested.v1",
            "order.settled.v1",
            "payment.confirmed.v1",
            "support.resolved.v1",
            "referral.confirmed.v1",
            "reward.redeemed.v1",
        ]:
            self.assertIn(sample, self.event_registry)

    def test_registry_rejects_unknown_ref(self):
        """An invented name must be detectable as outside the registry."""
        bogus = "bogus.invented_event.v9"
        self.assertNotIn(bogus, self.event_registry)
        self.assertNotIn(bogus, self.spec_refs)
        self.assertNotIn(bogus, self.channels)
        # The operational-section parser must flag it if it ever appears
        # in an event section: simulate the validator's unknown-ref rule.
        unknown = {bogus} - self.event_registry
        self.assertEqual(unknown, {bogus})

    def test_baseline_registry_aligns_with_event_model(self):
        """Baseline catalog registry must match the Event Model registry."""
        self.assertEqual(
            self.baseline_registry,
            self.event_registry,
            f"baseline drift: missing={sorted(self.event_registry - self.baseline_registry)} "
            f"extra={sorted(self.baseline_registry - self.event_registry)}",
        )
        baseline_text = (ROOT / "docs/15-implementation-baseline/04-event-catalog.md").read_text(encoding="utf-8")
        self.assertIn("Semantic families", baseline_text)

    def test_event_type_schema_version_relationship(self):
        """Public ID suffix must match the envelope schema_version const."""
        envelope = self.asyncapi["components"]["schemas"]["EventEnvelopeBase"]["properties"]["schema_version"]
        const = envelope.get("const")
        self.assertEqual(const, 1)
        for channel in sorted(self.channels):
            event_type, _, major = channel.rpartition(".v")
            self.assertTrue(event_type and major.isdigit())
            self.assertEqual(int(major), const, f"envelope mismatch for {channel}")
        messages = self.asyncapi["components"]["messages"]
        for channel, spec in self.asyncapi["channels"].items():
            ref = spec["publish"]["message"]["$ref"]
            msg = ref.removeprefix("#/components/messages/")
            self.assertEqual(messages[msg]["name"], channel)

    def test_expanded_mvp_surface_is_present(self):
        required_paths = {
            "/v1/support/tickets/{ticketId}",
            "/v1/support/tickets/{ticketId}/transition",
            "/v1/support/tickets/{ticketId}/solution-attempts",
            "/v1/support/incidents",
            "/v1/support/problems",
            "/v1/hitl/reviews",
            "/v1/hitl/reviews/{reviewId}/actions",
            "/v1/conversations/{conversationId}/control",
            "/v1/knowledge/candidates",
            "/v1/knowledge/items/{knowledgeItemId}/validation",
            "/v1/knowledge/solutions/{solutionId}/outcomes",
            "/v1/referrals/{referralId}/qualification",
            "/v1/customers/{customerId}/rewards",
            "/v1/rewards/{rewardId}/redeem",
            "/v1/gift-passes/redeem",
            "/v1/payments/{paymentId}/refund-requests",
            "/v1/refund-requests/{refundRequestId}",
            "/v1/refund-requests/{refundRequestId}/execute",
        }
        self.assertFalse(required_paths - set(self.openapi["paths"]), f"missing paths: {sorted(required_paths - set(self.openapi['paths']))}")

    def test_asyncapi_covers_operational_learning_surface(self):
        required_events = {
            "conversation.human_takeover_started.v1",
            "conversation.returned_to_ai.v1",
            "support.resolved.v1",
            "incident.detected.v1",
            "problem.root_cause_confirmed.v1",
            "knowledge.candidate_created.v1",
            "knowledge.verified.v1",
            "knowledge.solution_outcome_recorded.v1",
            "hitl.guidance_provided.v1",
            "referral.qualification_started.v1",
            "referral.confirmed.v1",
            "reward.available.v1",
            "reward.redeemed.v1",
            "gift_pass.redeemed.v1",
        }
        self.assertFalse(required_events - self.channels, f"missing AsyncAPI events: {sorted(required_events - self.channels)}")
        self.assertFalse(required_events - self.event_registry, f"registry missing learning events: {sorted(required_events - self.event_registry)}")

    def test_critical_semantics_are_not_regressed(self):
        text = all_sql()
        for fragment in [
            "trials_one_primary_per_person",
            "trials_one_open_access_per_person",
            "subscription.require_recurring_addon",
            "subscription.subscription_addon_cycle_charges",
            "financial_ledger_entries_append_only",
            "reward_ledger_entries_append_only",
            "knowledge_versions_append_only",
            "human_review_actions_append_only",
            "conversation_control_events_append_only",
        ]:
            with self.subTest(fragment=fragment):
                self.assertIn(fragment, text)


    def test_canonical_semantic_separations_are_enforced(self):
        sql = all_sql()
        catalog = (ROOT / "docs/15-implementation-baseline/03-state-machines.md").read_text(encoding="utf-8")
        backlog = (ROOT / "docs/15-implementation-baseline/23-implementation-backlog.md").read_text(encoding="utf-8")

        self.assertIn("CREATE TABLE billing.charges", sql)
        self.assertIn("CREATE TABLE billing.payments", sql)
        self.assertIn("CREATE TABLE billing.refund_requests", sql)
        self.assertIn("payments_charge_order_fk", sql)
        self.assertIn("charges_idempotency_unique", sql)
        self.assertIn("refund_requests_human_review_fk", sql)
        self.assertIn("CREATE TABLE billing.refunds", sql)
        self.assertEqual(sql_enum("charges_status_check"), {"PENDING","PROCESSING","PAID","FAILED","CANCELLED","EXPIRED"})
        self.assertEqual(sql_enum("payments_status_check"), {"CONFIRMED","PARTIALLY_REFUNDED","REFUNDED","CHARGEBACK"})
        self.assertNotIn("FULFILLING", sql_enum("orders_status_check"))
        self.assertNotIn("COMPLETED", sql_enum("orders_status_check"))
        self.assertEqual(sql_enum("conversations_status_check"), {"OPEN","AWAITING_CUSTOMER","AWAITING_INTERNAL","RESOLVED","ARCHIVED"})
        self.assertIn("review_mode IN ('APPROVAL','REVIEW','GUIDANCE','MANUAL_EXECUTION')", sql)
        self.assertIn("reason IN ('SECURITY_CHALLENGE','PROVIDER_EXCEPTION','RISK_REVIEW','FINANCIAL_REVIEW','CONTENT_COMPLIANCE','OTHER')", sql)
        self.assertIn("## Charge", catalog)
        self.assertIn("## Payment", catalog)
        self.assertIn("Tenant Copilot foundation", backlog.split("## Wave 4", 1)[0])

    def test_refund_is_human_gated_and_separate_from_request(self):
        sql = all_sql()
        self.assertIn("refund_request_id uuid NOT NULL", sql)
        self.assertIn("human_review_request_id uuid", sql)
        self.assertIn("refunds_request_unique", sql)
        self.assertIn("effect_certainty text NOT NULL DEFAULT 'UNKNOWN'", sql)
        self.assertIn("refunds_effect_status_shape_check", sql)
        self.assertIn("refund_requests_review_shape_check", sql)
        self.assertIn("/v1/refund-requests/{refundRequestId}/execute", self.openapi["paths"])


GOOD_BLOCK = """\
| Public ID | Class | Status | Declared in | Semantic correspondence |
|---|---|---|---|---|
| `a.created.v1` | domain | planned/pre-implementation | SPEC 01-identity-crm | `a.created\\|updated` split into explicit transitions |
| `b.observed.v1` | observational | planned/pre-implementation | AsyncAPI | telemetry only, never an aggregate mutation |
"""


class RegistryStructureTests(unittest.TestCase):
    """Structured registry validation (mirrors scripts/validate_docs.py).

    Positive tests run the validator's pure helpers against the real
    registry; negative tests use in-memory modified fixtures. Machine
    checks cover presence/honesty of declaration only — whether the
    correspondence wording is semantically true still needs human review.
    """

    @classmethod
    def setUpClass(cls):
        model_block = registry_block(ROOT / "docs/02-domain/event-model.md")
        cls.rows, cls.parse_errors = vd.parse_registry_rows(model_block, "event-model")
        baseline_block = registry_block(ROOT / "docs/15-implementation-baseline/04-event-catalog.md")
        cls.baseline_rows, cls.baseline_errors = vd.parse_registry_rows(baseline_block, "baseline")
        per_file, _ = vd.collect_spec_operational_refs()
        cls.spec_by_dir = vd.group_spec_refs_by_dir(per_file)
        cls.channels = asyncapi_channels(
            yaml.safe_load((ROOT / "docs/05-contracts/asyncapi/asyncapi.yaml").read_text(encoding="utf-8"))
        )

    def test_registry_block_parses_without_errors(self):
        self.assertEqual(self.parse_errors, [])
        self.assertEqual(self.baseline_errors, [])
        self.assertEqual(set(self.rows), registry_events(ROOT / "docs/02-domain/event-model.md"))

    def test_registry_row_metadata_is_valid(self):
        self.assertTrue(self.rows)
        for public_id, row in sorted(self.rows.items()):
            with self.subTest(event=public_id):
                self.assertIn(row["klass"], {"domain", "observational"})
                self.assertEqual(row["status"], "planned/pre-implementation")
                self.assertTrue(row["declared"])
                for token in row["declared"]:
                    self.assertTrue(token == "AsyncAPI" or vd.SPEC_TOKEN_RE.fullmatch(token))
                self.assertTrue(row["correspondence"].strip())

    def test_registry_declared_claims_are_verified(self):
        self.assertEqual(vd.verify_declared_claims(self.rows, self.spec_by_dir, self.channels), [])

    def test_baseline_mirror_matches_full_rows(self):
        self.assertEqual(vd.diff_registry_rows(self.rows, self.baseline_rows), [])

    def test_rejects_wrong_declared_source(self):
        rows, errors = vd.parse_registry_rows(GOOD_BLOCK, "fixture")
        self.assertEqual(errors, [])
        # `a.created.v1` claims SPEC 01-identity-crm but is absent there;
        # `b.observed.v1` claims AsyncAPI but has no channel.
        issues = vd.verify_declared_claims(rows, {"01-identity-crm": {"other.event.v1"}}, set())
        self.assertEqual(len(issues), 2)
        self.assertTrue(any("a.created.v1" in issue and "SPEC 01-identity-crm" in issue for issue in issues))
        self.assertTrue(any("b.observed.v1" in issue and "AsyncAPI" in issue for issue in issues))
        # Honest claims verify clean.
        honest = vd.verify_declared_claims(
            rows, {"01-identity-crm": {"a.created.v1"}}, {"b.observed.v1"}
        )
        self.assertEqual(honest, [])

    def test_rejects_duplicate_public_id(self):
        duplicated = GOOD_BLOCK + "| `a.created.v1` | domain | planned/pre-implementation | AsyncAPI | dup |\n"
        _, errors = vd.parse_registry_rows(duplicated, "fixture")
        self.assertTrue(any("duplicate registry public ID" in e and "a.created.v1" in e for e in errors))

    def test_rejects_unknown_class_and_empty_correspondence(self):
        bad_block = """\
| Public ID | Class | Status | Declared in | Semantic correspondence |
|---|---|---|---|---|
| `c.signal.v1` | signal | planned/pre-implementation | AsyncAPI |  |
| `d.broken.v1` | domain | draft |  | some mapping |
| `e.broken.v1` | domain | planned/pre-implementation | SomewhereElse | some mapping |
"""
        _, errors = vd.parse_registry_rows(bad_block, "fixture")
        self.assertTrue(any("unknown class" in e and "c.signal.v1" in e for e in errors))
        self.assertTrue(any("without semantic correspondence" in e and "c.signal.v1" in e for e in errors))
        self.assertTrue(any("unexpected status" in e and "d.broken.v1" in e for e in errors))
        self.assertTrue(any("without declared source" in e and "d.broken.v1" in e for e in errors))
        self.assertTrue(any("unknown declared source" in e and "e.broken.v1" in e for e in errors))

    def test_detects_mirror_metadata_drift(self):
        drifted = GOOD_BLOCK.replace(
            "| `a.created.v1` | domain | planned/pre-implementation | SPEC 01-identity-crm |",
            "| `a.created.v1` | observational | planned/pre-implementation | AsyncAPI |",
        )
        model_rows, model_errors = vd.parse_registry_rows(GOOD_BLOCK, "model")
        mirror_rows, mirror_errors = vd.parse_registry_rows(drifted, "mirror")
        self.assertEqual(model_errors, [])
        self.assertEqual(mirror_errors, [])
        self.assertEqual(vd.diff_registry_rows(model_rows, model_rows), [])
        drift = vd.diff_registry_rows(model_rows, mirror_rows)
        self.assertEqual(len(drift), 1)
        self.assertIn("a.created.v1", drift[0])
        self.assertIn("metadata drift", drift[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
