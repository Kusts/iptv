#!/usr/bin/env python3
"""P6 CI security-gates self-test (CODER-P6A).

Garante que os gates P6 continuam presentes no workflow e que os artefatos
de config existem — sem executar rede, sem segredos. Roda na CI dentro do
job novo `security-scans` e localmente com `python tests/security/test_ci_security_gates.py`.

Também exercita `scripts/ci-audit-gate.py` com `subprocess.run` mockado
(sem rede): falha operacional/saída inválida nunca pode virar PASS, JSON
inconsistente (severidade ausente/desconhecida em qualquer advisory,
metadata.vulnerabilities inválido ou contador divergente) FALHA fechado, e
o exit code não-zero legítimo do `pnpm audit` com advisories válidos é
preservado.
"""
from __future__ import annotations

import importlib.util
import io
import json
import subprocess
import tempfile
import contextlib
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"
GITLEAKS_CONFIG = ROOT / ".gitleaks.toml"
AUDIT_GATE = ROOT / "scripts" / "ci-audit-gate.py"
AUDIT_BASELINE = ROOT / "tests" / "security" / "audit-baseline.json"
# Espelha o enum do gate (`scripts/ci-audit-gate.py`): a validação
# estrutural fail-closed cobre TODAS as severidades, não só high/critical.
KNOWN_SEVERITIES = ("info", "low", "moderate", "high", "critical")

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

    def test_audit_baseline_empty_is_intentional(self):
        # Invariante explícita: desde o upgrade OTel 2 coerente
        # (`@opentelemetry/sdk-trace-node` 2.12.0 + SDK/logs/exporters
        # 0.223.0, propagator-jaeger fora da árvore) nenhum high/critical
        # permanece reconhecido — a baseline real fica VAZIA de propósito.
        # O teste falha se `acknowledged` voltar a ficar não-vazio (mute
        # silencioso exige razão+followup por entrada) ou se a nota que
        # documenta a intenção desaparecer.
        baseline = json.loads(AUDIT_BASELINE.read_text(encoding="utf-8"))
        ack = baseline.get("acknowledged")
        self.assertIsInstance(ack, dict, "acknowledged precisa ser objeto")
        self.assertEqual(
            ack,
            {},
            "baseline reconhecendo high/critical precisa de nota explícita de intenção",
        )
        note = baseline.get("note", "").lower()
        self.assertIn(
            "otel",
            note,
            "baseline vazia sem nota declarando a intenção = suspeita de mute",
        )
        self.assertIn("vazia", note, "nota precisa afirmar que a baseline está vazia")


