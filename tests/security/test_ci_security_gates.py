#!/usr/bin/env python3
"""P6 CI security-gates self-test (CODER-P6A).

Garante que os gates P6 continuam presentes no workflow e que os artefatos
de config existem — sem executar rede, sem segredos. Roda na CI dentro do
job novo `security-scans` e localmente com `python tests/security/test_ci_security_gates.py`.
"""
from __future__ import annotations

from pathlib import Path
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"
GITLEAKS_CONFIG = ROOT / ".gitleaks.toml"
AUDIT_GATE = ROOT / "scripts" / "ci-audit-gate.py"
AUDIT_BASELINE = ROOT / "tests" / "security" / "audit-baseline.json"

# Suítes adversariais críticas com job próprio (F09 prompt-injection +
# F10 isolamento de tenant).
ADVERSARIAL_SUITES = [
    "test/agent-shadow-approval.integration.test.ts",
    "test/agent-model-failure.test.ts",
    "test/rls-tenant-context.integration.test.ts",
]


def workflow() -> dict:
    return yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))


def workflow_text() -> str:
    return WORKFLOW.read_text(encoding="utf-8")


class TestCiSecurityGates(unittest.TestCase):
    def test_secret_scan_job(self):
        jobs = workflow()["jobs"]
        self.assertIn("security-scans", jobs)
        text = workflow_text()
        self.assertIn("gitleaks", text)
        self.assertIn("8.24.0", text)  # gitleaks pinado
        self.assertIn(".gitleaks.toml", text)
        self.assertIn("--redact", text)  # sem segredos em logs
        self.assertIn("fetch-depth: 0", text)  # detect cobre o histórico

    def test_dependency_audit_job(self):
        text = workflow_text()
        self.assertIn("scripts/ci-audit-gate.py", text)
        self.assertIn("audit-baseline.json", text)

    def test_adversarial_job(self):
        jobs = workflow()["jobs"]
        self.assertIn("adversarial", jobs)
        text = workflow_text()
        for suite in ADVERSARIAL_SUITES:
            self.assertIn(suite, text)
            self.assertTrue((ROOT / "apps" / "api" / suite).exists(), f"suite ausente: {suite}")
        self.assertIn("TEST_DATABASE_URL", text)  # suites de integração precisam de PG

    def test_migration_proof_coverage(self):
        jobs = workflow()["jobs"]
        text = workflow_text()
        # Provas PG de migration já cobertas na CI (build + job isolado 050).
        self.assertIn("run_pg_fixture_tests.sh", text)
        self.assertIn("outbox-050-role-guards", jobs)
        self.assertIn("run_outbox_role_negative_tests.sh", text)

    def test_scan_configs_exist(self):
        self.assertTrue(GITLEAKS_CONFIG.exists())
        config = GITLEAKS_CONFIG.read_text(encoding="utf-8")
        self.assertIn("useDefault = true", config)
        self.assertTrue(AUDIT_GATE.exists())
        baseline = AUDIT_BASELINE.read_text(encoding="utf-8")
        self.assertIn('"threshold": "high"', baseline)
        self.assertIn("GHSA-", baseline)

    def test_existing_gates_untouched(self):
        # Guarda anti-regressão: os gates canônicos do job `build` seguem lá.
        jobs = workflow()["jobs"]
        self.assertIn("build", jobs)
        text = workflow_text()
        for gate in (
            "pnpm test",
            "python scripts/validate_docs.py",
            "python tests/contracts/test_contracts.py",
            "python tests/contracts/test_seed_contract.py",
        ):
            self.assertIn(gate, text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
