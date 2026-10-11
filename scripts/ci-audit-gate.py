#!/usr/bin/env python3
"""P6 dependency-audit gate (CODER-P6A).

Roda `pnpm audit --json` e falha SOMENTE em advisory high/critical que NÃO
esteja reconhecido em `tests/security/audit-baseline.json`. Moderate/low são
report-only (contados no log). Entradas da baseline que sumirem (upstream
corrigiu) viram aviso STALE — sem falhar — pedindo limpeza da baseline.

Falha operacional NÃO gera PASS: saída vazia do `pnpm audit`, JSON inválido
ou JSON estruturalmente inválido/inconsistente falham fechado. A validação
estrutural é fail-closed em dois níveis:

1. Cada advisory precisa ser objeto com `severity` não-vazia do enum conhecido
   (`info`/`low`/`moderate`/`high`/`critical`) — auditamos TODAS as
   severidades reportadas, não só high/critical: advisory sem severidade (ou
   com severidade desconhecida) não pode ser decidido, então FALHA.
2. `metadata.vulnerabilities` precisa existir, com contador inteiro
   não-negativo para cada severidade do enum, sem campos desconhecidos, e os
   contadores precisam reconciliar com os registros de `advisories`
   (contrato verificado contra `pnpm audit --json` real, pnpm 10.15.0).

O exit code do `pnpm audit` (!= 0 quando há vulnerabilidades, inclusive as
reconhecidas) NÃO decide o gate — o veredito vem do conteúdo do JSON. O que
não pode virar PASS é dado ausente, desconhecido ou inconsistente.

Sem dependências além da stdlib. Sem segredos: só conta/identifica
advisories públicos do registry.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASELINE_PATH = ROOT / "tests" / "security" / "audit-baseline.json"
BLOCKING = {"high", "critical"}
# Enum de severidade do contrato JSON do `pnpm audit` (formato npm-audit):
# `metadata.vulnerabilities` usa exatamente estas chaves e cada advisory
# carrega `severity` dentro deste conjunto. Verificado contra saída real
# `pnpm audit --json` (pnpm 10.15.0) — contadores reconciliam 1:1 com os
# registros em `advisories`.
KNOWN_SEVERITIES = ("info", "low", "moderate", "high", "critical")


def audit_payload_problems(data: dict) -> list[str]:
    """Problemas estruturais do JSON do `pnpm audit` (vazio = consistente).

    Fail-closed: severidade ausente/vazia/desconhecida em qualquer advisory,
    `metadata`/`metadata.vulnerabilities` ausente, contador faltando, não-int
    (bool não conta), negativo, campo desconhecido ou contador divergente dos
    registros são inconsistência — sem veredito possível sobre dado ruim.
    """
    problems: list[str] = []

    advisories = data["advisories"]
    counts = {severity: 0 for severity in KNOWN_SEVERITIES}
    for key, advisory in advisories.items():
        if not isinstance(advisory, dict):
            problems.append(f"advisory [{key}] não é objeto")
            continue
        severity = advisory.get("severity")
        if not isinstance(severity, str) or not severity.strip():
            problems.append(
                f"advisory [{key}] sem severidade válida: {severity!r}"
            )
            continue
        if severity not in KNOWN_SEVERITIES:
            problems.append(
                f"advisory [{key}] com severidade desconhecida: {severity!r}"
            )
            continue
        counts[severity] += 1

    problems += _vulnerabilities_problems(data.get("metadata"), counts)
    return problems


def _vulnerabilities_problems(metadata, counts: dict) -> list[str]:
    """Valida `metadata.vulnerabilities` e reconcilia com os advisories."""
    if not isinstance(metadata, dict):
        return ["metadata ausente ou não-objeto"]
    vulnerabilities = metadata.get("vulnerabilities")
    if not isinstance(vulnerabilities, dict):
        return ["metadata.vulnerabilities ausente ou não-objeto"]

    problems = []
    unknown = sorted(k for k in vulnerabilities if k not in KNOWN_SEVERITIES)
    if unknown:
        problems.append(
            "metadata.vulnerabilities com campos desconhecidos: "
            + ", ".join(str(k) for k in unknown)
        )
    for severity in KNOWN_SEVERITIES:
        if severity not in vulnerabilities:
            problems.append(f"metadata.vulnerabilities sem contador '{severity}'")
            continue
        value = vulnerabilities[severity]
        # bool é subclasse de int em Python: `true` não é contador válido.
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            problems.append(
                f"metadata.vulnerabilities.{severity} inválido: {value!r}"
            )
            continue
        if value != counts[severity]:
            problems.append(
                f"metadata.vulnerabilities.{severity}={value} não reconcilia "
                f"com {counts[severity]} advisory(s) reportado(s)"
            )
    return problems


def main() -> int:
    try:
        baseline = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"AUDIT-GATE FAIL: baseline ilegível ({BASELINE_PATH}): {exc}")
        return 1
    acknowledged = baseline.get("acknowledged", {})

    # String fixa, sem interpolação: shell=True só para resolver o shim
    # `pnpm`/`pnpm.cmd` no PATH (necessário no Windows; no Linux o
    # action-setup já expõe `pnpm`).
    proc = subprocess.run(
        "pnpm audit --json",
        capture_output=True,
        text=True,
        cwd=ROOT,
        shell=True,
    )
    # O exit code de `pnpm audit` não decide o gate: ele sai != 0 quando há
    # vulnerabilidades — inclusive as já reconhecidas na baseline. O veredito
    # vem do JSON abaixo. O que NÃO pode virar PASS é falha operacional
    # (registry fora, auth, shim ausente): saída vazia ou JSON
    # estruturalmente inválido falham fechado.
    stdout = proc.stdout or ""
    stderr = proc.stderr or ""
    if not stdout.strip():
        print("AUDIT-GATE FAIL: `pnpm audit --json` falhou sem saída (erro operacional?)")
        print(stderr[:2000])
        return 1
    try:
        data = json.loads(stdout)
    except json.JSONDecodeError:
        print("AUDIT-GATE FAIL: `pnpm audit --json` não parseável")
        print(stdout[:2000])
        print(stderr[:2000])
        return 1
    if not isinstance(data, dict) or not isinstance(data.get("advisories"), dict):
        print("AUDIT-GATE FAIL: JSON sem `advisories` válido (saída inesperada)")
        print(stdout[:2000])
        print(stderr[:2000])
        return 1

    # Validação estrutural fail-closed ANTES de qualquer veredito: advisory
    # sem severidade conhecida (em qualquer nível, não só high/critical) ou
    # metadata.vulnerabilities ausente/inválido/inconsistente falham — nunca
    # passam por ausência de bloqueio.
    problems = audit_payload_problems(data)
    if problems:
        print(
            "AUDIT-GATE FAIL: JSON do `pnpm audit` estruturalmente "
            "inválido/inconsistente:"
        )
        for problem in problems:
            print(f"  - {problem}")
        print(stdout[:2000])
        print(stderr[:2000])
        return 1

    advisories = data["advisories"]
    blocking = {k: v for k, v in advisories.items() if v.get("severity") in BLOCKING}
    new = {k: v for k, v in blocking.items() if str(k) not in acknowledged}
    stale = [k for k in acknowledged if k not in blocking]

    print(
        f"audit: {len(advisories)} advisories totais; "
        f"{len(blocking)} high/critical; "
        f"{len(acknowledged)} reconhecidos na baseline."
    )
    for key in sorted(stale):
        entry = acknowledged[key]
        print(f"  STALE-BASELINE (resolvido upstream? remover): [{key}] {entry.get('url')}")

    if new:
        print("AUDIT-GATE FAIL: high/critical NOVOS fora da baseline:")
        for key in sorted(new):
            adv = new[key]
            print(f"  [{key}] {adv.get('severity')} {adv.get('module_name')} — {adv.get('title')}")
            print(f"      {adv.get('url')}")
        print("Triar e, se aceito com follow-up, registrar em tests/security/audit-baseline.json.")
        return 1

    print("AUDIT-GATE PASS: nenhum high/critical novo.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
