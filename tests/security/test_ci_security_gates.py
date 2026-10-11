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

Cada cenário negativo asserta a MENSAGEM do ramo pretendido na saída do
gate, além do exit code: sem essa assertiva, um fixture que caia no ramo
errado ainda passaria — foi o finding P2 do review do PR #38, em que os
casos de `metadata` eram envelopados duas vezes (`metadata.metadata`) e
falhavam todos pelo motivo "vulnerabilities ausente". As fixtures usam o
shape real do `pnpm audit --json`: `audit_stdout(..., metadata=X)` recebe
o VALOR da chave `metadata`, nunca um envelope aninhado.
"""
from __future__ import annotations

import importlib.util
import io
import json
import subprocess
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


def load_audit_gate():
    spec = importlib.util.spec_from_file_location("ci_audit_gate_under_test", AUDIT_GATE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_audit_gate_capture(
    stdout: str, returncode: int = 0, stderr: str = ""
) -> tuple[int, str]:
    """Roda `main()` do gate com `pnpm audit` mockado; devolve (rc, saída).

    A saída é capturada porque os cenários negativos assertam a MENSAGEM do
    ramo pretendido: sem ela, um fixture que falhe pelo motivo errado ainda
    passaria pelo exit code (finding P2 do review do PR #38).
    """
    gate = load_audit_gate()
    proc = subprocess.CompletedProcess(
        args="pnpm audit --json", returncode=returncode, stdout=stdout, stderr=stderr
    )
    captured = io.StringIO()
    with mock.patch.object(gate.subprocess, "run", return_value=proc):
        with redirect_stdout(captured):
            exit_code = gate.main()
    return exit_code, captured.getvalue()


def acknowledged_keys() -> list[str]:
    baseline = json.loads(AUDIT_BASELINE.read_text(encoding="utf-8"))
    ack = baseline.get("acknowledged", {})
    assert ack, "baseline de audit sem nenhum advisory reconhecido"
    return sorted(ack)


def fake_advisory(severity: str = "high") -> dict:
    return {
        "severity": severity,
        "module_name": "modulo-falso",
        "title": f"advisory de teste ({severity})",
        "url": "https://github.com/advisories/GHSA-zzzz-zzzz-zzzz",
    }


def acknowledged_advisories() -> dict:
    """Um advisory por entrada da baseline, com a severidade espelhada.

    Formato de registro do `pnpm audit --json`; as chaves são os ids de
    advisory reconhecidos, então o gate não pode falhar por "novo" — e o
    payload cobre high e critical no caminho de PASS.
    """
    baseline = json.loads(AUDIT_BASELINE.read_text(encoding="utf-8"))
    return {
        key: fake_advisory(entry["severity"])
        for key, entry in baseline.get("acknowledged", {}).items()
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


# Sentinela default: contadores reconciliados a partir dos advisories.
_AUTO_METADATA = object()
# Sentinela: envelope SEM a chave `metadata` (payload incompleto de verdade).
_OMIT_METADATA = object()


def audit_stdout(advisories: dict, metadata=_AUTO_METADATA) -> str:
    """JSON de `pnpm audit --json` no shape REAL do registry.

    `metadata` é o VALOR da chave `metadata` do envelope — nunca um
    envelope aninhado (`{"metadata": ...}`): com `metadata.metadata` o gate
    falharia no ramo errado ("vulnerabilities ausente") e o teste passaria
    sem exercitar o alvo (finding P2 do review do PR #38). Omitindo o
    argumento, os contadores são reconciliados a partir dos advisories;
    `_OMIT_METADATA` remove a chave do envelope (payload incompleto).
    """
    envelope = {"actions": [], "advisories": advisories, "muted": []}
    if metadata is _AUTO_METADATA:
        envelope["metadata"] = {"vulnerabilities": severity_counts(advisories)}
    elif metadata is not _OMIT_METADATA:
        envelope["metadata"] = metadata
    return json.dumps(envelope)


class TestAuditGateStrictness(unittest.TestCase):
    """Falha operacional/saída inválida do `pnpm audit` nunca vira PASS.

    Todo cenário negativo asserta exit 1 E o marcador do RAMO pretendido na
    saída do gate; todo positivo asserta `AUDIT-GATE PASS`. Assim nenhum
    teste passa sem entrar no ramo que diz exercitar (finding P2 do review
    do PR #38).
    """

    def assert_fails_closed(
        self, stdout: str, reason: str, returncode: int = 0, stderr: str = ""
    ) -> str:
        """Exige falha fechada (exit 1) contendo o marcador `reason`."""
        exit_code, output = run_audit_gate_capture(
            stdout, returncode=returncode, stderr=stderr
        )
        self.assertEqual(
            exit_code, 1, f"gate deveria falhar fechado; saída:\n{output}"
        )
        self.assertIn(
            reason, output, f"falha fora do ramo pretendido; saída:\n{output}"
        )
        return output

    def assert_gate_passes(self, stdout: str, returncode: int = 0) -> str:
        exit_code, output = run_audit_gate_capture(stdout, returncode=returncode)
        self.assertEqual(exit_code, 0, f"gate deveria passar; saída:\n{output}")
        self.assertIn("AUDIT-GATE PASS", output)
        return output

    # --- Falha operacional (erro HTTP do registry/auth/shim) ---

    def test_command_failure_with_empty_output_fails(self):
        # Erro HTTP do registry (401/502), auth ou shim ausente: stdout
        # vazio (ou só espaços) com rc != 0 precisa falhar, não passar.
        with self.subTest(case="registry 401, stdout vazio"):
            self.assert_fails_closed(
                "",
                "falhou sem saída (erro operacional?)",
                returncode=1,
                stderr="ERR_PNPM_FETCH_401 registry",
            )
        with self.subTest(case="registry 502, stdout só whitespace"):
            self.assert_fails_closed(
                "  \n\t ",
                "falhou sem saída (erro operacional?)",
                returncode=2,
                stderr="ERR_PNPM_FETCH_502",
            )

    def test_malformed_json_fails(self):
        with self.subTest(case="HTML de proxy"):
            self.assert_fails_closed(
                "<html><body>502 Bad Gateway</body></html>",
                "não parseável",
                returncode=2,
            )
        with self.subTest(case="JSON truncado"):
            self.assert_fails_closed('{"advisories":', "não parseável", returncode=1)

    def test_structurally_invalid_json_fails(self):
        reason = "JSON sem `advisories` válido (saída inesperada)"
        with self.subTest(case="top-level não-objeto"):
            self.assert_fails_closed('["advisories", {}]', reason, returncode=0)
        with self.subTest(case="sem chave advisories"):
            self.assert_fails_closed(
                json.dumps({"metadata": {"vulnerabilities": {}}}), reason, returncode=0
            )
        with self.subTest(case="advisories do tipo errado"):
            self.assert_fails_closed(
                json.dumps({"advisories": ["não é dict"]}), reason, returncode=0
            )
        with self.subTest(case="objeto vazio (audit sem conteúdo)"):
            self.assert_fails_closed("{}", reason, returncode=0)
        with self.subTest(case="JSON de erro HTTP do registry"):
            self.assert_fails_closed(
                json.dumps({"error": {"code": "E502", "summary": "registry unavailable"}}),
                reason,
                returncode=1,
            )

    # --- Payload válido: veredito pelo CONTEÚDO, não pelo exit code ---

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
        self.assert_fails_closed(
            stdout, "high/critical NOVOS fora da baseline", returncode=1
        )

    def test_valid_audit_with_acknowledged_findings_passes(self):
        # Exit code != 0 legítimo (pnpm reporta advisories) + todo
        # high/critical reconhecido na baseline => PASS, sem mutar nada.
        # moderate fora da baseline é report-only (threshold high): PASS.
        moderate_only = {"88888888": fake_advisory("moderate")}
        with self.subTest(case="só reconhecidos, rc=1"):
            self.assert_gate_passes(
                audit_stdout(acknowledged_advisories()), returncode=1
            )
        with self.subTest(case="moderate fora da baseline, rc=1"):
            self.assert_gate_passes(audit_stdout(moderate_only), returncode=1)
        with self.subTest(case="audit limpo, rc=0"):
            self.assert_gate_passes(audit_stdout({}), returncode=0)

    # --- Finding do reviewer: validação estrutural fail-closed por advisory ---

    def test_advisory_missing_severity_fails(self):
        # Payload adversarial do reviewer: {"999":{"title":"x"}} com metadata
        # reconciliado (todos zero). Severidade ausente NÃO é blocking, então
        # o gate antigo ignorava o registro e PASSava; agora FALHA fechado.
        # A severidade é a ÚNICA inconsistência do payload: se o ramo de
        # severidade ausente fosse removido, os contadores reconciliariam e o
        # gate passaria — o teste exige o ramo, não só o exit code.
        payload = {"999": {"title": "x"}}
        self.assertEqual(severity_counts(payload)["high"], 0)
        self.assert_fails_closed(
            audit_stdout(payload), "advisory [999] sem severidade válida"
        )

    def test_advisory_unknown_severity_fails(self):
        # Severidade fora do enum conhecido (qualquer nível, não só
        # high/critical): sem veredito possível => FALHA.
        for bogus in ("banana", "HIGH", "Critical", "sev1"):
            with self.subTest(severity=bogus):
                self.assert_fails_closed(
                    audit_stdout({"777": fake_advisory(bogus)}),
                    "advisory [777] com severidade desconhecida",
                )

    def test_advisory_empty_or_nonstring_severity_fails(self):
        for bogus in ("", " ", 5, None, ["high"], {"level": "high"}):
            with self.subTest(severity=repr(bogus)):
                payload = {"778": fake_advisory()}
                payload["778"]["severity"] = bogus
                self.assert_fails_closed(
                    audit_stdout(payload), "advisory [778] sem severidade válida"
                )

    def test_advisory_record_not_object_fails(self):
        for bogus in ("não é dict", 42, ["severity"], None):
            with self.subTest(record=repr(bogus)):
                self.assert_fails_closed(
                    audit_stdout({"779": bogus}), "advisory [779] não é objeto"
                )

    def test_fixture_helper_uses_real_audit_shape(self):
        # Guarda anti-regressão do finding P2: `audit_stdout` não pode
        # aninhar metadata duas vezes (`metadata.metadata`). Com o envelope
        # duplicado o gate falha no ramo errado e o teste passaria sem
        # exercitar o alvo.
        payload = {"780": fake_advisory("moderate")}
        explicit = {"vulnerabilities": severity_counts(payload)}
        envelope = json.loads(audit_stdout(payload, metadata=explicit))
        self.assertEqual(envelope["metadata"], explicit)
        self.assertNotIn("metadata", envelope["metadata"])
        auto = json.loads(audit_stdout(payload))
        self.assertEqual(auto["metadata"], {"vulnerabilities": severity_counts(payload)})
        self.assertEqual(
            sorted(auto["metadata"]["vulnerabilities"]), sorted(KNOWN_SEVERITIES)
        )

    def test_vulnerabilities_count_mismatch_fails(self):
        # Contadores de metadata precisam reconciliar com os registros:
        # divergência em qualquer severidade é inconsistência, não veredito.
        # Todos os advisories são reconhecidos, então sem a checagem de
        # reconciliação o gate PASSaria — o teste exige o ramo.
        payload = acknowledged_advisories()
        observed = severity_counts(payload)
        high_observed = observed["high"]
        with self.subTest(case="contador acima do reportado"):
            inflated = dict(observed, high=high_observed + 1)
            self.assert_fails_closed(
                audit_stdout(payload, metadata={"vulnerabilities": inflated}),
                "não reconcilia",
            )
        with self.subTest(case="contador abaixo do reportado"):
            deflated = dict(observed, high=high_observed - 1)
            self.assert_fails_closed(
                audit_stdout(payload, metadata={"vulnerabilities": deflated}),
                "não reconcilia",
            )
        with self.subTest(case="moderate fantasma sem registro"):
            phantom = dict(observed, moderate=observed["moderate"] + 1)
            self.assert_fails_closed(
                audit_stdout(payload, metadata={"vulnerabilities": phantom}),
                "não reconcilia",
            )

    def test_vulnerabilities_missing_or_invalid_fails(self):
        payload = {"780": fake_advisory("moderate")}
        valid = severity_counts(payload)
        missing_counter = {k: v for k, v in valid.items() if k != "critical"}
        # `metadata` aqui é o VALOR da chave do envelope — nunca um envelope
        # aninhado (finding P2): com `metadata.metadata` todos os casos
        # cairiam no ramo "vulnerabilities ausente" e passariam sem exercitar
        # o próprio alvo. Cada caso asserta a mensagem do ramo pretendido.
        cases = {
            "metadata ausente": (_OMIT_METADATA, "metadata ausente ou não-objeto"),
            "metadata não-objeto": ("vulnerabilities", "metadata ausente ou não-objeto"),
            "vulnerabilities ausente": (
                {"dependencies": 1},
                "metadata.vulnerabilities ausente ou não-objeto",
            ),
            "vulnerabilities não-objeto": (
                {"vulnerabilities": [1, 2]},
                "metadata.vulnerabilities ausente ou não-objeto",
            ),
            "campo do enum faltando": (
                {"vulnerabilities": missing_counter},
                "metadata.vulnerabilities sem contador 'critical'",
            ),
            "contador negativo": (
                {"vulnerabilities": dict(valid, high=-1)},
                "metadata.vulnerabilities.high inválido: -1",
            ),
            "contador string": (
                {"vulnerabilities": dict(valid, low="0")},
                "metadata.vulnerabilities.low inválido: '0'",
            ),
            "contador float": (
                {"vulnerabilities": dict(valid, low=0.0)},
                "metadata.vulnerabilities.low inválido: 0.0",
            ),
            "contador bool": (
                {"vulnerabilities": dict(valid, low=True)},
                "metadata.vulnerabilities.low inválido: True",
            ),
            "campo desconhecido": (
                {"vulnerabilities": dict(valid, total=sum(valid.values()))},
                "campos desconhecidos: total",
            ),
        }
        for case, (metadata, reason) in cases.items():
            with self.subTest(case=case):
                self.assert_fails_closed(audit_stdout(payload, metadata=metadata), reason)

    # --- Auditoria vazia/incompleta: dado ausente não vira PASS ---

    def test_empty_audit_without_metadata_fails(self):
        # Nenhum advisory e nenhum contador: payload incompleto de verdade.
        self.assert_fails_closed(
            audit_stdout({}, metadata=_OMIT_METADATA),
            "metadata ausente ou não-objeto",
        )

    def test_empty_vulnerabilities_object_fails(self):
        # `metadata.vulnerabilities` existe mas está VAZIO: faltam todos os
        # contadores obrigatórios do enum.
        payload = {"780": fake_advisory("moderate")}
        self.assert_fails_closed(
            audit_stdout(payload, metadata={"vulnerabilities": {}}),
            "metadata.vulnerabilities sem contador 'info'",
        )

    def test_valid_full_enum_with_acknowledged_findings_passes(self):
        # Payload completo e consistente: info/low/moderate report-only +
        # high/critical reconhecidos na baseline (severidade espelhada da
        # própria baseline, inclusive critical), contadores reconciliados e
        # rc != 0 legítimo => PASS (exit code não decide o gate).
        payload = {
            **acknowledged_advisories(),
            "70000001": fake_advisory("info"),
            "70000002": fake_advisory("low"),
            "70000003": fake_advisory("moderate"),
        }
        self.assert_gate_passes(audit_stdout(payload), returncode=1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
