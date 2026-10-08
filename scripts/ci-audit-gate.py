#!/usr/bin/env python3
"""P6 dependency-audit gate (CODER-P6A).

Roda `pnpm audit --json` e falha SOMENTE em advisory high/critical que NÃO
esteja reconhecido em `tests/security/audit-baseline.json`. Moderate/low são
report-only (contados no log). Entradas da baseline que sumirem (upstream
corrigiu) viram aviso STALE — sem falhar — pedindo limpeza da baseline.

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
    try:
        data = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError:
        print("AUDIT-GATE FAIL: `pnpm audit --json` não parseável")
        print((proc.stdout or "")[:2000])
        print((proc.stderr or "")[:2000])
        return 1

    advisories = data.get("advisories", {})
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
