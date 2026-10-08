#!/usr/bin/env python3
"""Gate P5: pilot-evidence.yaml cobre os 35 IDs G01-G18/F01-F17 sem UNKNOWN.

Segue o padrão de tests/contracts (unittest stdlib + PyYAML, somente leitura).
"""
from __future__ import annotations

from pathlib import Path
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[2]
YAML_PATH = ROOT / "tests" / "release" / "pilot-evidence.yaml"

EXPECTED_IDS = [f"G{i:02d}" for i in range(1, 19)] + [f"F{i:02d}" for i in range(1, 18)]
REQUIRED_KEYS = {"id", "status", "test", "environment", "evidence", "last_run", "owner", "limitations"}
VALID_STATUS = {"PASS", "BLOCKED"}


def load_entries() -> list[dict]:
    with open(YAML_PATH, encoding="utf-8") as fh:
        data = yaml.safe_load(fh)
    assert isinstance(data, list), "pilot-evidence.yaml deve ser uma lista"
    return data


class TestPilotEvidence(unittest.TestCase):
    def test_all_35_ids_mapped_exactly_once(self) -> None:
        ids = [e["id"] for e in load_entries()]
        self.assertEqual(sorted(ids), sorted(EXPECTED_IDS))
        self.assertEqual(len(set(ids)), 35)

    def test_no_unknown_or_unmapped(self) -> None:
        for e in load_entries():
            self.assertIn(e.get("status"), VALID_STATUS, f"{e.get('id')}: status inválido")
            for k, v in e.items():
                if k == "test" and e["status"] == "PASS":
                    continue
                norm = str(v).strip().upper()
                # UNKNOWN-effect é termo legítimo de domínio (F03/F17); o que é
                # proibido é UNKNOWN/NOT_MAPPED como veredito ou placeholder.
                self.assertNotIn(norm, {"UNKNOWN", "NOT_MAPPED", "N/A", "TBD", ""},
                                 f"{e['id']}.{k}: placeholder indevido")

    def test_required_keys_present(self) -> None:
        for e in load_entries():
            missing = REQUIRED_KEYS - set(e.keys())
            self.assertFalse(missing, f"{e.get('id')}: chaves ausentes {missing}")
            for k in REQUIRED_KEYS:
                self.assertTrue(str(e[k]).strip(), f"{e.get('id')}: {k} vazio")

    def test_blocked_has_owner_and_unblock(self) -> None:
        for e in load_entries():
            if e["status"] == "BLOCKED":
                self.assertEqual(e["owner"], "operator", f"{e['id']}: BLOCKED sem dono operator")
                self.assertTrue(str(e.get("unblock", "")).strip(), f"{e['id']}: BLOCKED sem condição de desbloqueio")

    def test_pass_points_at_test_and_evidence(self) -> None:
        for e in load_entries():
            if e["status"] == "PASS":
                self.assertIn("apps/api/test/", e["test"], f"{e['id']}: PASS sem teste citado")


if __name__ == "__main__":
    unittest.main()
