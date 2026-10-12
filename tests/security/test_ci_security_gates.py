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

A baseline REAL de audit (`tests/security/audit-baseline.json`) fica VAZIA
de reconhecidos por intenção desde o upgrade OTel 2 — invariante afirmada
em `test_audit_baseline_empty_is_intentional`. Os casos que precisam de
high/critical reconhecido injetam uma baseline sintética via tempfile
(`run_audit_gate_capture(..., baseline=...)`), então a cobertura não
depende do estado da baseline real.
"""
from __future__ import annotations

import importlib.util
import io
import json
import re
import subprocess
import tempfile
import contextlib
import tomllib
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


@contextlib.contextmanager
def _baseline_patch(gate, baseline: dict):
    """Grava `baseline` em arquivo temporário e aponta BASELINE_PATH a ele."""
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "audit-baseline.json"
        path.write_text(json.dumps(baseline), encoding="utf-8")
        with mock.patch.object(gate, "BASELINE_PATH", path):
            yield


def run_audit_gate_capture(
    stdout: str, returncode: int = 0, stderr: str = "", baseline: dict | None = None
) -> tuple[int, str]:
    """Roda `main()` do gate com `pnpm audit` mockado; devolve (rc, saída).

    A saída é capturada porque os cenários negativos assertam a MENSAGEM do
    ramo pretendido: sem ela, um fixture que falhe pelo motivo errado ainda
    passaria pelo exit code (finding P2 do review do PR #38).

    `baseline`: quando passado, é gravado num arquivo temporário e injetado em
    `BASELINE_PATH` do módulo. Necessário para exercitar "high/critical
    reconhecido" agora que a baseline real fica VAZIA por intenção (upgrade
    OTel 2 removeu o último advisory reconhecido — gate PASS com 0 ack é
    estado válido, não exceção).
    """
    gate = load_audit_gate()
    proc = subprocess.CompletedProcess(
        args="pnpm audit --json", returncode=returncode, stdout=stdout, stderr=stderr
    )
    captured = io.StringIO()
    with contextlib.ExitStack() as stack:
        stack.enter_context(mock.patch.object(gate.subprocess, "run", return_value=proc))
        stack.enter_context(redirect_stdout(captured))
        if baseline is not None:
            stack.enter_context(_baseline_patch(gate, baseline))
        exit_code = gate.main()
    return exit_code, captured.getvalue()


def acknowledged_keys() -> list[str]:
    """Chaves reconhecidas na baseline REAL (pode ser vazia: desde o upgrade
    OTel 2 nenhum high/critical permanece reconhecido — o gate passa com 0)."""
    baseline = json.loads(AUDIT_BASELINE.read_text(encoding="utf-8"))
    ack = baseline.get("acknowledged", {})
    return sorted(ack)


def synthetic_acknowledged(keys, severities: dict | None = None) -> dict:
    """Baseline sintética reconhecendo `keys` — fixture para os casos que
    precisam de high/critical reconhecido independente da baseline real.

    `severities`: mapa opcional chave→severidade (default "high"); permite
    espelhar critical no caminho de PASS como a baseline real faria.
    """
    return {
        "acknowledged": {
            key: {
                "severity": (severities or {}).get(key, "high"),
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


def acknowledged_advisories(acknowledged: dict | None = None) -> dict:
    """Um advisory por entrada reconhecida, com a severidade espelhada.

    Formato de registro do `pnpm audit --json`; as chaves são os ids de
    advisory reconhecidos, então o gate não pode falhar por "novo" — e o
    payload cobre high e critical no caminho de PASS. Sem argumento, lê a
    baseline REAL (hoje VAZIA por intenção — upgrade OTel 2); passe
    `acknowledged` (ex.: a fixture sintética) para exercitar o caminho com
    reconhecidos independente do estado real.
    """
    if acknowledged is None:
        baseline = json.loads(AUDIT_BASELINE.read_text(encoding="utf-8"))
        acknowledged = baseline.get("acknowledged", {})
    return {
        key: fake_advisory(entry["severity"])
        for key, entry in acknowledged.items()
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
        self,
        stdout: str,
        reason: str,
        returncode: int = 0,
        stderr: str = "",
        baseline: dict | None = None,
    ) -> str:
        """Exige falha fechada (exit 1) contendo o marcador `reason`."""
        exit_code, output = run_audit_gate_capture(
            stdout, returncode=returncode, stderr=stderr, baseline=baseline
        )
        self.assertEqual(
            exit_code, 1, f"gate deveria falhar fechado; saída:\n{output}"
        )
        self.assertIn(
            reason, output, f"falha fora do ramo pretendido; saída:\n{output}"
        )
        return output

    def assert_gate_passes(
        self, stdout: str, returncode: int = 0, baseline: dict | None = None
    ) -> str:
        exit_code, output = run_audit_gate_capture(
            stdout, returncode=returncode, baseline=baseline
        )
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
        # A baseline real fica VAZIA por intenção (upgrade OTel 2): o caminho
        # "reconhecido" é exercitado por fixture sintética, somada ao que a
        # baseline real eventualmente reconhecer de novo.
        synthetic = ["70000001", "70000002"]
        keys = [*synthetic, *acknowledged_keys()]
        baseline = synthetic_acknowledged(keys)
        acknowledged_payload = {key: fake_advisory("high") for key in keys}
        # moderate fora da baseline é report-only (threshold high): PASS.
        moderate_only = {"88888888": fake_advisory("moderate")}
        with self.subTest(case="só reconhecidos, rc=1"):
            self.assert_gate_passes(
                audit_stdout(acknowledged_payload), returncode=1, baseline=baseline
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
        # Todos os advisories são reconhecidos (fixture sintética — a baseline
        # real fica VAZIA por intenção), então sem a checagem de
        # reconciliação o gate PASSaria — o teste exige o ramo.
        keys = ["70000010", *acknowledged_keys()]
        baseline = synthetic_acknowledged(keys)
        payload = {k: fake_advisory("high") for k in keys}
        observed = severity_counts(payload)
        high_observed = observed["high"]
        with self.subTest(case="contador acima do reportado"):
            inflated = dict(observed, high=high_observed + 1)
            self.assert_fails_closed(
                audit_stdout(payload, metadata={"vulnerabilities": inflated}),
                "não reconcilia",
                baseline=baseline,
            )
        with self.subTest(case="contador abaixo do reportado"):
            deflated = dict(observed, high=high_observed - 1)
            self.assert_fails_closed(
                audit_stdout(payload, metadata={"vulnerabilities": deflated}),
                "não reconcilia",
                baseline=baseline,
            )
        with self.subTest(case="moderate fantasma sem registro"):
            phantom = dict(observed, moderate=observed["moderate"] + 1)
            self.assert_fails_closed(
                audit_stdout(payload, metadata={"vulnerabilities": phantom}),
                "não reconcilia",
                baseline=baseline,
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
        # fixture sintética — a real está VAZIA por intenção —, inclusive
        # critical), contadores reconciliados e rc != 0 legítimo => PASS
        # (exit code não decide o gate).
        acknowledged = {"70000010": "high", "70000011": "critical"}
        baseline = synthetic_acknowledged(acknowledged, severities=acknowledged)
        payload = {
            **acknowledged_advisories(baseline["acknowledged"]),
            "70000001": fake_advisory("info"),
            "70000002": fake_advisory("low"),
            "70000003": fake_advisory("moderate"),
        }
        self.assert_gate_passes(
            audit_stdout(payload), returncode=1, baseline=baseline
        )


# --- G01 gitleaks surgical-allowlist guards (FIX-G01-GITLEAKS, per-rule AND) ---
#
# Triagem 2026-10-11: findings `generic-api-key` são fixtures sintéticas
# (commit histórico cde8ae0, linha 53 — cadeia G01 com hash sha256 antes de
# persistir e tráfego só em memória de teste; #40 7bd0023, linha 110 —
# constante de teste compartilhada). O job security-scans usa `fetch-depth:
# 0`, então o histórico continua varrido.
#
# Forma CORRETA (gitleaks 8.24.0, verificado empiricamente): allowlist
# POR-REGRA em [[rules]] id generic-api-key com `condition = "AND"` +
# regexes ANCORADAS (^...$) + paths exatos. `paths` no [allowlist] global
# exclui o ARQUIVO INTEIRO antes da detecção (semântica OR) e `condition =
# "AND"` no stanza global NÃO corrige (paths continuam pré-filtro) — por
# isso o [allowlist] global fica INTENCIONALMENTE vazio (só description).
# Um segredo real novo — mesmo nesses arquivos — continua falhando o scan.
# O fixture G01 vivo foi renomeado para forma não-credential
# (`WAHA_FIXTURE_TOKEN`, valor com espaços, inequivocamente sintético).
GITLEAKS_SURGICAL_REGEXES = (
    "^p13-fix1-asaas-secret$",
    "^w16-exposure-idem$",
    "^n3-arbitrary-resolve-key$",
    "^2FA/passkeys/organization$",
    "^g01-chain-secret$",
    "^integration-test-secret-0123456789$",
)
GITLEAKS_SURGICAL_PATHS = (
    "apps/api/test/g01-manual-reply-chain.integration.test.ts",
    "apps/api/test/security-altpath-evals.integration.test.ts",
)


def gitleaks_config() -> dict:
    with open(GITLEAKS_CONFIG, "rb") as fh:
        return tomllib.load(fh)


def gitleaks_rule_allowlist(rule_id: str = "generic-api-key") -> dict:
    config = gitleaks_config()
    for rule in config.get("rules", []):
        if rule.get("id") == rule_id:
            return rule["allowlist"]
    raise AssertionError(f"regra {rule_id!r} ausente em .gitleaks.toml")


class TestGitleaksSurgicalAllowlist(unittest.TestCase):
    def test_global_allowlist_has_no_paths_or_regexes(self):
        # (a) [allowlist] global INTENCIONALMENTE vazio: qualquer `paths`
        # aqui excluiria o arquivo inteiro antes da detecção (OR, gitleaks
        # 8.24.0) — a cobertura cirúrgica vive nos blocos [rules.allowlist].
        allowlist = gitleaks_config().get("allowlist", {})
        self.assertNotIn("paths", allowlist, "global [allowlist] não pode ter `paths` (exclui arquivo inteiro)")
        self.assertNotIn("regexes", allowlist, "global [allowlist] não pode ter `regexes` (use blocos por-regra)")

    def test_per_rule_allowlist_is_surgical_and(self):
        # (b) [[rules]] id generic-api-key com [rules.allowlist]
        # condition==AND, regexTarget==secret, regexes ancoradas ^...$ sem
        # wildcards não-escapados, paths de arquivo exato; defaults
        # preservados e entradas triadas presentes.
        allowlist = gitleaks_rule_allowlist("generic-api-key")
        self.assertEqual(allowlist.get("condition"), "AND")
        self.assertEqual(allowlist.get("regexTarget"), "secret")
        for pattern in allowlist.get("regexes", []):
            self.assertTrue(
                pattern.startswith("^") and pattern.endswith("$"),
                f"regex sem âncora exata ^...$: {pattern}",
            )
            self.assertNotIn(".*", pattern, f"regex com wildcard: {pattern}")
            self.assertNotIn(".+", pattern, f"regex com wildcard: {pattern}")
        for path in allowlist.get("paths", []):
            self.assertIn(
                "\\.",
                path,
                f"path sem extensão ancorada (risco de diretório inteiro): {path}",
            )
            self.assertFalse(
                path.endswith("/"), f"path de diretório inteiro: {path}"
            )
        config = GITLEAKS_CONFIG.read_text(encoding="utf-8")
        self.assertIn("useDefault = true", config)
        for value in GITLEAKS_SURGICAL_REGEXES:
            self.assertIn(value, allowlist.get("regexes", []))
        # Paths no TOML escapam o ponto e são ancorados ^...$; compara a
        # forma não-escapada e não-ancorada.
        stored = [
            p.replace("\\.", ".").removeprefix("^").removesuffix("$")
            for p in allowlist.get("paths", [])
        ]
        for path in GITLEAKS_SURGICAL_PATHS:
            self.assertIn(path, stored)

    def test_no_const_secret_form_in_triaged_tests(self):
        # (c) a forma `const X_SECRET =` sumiu dos arquivos triados: o
        # fixture vivo não se parece mais com credencial. O segundo arquivo
        # vive em branch irmã — skip documentado quando ausente aqui
        # (a allowlist por-regra já o cobre preemptivamente para o merge).
        for rel in GITLEAKS_SURGICAL_PATHS:
            target = ROOT / rel
            if not target.exists():
                self.skipTest(
                    f"{rel} ausente nesta branch (vive em branch irmã; "
                    "allowlist é preemptiva para o merge)"
                )
            text = target.read_text(encoding="utf-8")
            self.assertNotRegex(
                text,
                r"(?m)^\s*const\s+\w+_SECRET\s*=",
                f"forma credential-like ainda presente em {rel}",
            )

    def test_allowlist_does_not_cover_real_or_mutated_values(self):
        # (d) entradas são valores exatos ancorados (fullmatch): um segredo
        # realista novo e um derivado do valor antigo (sufixo fora da
        # âncora) NÃO são cobertos.
        allowlist = gitleaks_rule_allowlist("generic-api-key")
        compiled = [re.compile(p) for p in allowlist.get("regexes", [])]
        realistic = "sk-live-" + "a1b2c3d4e5f60718293a4b5c6d7e8f90"
        mutated = "g01-chain-secret-v2"
        for candidate in (realistic, mutated):
            for rx in compiled:
                self.assertIsNone(
                    rx.fullmatch(candidate),
                    f"allowlist cobre valor não-triado {candidate!r} via {rx.pattern!r}",
                )

    def test_security_scans_job_is_fail_closed(self):
        # (e) o job security-scans falha fechado: sem bypass silencioso.
        job = workflow()["jobs"]["security-scans"]
        dumped = yaml.safe_dump(job)
        self.assertIn("set -euo pipefail", dumped)
        self.assertNotIn("continue-on-error", dumped)
        self.assertNotIn("|| true", dumped)


if __name__ == "__main__":
    unittest.main(verbosity=2)
