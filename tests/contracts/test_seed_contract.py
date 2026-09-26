#!/usr/bin/env python3
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
SEED = (ROOT / 'db/seeds/001_pilot_baseline.sql').read_text(encoding='utf-8')

class SeedContractTests(unittest.TestCase):
    def test_seed_contains_no_live_secret_literal(self):
        self.assertIn('seed://not-a-real-secret/cinevision', SEED)
        for marker in ['sk_live_', 'Bearer ', 'api_key=', 'password=']:
            self.assertNotIn(marker, SEED)

    def test_only_confirmed_monthly_price_is_seeded(self):
        price_rows = re.findall(r"INSERT INTO catalog\.prices.*?VALUES\s*(.*?)\nON CONFLICT", SEED, re.S)
        self.assertEqual(len(price_rows), 1)
        self.assertIn(',3000,\'BRL\'', price_rows[0].replace(' ', ''))

    def test_additional_connection_is_recurring_and_price_not_invented(self):
        self.assertRegex(SEED, r"'additional-connection'.*?'RECURRING'.*?'CONNECTIONS'", re.S)
        # There must be no catalog.price row tied to the deterministic add-on ID.
        addon_id = '00000000-0000-4000-8000-000000000331'
        price_section = re.findall(r"INSERT INTO catalog\.prices.*?ON CONFLICT \(id\) DO NOTHING;", SEED, re.S)[0]
        self.assertNotIn(addon_id, price_section)

    def test_high_risk_outbound_flags_default_off(self):
        for key in ['ai.outbound.enabled','browser.provider.enabled','messaging.outbound.enabled']:
            pattern = rf"'{re.escape(key)}',false"
            self.assertRegex(SEED.replace(' ', ''), pattern)

if __name__ == '__main__':
    unittest.main(verbosity=2)