def load_audit_gate():
    spec = importlib.util.spec_from_file_location("ci_audit_gate_under_test", AUDIT_GATE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_audit_gate(stdout: str, returncode: int = 0, stderr: str = "", baseline: dict | None = None) -> int:
    """Roda `main()` do gate com `pnpm audit` mockado; devolve o exit code.

    `baseline`: quando passado, é gravado num arquivo temporário e injetado em
    `BASELINE_PATH` do módulo. Necessário para exercitar "high/critical
    reconhecido" agora que a baseline real pode estar vazia (upgrade OTel 2
    removeu o último advisory reconhecido — gate PASS com 0 ack é estado
    válido, não exceção).
    """
    gate = load_audit_gate()
    proc = subprocess.CompletedProcess(
        args="pnpm audit --json", returncode=returncode, stdout=stdout, stderr=stderr
    )
    with contextlib.ExitStack() as stack:
        stack.enter_context(mock.patch.object(gate.subprocess, "run", return_value=proc))
        stack.enter_context(redirect_stdout(io.StringIO()))
        if baseline is not None:
            with tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / "audit-baseline.json"
                path.write_text(json.dumps(baseline), encoding="utf-8")
                stack.enter_context(mock.patch.object(gate, "BASELINE_PATH", path))
                return gate.main()
        return gate.main()


def acknowledged_keys() -> list[str]:
    """Chaves reconhecidas na baseline REAL (pode ser vazia: desde o upgrade
    OTel 2 nenhum high/critical permanece reconhecido — o gate passa com 0)."""
    baseline = json.loads(AUDIT_BASELINE.read_text(encoding="utf-8"))
    ack = baseline.get("acknowledged", {})
    return sorted(ack)


def synthetic_acknowledged(keys: list[str]) -> dict:
    """Baseline sintética reconhecendo `keys` — fixture para os casos que
    precisam de high/critical reconhecido independente da baseline real."""
    return {
        "acknowledged": {
            key: {
                "severity": "high",
                "module": "modulo-falso",
                "url": "https://github.com/advisories/GHSA-zzzz-zzzz-zzzz",
            }
            for key in keys
        }
    }


def fake_advisory(severity: str = "high") -> dict:
    return {
        "severity": severity,
        "module_name": "modulo-falso",
        "title": f"advisory de teste ({severity})",
        "url": "https://github.com/advisories/GHSA-zzzz-zzzz-zzzz",
    }


def severity_counts(advisories: dict) -> dict:
    """Contadores por severidade no formato `metadata.vulnerabilities` do pnpm.

    Registros não-objeto ou com severidade inválida não são contados: são
    exatamente os payloads adversariais que o gate deve rejeitar.
    """
    counts = {severity: 0 for severity in KNOWN_SEVERITIES}
    for advisory in advisories.values():
        if not isinstance(advisory, dict):
            continue
        severity = advisory.get("severity")
        if isinstance(severity, str) and severity in counts:
            counts[severity] += 1
    return counts


def audit_stdout(advisories: dict, metadata=None) -> str:
    """JSON de `pnpm audit --json` com metadata reconciliado por padrão.

    Passe `metadata` explicitamente para simular payload inconsistente.
    """
    if metadata is None:
        metadata = {"vulnerabilities": severity_counts(advisories)}
    return json.dumps(
        {"actions": [], "advisories": advisories, "muted": [], "metadata": metadata}
    )


class TestAuditGateStrictness(unittest.TestCase):
    """Falha operacional/saída inválida do `pnpm audit` nunca vira PASS."""

    def test_command_failure_with_empty_output_fails(self):
        # `pnpm audit` estourou (registry fora/auth/shim ausente): stdout
        # vazio (ou só espaços) com rc != 0 precisa falhar, não passar.
        with self.subTest(case="stdout vazio"):
            self.assertEqual(
                run_audit_gate("", returncode=1, stderr="ERR_PNPM_FETCH_401 registry"),
                1,
            )
        with self.subTest(case="stdout só whitespace"):
            self.assertEqual(
                run_audit_gate("  \n\t ", returncode=2, stderr="ERR_PNPM_FETCH_502"),
                1,
            )

    def test_malformed_json_fails(self):
        with self.subTest(case="HTML de proxy"):
            self.assertEqual(
                run_audit_gate("<html><body>502 Bad Gateway</body></html>", returncode=2),
                1,
            )
        with self.subTest(case="JSON truncado"):
            self.assertEqual(run_audit_gate('{"advisories":', returncode=1), 1)

    def test_structurally_invalid_json_fails(self):
        with self.subTest(case="top-level não-objeto"):
            self.assertEqual(run_audit_gate('["advisories", {}]', returncode=0), 1)
        with self.subTest(case="sem chave advisories"):
            self.assertEqual(
                run_audit_gate(json.dumps({"metadata": {"vulnerabilities": {}}}), returncode=0),
                1,
            )
        with self.subTest(case="advisories do tipo errado"):
            self.assertEqual(
                run_audit_gate(json.dumps({"advisories": ["não é dict"]}), returncode=0),
                1,
            )

    def test_valid_audit_with_new_advisory_fails(self):
        # pnpm audit sai != 0 quando reporta vulnerabilidades: o gate ainda
        # avalia o JSON e falha em high/critical NOVO fora da baseline.
        ack = acknowledged_keys()
        novo_alto = "99000001"
        novo_critico = "99000002"
        self.assertNotIn(novo_alto, ack)
        self.assertNotIn(novo_critico, ack)
        stdout = audit_stdout(
            {
                novo_alto: fake_advisory("high"),
                novo_critico: fake_advisory("critical"),
            }
        )
        self.assertEqual(run_audit_gate(stdout, returncode=1), 1)

    def test_valid_audit_with_acknowledged_findings_passes(self):
        # Exit code != 0 legítimo (pnpm reporta advisories) + todo
        # high/critical reconhecido na baseline => PASS, sem mutar nada.
        ack_keys = acknowledged_keys()
        # Fixture sintética para exercitar "reconhecido" mesmo com a baseline
        # real vazia (nenhum high/critical reconhecido hoje).
        synthetic = ["70000001", "70000002"]
        baseline = synthetic_acknowledged(synthetic)
        acknowledged_payload = {key: fake_advisory("high") for key in synthetic}
        if ack_keys:
            baseline = synthetic_acknowledged([*synthetic, *ack_keys])
            acknowledged_payload.update({key: fake_advisory("high") for key in ack_keys})
        # moderate fora da baseline é report-only (threshold high): PASS.
        moderate_only = {"88888888": fake_advisory("moderate")}
        with self.subTest(case="só reconhecidos, rc=1"):
            self.assertEqual(
                run_audit_gate(audit_stdout(acknowledged_payload), returncode=1, baseline=baseline), 0
            )
        with self.subTest(case="moderate fora da baseline, rc=1"):
            self.assertEqual(run_audit_gate(audit_stdout(moderate_only), returncode=1), 0)
        with self.subTest(case="audit limpo, rc=0"):
            self.assertEqual(run_audit_gate(audit_stdout({}), returncode=0), 0)

    # --- Finding do reviewer: validação estrutural fail-closed por advisory ---

    def test_advisory_missing_severity_fails(self):
        # Payload adversarial do reviewer: {"999":{"title":"x"}} com metadata
        # contando high:1. Severidade ausente NÃO é blocking, então o gate
        # antigo ignorava o registro e PASSava. Agora FALHA fechado.
        payload = {"999": {"title": "x"}}
        metadata = {"vulnerabilities": {**severity_counts(payload), "high": 1}}
        self.assertEqual(run_audit_gate(audit_stdout(payload, metadata=metadata)), 1)

    def test_advisory_unknown_severity_fails(self):
        # Severidade fora do enum conhecido (qualquer nível, não só
        # high/critical): sem veredito possível => FALHA.
        for bogus in ("banana", "HIGH", "Critical", "", " ", "sev1"):
            with self.subTest(severity=bogus):
                payload = {"777": fake_advisory(bogus)}
                metadata = {"vulnerabilities": severity_counts({})}
                self.assertEqual(
                    run_audit_gate(audit_stdout(payload, metadata=metadata)), 1
                )

    def test_advisory_nonstring_severity_fails(self):
        for bogus in (5, None, ["high"], {"level": "high"}):
            with self.subTest(severity=repr(bogus)):
                payload = {"778": fake_advisory()}
                payload["778"]["severity"] = bogus
                self.assertEqual(run_audit_gate(audit_stdout(payload)), 1)

    def test_advisory_record_not_object_fails(self):
        for bogus in ("não é dict", 42, ["severity"], None):
            with self.subTest(record=repr(bogus)):
                self.assertEqual(
                    run_audit_gate(audit_stdout({"779": bogus})), 1
                )

    def test_vulnerabilities_count_mismatch_fails(self):
        # Contadores de metadata precisam reconciliar com os registros.
        ack = acknowledged_keys()
        keys = [*ack, "70000010"] if ack else ["70000010"]
        baseline = synthetic_acknowledged(keys)
        payload = {k: fake_advisory("high") for k in keys}
        observed = severity_counts(payload)
        high_observed = observed["high"]
        with self.subTest(case="contador acima do reportado"):
            inflated = dict(observed, high=high_observed + 1)
            self.assertEqual(
                run_audit_gate(
                    audit_stdout(payload, metadata={"vulnerabilities": inflated}),
                    baseline=baseline,
                ),
                1,
            )
        with self.subTest(case="contador abaixo do reportado"):
            deflated = dict(observed, high=high_observed - 1)
            self.assertEqual(
                run_audit_gate(
                    audit_stdout(payload, metadata={"vulnerabilities": deflated}),
                    baseline=baseline,
                ),
                1,
            )
        with self.subTest(case="moderate fantasma sem registro"):
            phantom = dict(observed, moderate=observed["moderate"] + 1)
            self.assertEqual(
                run_audit_gate(
                    audit_stdout(payload, metadata={"vulnerabilities": phantom}),
                    baseline=baseline,
                ),
                1,
            )

    def test_vulnerabilities_missing_or_invalid_fails(self):
        payload = {"780": fake_advisory("moderate")}
        valid = severity_counts(payload)
        cases = {
            "metadata ausente": {"metadata": {}},
            "metadata não-objeto": {"metadata": "vulnerabilities"},
            "vulnerabilities ausente": {"metadata": {"dependencies": 1}},
            "vulnerabilities não-objeto": {"metadata": {"vulnerabilities": [1, 2]}},
            "campo do enum faltando": {
                "metadata": {"vulnerabilities": {k: v for k, v in valid.items() if k != "critical"}}
            },
            "contador negativo": {"metadata": {"vulnerabilities": dict(valid, high=-1)}},
            "contador string": {"metadata": {"vulnerabilities": dict(valid, low="0")}},
            "contador float": {"metadata": {"vulnerabilities": dict(valid, low=0.0)}},
            "contador bool": {"metadata": {"vulnerabilities": dict(valid, low=True)}},
            "campo desconhecido": {
                "metadata": {"vulnerabilities": dict(valid, total=sum(valid.values()))}
            },
        }
        for case, metadata in cases.items():
            with self.subTest(case=case):
                self.assertEqual(run_audit_gate(audit_stdout(payload, metadata=metadata)), 1)

    def test_valid_full_enum_with_acknowledged_findings_passes(self):
        # Payload completo e consistente: info/low/moderate report-only +
        # high/critical reconhecidos na baseline, contadores reconciliados
        # e rc != 0 legítimo => PASS (exit code não decide o gate).
        ack = acknowledged_keys()
        high_keys = [*ack, "70000010"] if ack else ["70000010"]
        baseline = synthetic_acknowledged(high_keys)
        payload = {
            **{k: fake_advisory("high") for k in high_keys},
            "70000001": fake_advisory("info"),
            "70000002": fake_advisory("low"),
            "70000003": fake_advisory("moderate"),
        }
        self.assertEqual(
            run_audit_gate(audit_stdout(payload), returncode=1, baseline=baseline), 0
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
