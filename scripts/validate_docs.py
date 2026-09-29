#!/usr/bin/env python3
"""Static documentation/contracts/migration integrity checks.

Event registry design (IPTV-EVENT-REGISTRY):
- The canonical public event IDs live in an explicit registry block inside
  docs/02-domain/event-model.md, delimited by
  <!-- event-registry:start --> / <!-- event-registry:end -->.
  Only IDs inside that block are authoritative. Incidental `.v1`-looking
  strings in prose/examples are NOT registry entries.
- SPEC operational event sections (headings containing "evento" or
  "core events" / "eventos usados") declare domain intent; every ID
  referenced there must exist in the registry (unknown-ref error).
- AsyncAPI authority is the channel keys under `channels:` (explicit
  contract names), not any incidental string in the YAML body. Channel
  keys must exist in the registry, and each message `name` must equal
  its channel key.
- Registry entries without any declared source (no SPEC operational
   section and no AsyncAPI channel) are rejected as invented/unreviewed.
- docs/15-implementation-baseline/04-event-catalog.md mirrors the same
   registry block; drift between the two files is an error, compared on
   full rows (public ID + class + status + declared sources +
   correspondence), not only on ID sets.
- Each registry row is parsed as a structured markdown table row and
   validated: unique public ID, class in {domain, observational},
   status in {planned/pre-implementation, implemented/active}, non-empty `Declared in`
   with honest tokens (`SPEC <NN-name>` mapping to a real directory
   under docs/04-specs, or `AsyncAPI`), and non-empty `Semantic
   correspondence`. Every claimed source is verified to actually
   contain the ID (SPEC operational section / AsyncAPI channel key).
- Machine checks verify presence and honesty of declaration, never
   semantic truth: whether the correspondence wording is actually
   correct still requires human review.
- Public ID `<domain>.<fact>.v<major>` decomposes to
  event_type=`<domain>.<fact>` + schema_version=`<major>` (integer).
  AsyncAPI envelope `schema_version` const must match the major.
"""

from __future__ import annotations

from pathlib import Path
import re
import sys

try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None

ROOT = Path(__file__).resolve().parents[1]
ERRORS: list[str] = []

EVENT_RE = re.compile(r"([a-z][a-z0-9_-]*\.[a-z][a-z0-9_.-]*\.v\d+)")
REGISTRY_START = "<!-- event-registry:start -->"
REGISTRY_END = "<!-- event-registry:end -->"

ALLOWED_CLASSES = {"domain", "observational"}
# Registry lifecycle: rows start as `planned/pre-implementation` and move to
# `implemented/active` once the runtime actually emits them (Wave 11 growth
# events are the first to make that transition).
ALLOWED_STATUSES = {"planned/pre-implementation", "implemented/active"}
ALLOWED_STATUS = "planned/pre-implementation"
SPEC_TOKEN_RE = re.compile(r"SPEC (\d{2}-[a-z0-9-]+)")
TABLE_SPLIT_RE = re.compile(r"(?<!\\)\|")


def error(message: str) -> None:
    ERRORS.append(message)


def split_table_row(line: str) -> list[str]:
    """Split a markdown table row on unescaped pipes only.

    Correspondence cells use escaped `\\|` for alternations (e.g.
    `requested\\|decided`); those must not split the row.
    """
    return [cell.strip() for cell in TABLE_SPLIT_RE.split(line.strip().strip("|"))]


def check_markdown_links() -> None:
    # Dependency/build outputs ship their own markdown with relative links
    # that are not part of this repository's documentation surface.
    skip_dirs = {"node_modules", ".next", "dist", ".turbo", "coverage"}
    for file in ROOT.rglob("*.md"):
        if any(part in skip_dirs for part in file.relative_to(ROOT).parts):
            continue
        text = file.read_text(encoding="utf-8", errors="ignore")
        for match in re.finditer(r"\[[^\]]+\]\(([^)]+)\)", text):
            target = match.group(1)
            if target.startswith(("http://", "https://", "mailto:", "#")):
                continue
            path_part = target.split("#", 1)[0]
            if not path_part:
                continue
            candidate = (file.parent / path_part).resolve()
            if not candidate.exists():
                error(f"broken markdown link: {file.relative_to(ROOT)} -> {target}")


def registry_block(path: Path) -> str | None:
    text = path.read_text(encoding="utf-8")
    if REGISTRY_START not in text or REGISTRY_END not in text:
        return None
    return text.split(REGISTRY_START, 1)[1].split(REGISTRY_END, 1)[0]


def parse_registry_rows(block: str, origin: str) -> tuple[dict[str, dict], list[str]]:
    """Parse structured registry table rows from a registry block.

    Pure function (no global state): returns rows keyed by public ID
    plus a list of error strings. Row dicts carry `public_id`,
    `klass`, `status`, `declared` (list of source tokens) and
    `correspondence`. The first table row is treated as the header.
    """
    rows: dict[str, dict] = {}
    errors: list[str] = []
    lines = [line for line in block.splitlines() if line.strip().startswith("|")]
    if len(lines) < 2:
        errors.append(f"event registry table missing in {origin}")
        return rows, errors
    for line in lines[1:]:
        cells = split_table_row(line)
        if len(cells) != 5:
            errors.append(f"registry row must have 5 columns in {origin}: {line.strip()}")
            continue
        if all(re.fullmatch(r":?-+:?", cell) for cell in cells):
            continue  # markdown separator row
        public_id = cells[0].strip("`").strip()
        if not EVENT_RE.fullmatch(public_id):
            errors.append(f"registry row without valid public ID in {origin}: {cells[0]}")
            continue
        if public_id in rows:
            errors.append(f"duplicate registry public ID in {origin}: {public_id}")
            continue
        klass = cells[1].strip("`").strip()
        if klass not in ALLOWED_CLASSES:
            errors.append(f"registry row with unknown class in {origin}: {public_id} -> {cells[1]!r}")
        status = cells[2].strip("`").strip()
        if status not in ALLOWED_STATUSES:
            errors.append(f"registry row with unexpected status in {origin}: {public_id} -> {cells[2]!r}")
        declared = [token.strip() for token in cells[3].split(";") if token.strip()]
        if not declared:
            errors.append(f"registry row without declared source in {origin}: {public_id}")
        for token in declared:
            if token == "AsyncAPI":
                continue
            token_match = SPEC_TOKEN_RE.fullmatch(token)
            if not token_match:
                errors.append(f"registry row with unknown declared source in {origin}: {public_id} -> {token!r}")
            elif not (ROOT / "docs/04-specs" / token_match.group(1)).is_dir():
                errors.append(f"registry row declares unknown SPEC in {origin}: {public_id} -> {token!r}")
        if not cells[4].strip():
            errors.append(f"registry row without semantic correspondence in {origin}: {public_id}")
        rows[public_id] = {
            "public_id": public_id,
            "klass": klass,
            "status": status,
            "declared": declared,
            "correspondence": cells[4].strip(),
        }
    return rows, errors


def parse_registry_file(path: Path) -> tuple[dict[str, dict], list[str]]:
    """Read a file and parse its registry block; missing block is an error."""
    origin = path.relative_to(ROOT).as_posix() if path.is_absolute() else path.as_posix()
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return {}, [f"event registry block missing in {origin}"]
    if REGISTRY_START not in text or REGISTRY_END not in text:
        return {}, [f"event registry block missing in {origin}"]
    block = text.split(REGISTRY_START, 1)[1].split(REGISTRY_END, 1)[0]
    return parse_registry_rows(block, origin)


def registry_fingerprint(row: dict) -> tuple:
    """Normalized full-row identity for mirror comparison."""
    declared = tuple(token.strip() for token in row["declared"])
    correspondence = re.sub(r"\s+", " ", row["correspondence"]).strip()
    return (row["klass"], row["status"], declared, correspondence)


def canonical_events() -> set[str]:
    """Only explicit IDs inside the registry block are canonical."""
    rows, errors = parse_registry_file(ROOT / "docs/02-domain/event-model.md")
    for issue in errors:
        error(issue)
    return set(rows)


def spec_operational_events(text: str) -> set[str]:
    """Extract .v1 refs only from operational event sections.

    An operational section starts at a markdown heading (levels 1-4)
    whose title contains 'evento' (covers Eventos/Eventos usados, any
    case) or 'core events', and runs until the next heading of level
    1-2 or end of file. Refs in narrative/flow/prose sections are
    intentionally ignored here.
    """
    refs: set[str] = set()
    heading_re = re.compile(r"^(#{1,4})\s+(.*)$", re.M)
    headings = list(heading_re.finditer(text))
    for i, match in enumerate(headings):
        level = len(match.group(1))
        title = match.group(2).strip().lower()
        is_operational = ("evento" in title) or ("core events" in title)
        if not is_operational:
            continue
        start = match.end()
        end = len(text)
        for nxt in headings[i + 1 :]:
            nxt_level = len(nxt.group(1))
            if nxt_level <= 2:
                end = nxt.start()
                break
        refs.update(EVENT_RE.findall(text[start:end]))
    return refs


def collect_spec_operational_refs() -> tuple[dict[str, set[str]], set[str]]:
    specs = ROOT / "docs/04-specs"
    per_file: dict[str, set[str]] = {}
    union: set[str] = set()
    for file in sorted(specs.rglob("*.md")):
        text = file.read_text(encoding="utf-8")
        refs = spec_operational_events(text)
        if refs:
            per_file[str(file.relative_to(ROOT))] = refs
            union.update(refs)
    return per_file, union


def check_spec_events(events: set[str]) -> tuple[dict[str, set[str]], set[str]]:
    per_file, union = collect_spec_operational_refs()
    for rel, refs in sorted(per_file.items()):
        for ref in sorted(refs - events):
            error(f"unknown event in SPEC operational section: {rel} -> {ref}")
    return per_file, union


def group_spec_refs_by_dir(per_file: dict[str, set[str]]) -> dict[str, set[str]]:
    """Group per-file operational refs by SPEC directory name (NN-name)."""
    by_dir: dict[str, set[str]] = {}
    for rel, refs in per_file.items():
        parts = Path(rel).parts
        dirname = parts[2] if len(parts) > 2 and parts[0] == "docs" and parts[1] == "04-specs" else rel
        by_dir.setdefault(dirname, set()).update(refs)
    return by_dir


def asyncapi_channels(document: object) -> set[str]:
    if not isinstance(document, dict):
        return set()
    channels = document.get("channels")
    if not isinstance(channels, dict):
        return set()
    return {
        key
        for key in channels
        if isinstance(key, str) and EVENT_RE.fullmatch(key)
    }


def check_yaml_contracts(events: set[str]) -> set[str]:
    if yaml is None:
        error("PyYAML not installed; contract YAML checks skipped")
        return set()

    openapi_path = ROOT / "docs/05-contracts/openapi/openapi.yaml"
    asyncapi_path = ROOT / "docs/05-contracts/asyncapi/asyncapi.yaml"

    openapi = yaml.safe_load(openapi_path.read_text(encoding="utf-8"))
    for ref in walk_refs(openapi):
        if not resolve_local_ref(openapi, ref):
            error(f"unresolved OpenAPI $ref: {ref}")

    operation_ids: list[str] = []
    for _, path_item in openapi.get("paths", {}).items():
        if not isinstance(path_item, dict):
            continue
        for _, operation in path_item.items():
            if isinstance(operation, dict) and isinstance(operation.get("operationId"), str):
                operation_ids.append(operation["operationId"])
    duplicates = sorted({op for op in operation_ids if operation_ids.count(op) > 1})
    if duplicates:
        error(f"duplicate OpenAPI operationId(s): {duplicates}")

    asyncapi = yaml.safe_load(asyncapi_path.read_text(encoding="utf-8"))
    channels = asyncapi_channels(asyncapi)
    for ref in sorted(channels - events):
        error(f"AsyncAPI channel absent from Event Model registry: {ref}")

    # Envelope identity: message name must equal its channel key, and the
    # envelope schema_version const must match the .v<major> suffix.
    envelope_const: int | None = None
    try:
        envelope_const = asyncapi["components"]["schemas"]["EventEnvelopeBase"]["properties"]["schema_version"].get("const")
    except (KeyError, TypeError, AttributeError):
        envelope_const = None
    messages = asyncapi.get("components", {}).get("messages", {}) if isinstance(asyncapi.get("components"), dict) else {}
    channel_to_message: dict[str, str] = {}
    if isinstance(asyncapi.get("channels"), dict):
        for channel, spec in asyncapi["channels"].items():
            try:
                ref = spec["publish"]["message"]["$ref"]
            except (KeyError, TypeError):
                continue
            m = re.fullmatch(r"#/components/messages/(.+)", ref or "")
            if m:
                channel_to_message[channel] = m.group(1)
    if isinstance(messages, dict):
        for channel, msg_name in sorted(channel_to_message.items()):
            payload = messages.get(msg_name)
            name = payload.get("name") if isinstance(payload, dict) else None
            if name != channel:
                error(f"AsyncAPI message name drift: channel {channel} -> message {msg_name} declares name {name!r}")
    if envelope_const is not None:
        for channel in sorted(channels):
            major = int(channel.rsplit(".v", 1)[1])
            if major != envelope_const:
                error(f"AsyncAPI envelope mismatch: {channel} major v{major} != schema_version const {envelope_const}")
    return channels


def verify_declared_claims(
    rows: dict[str, dict],
    spec_by_dir: dict[str, set[str]],
    channels: set[str],
) -> list[str]:
    """Verify every claimed source actually contains the ID.

    Pure function: a row claiming `SPEC <NN-name>` must have its ID in
    that SPEC directory's operational sections; a row claiming
    `AsyncAPI` must have its ID among the AsyncAPI channel keys.
    """
    issues: list[str] = []
    for public_id in sorted(rows):
        for token in rows[public_id]["declared"]:
            if token == "AsyncAPI":
                if public_id not in channels:
                    issues.append(f"registry declares AsyncAPI source absent from channels: {public_id}")
                continue
            token_match = SPEC_TOKEN_RE.fullmatch(token)
            dirname = token_match.group(1) if token_match else None
            if dirname is None or public_id not in spec_by_dir.get(dirname, set()):
                issues.append(f"registry declares {token} without operational ref: {public_id}")
    return issues


def check_registry_sources(
    rows: dict[str, dict],
    spec_by_dir: dict[str, set[str]],
    spec_union: set[str],
    channels: set[str],
) -> None:
    """Every registry entry must have a declared source.

    Prevents invented/unreviewed names silently living in the registry.
    Per-claim honesty is verified first; the legacy no-source rule is
    kept so an entry present nowhere is still rejected.
    """
    for issue in verify_declared_claims(rows, spec_by_dir, channels):
        error(issue)
    declared = spec_union | channels
    for ref in sorted(set(rows) - declared):
        error(f"registry event without declared source (SPEC operational section or AsyncAPI channel): {ref}")


def diff_registry_rows(model_rows: dict[str, dict], baseline_rows: dict[str, dict]) -> list[str]:
    """Compare full registry rows (not only ID sets). Pure function."""
    issues: list[str] = []
    for ref in sorted(set(model_rows) - set(baseline_rows)):
        issues.append(f"baseline catalog missing registry event: {ref}")
    for ref in sorted(set(baseline_rows) - set(model_rows)):
        issues.append(f"baseline catalog has extra event absent from Event Model registry: {ref}")
    field_names = ("class", "status", "declared", "correspondence")
    for ref in sorted(set(model_rows) & set(baseline_rows)):
        fingerprint_model = registry_fingerprint(model_rows[ref])
        fingerprint_baseline = registry_fingerprint(baseline_rows[ref])
        if fingerprint_model != fingerprint_baseline:
            differing = sorted(name for name, left, right in zip(field_names, fingerprint_model, fingerprint_baseline) if left != right)
            issues.append(f"baseline registry metadata drift for {ref}: differs in {', '.join(differing)}")
    return issues


def check_baseline_registry_matches(rows: dict[str, dict]) -> None:
    baseline = ROOT / "docs/15-implementation-baseline/04-event-catalog.md"
    baseline_rows, errors = parse_registry_file(baseline)
    for issue in errors:
        error(issue)
    if not baseline_rows and errors:
        return
    for issue in diff_registry_rows(rows, baseline_rows):
        error(issue)


def resolve_local_ref(document: object, ref: str) -> bool:
    if not ref.startswith("#/"):
        return True
    current = document
    try:
        for part in ref[2:].split("/"):
            part = part.replace("~1", "/").replace("~0", "~")
            current = current[part]  # type: ignore[index]
        return True
    except (KeyError, TypeError, IndexError):
        return False


def walk_refs(value: object):
    if isinstance(value, dict):
        for key, item in value.items():
            if key == "$ref" and isinstance(item, str):
                yield item
            yield from walk_refs(item)
    elif isinstance(value, list):
        for item in value:
            yield from walk_refs(item)


def check_sql_migrations() -> None:
    migration_dir = ROOT / "db/migrations"
    files = sorted(migration_dir.glob("*.sql"))
    created_tables: set[str] = set()
    referenced_tables: list[tuple[Path, str]] = []
    last_prefix = -1

    for file in files:
        text = file.read_text(encoding="utf-8")
        without_comments = re.sub(r"--.*", "", text)
        without_literals = re.sub(r"'(?:''|[^'])*'", "''", without_comments)
        if without_literals.count("(") != without_literals.count(")"):
            error(f"unbalanced parentheses in migration: {file.relative_to(ROOT)}")
        if not re.search(r"\bBEGIN\s*;", text, re.I):
            error(f"migration missing BEGIN: {file.relative_to(ROOT)}")
        if not re.search(r"\bCOMMIT\s*;", text, re.I):
            error(f"migration missing COMMIT: {file.relative_to(ROOT)}")

        number_match = re.search(r"_(\d{3})_", file.name)
        if number_match:
            prefix = int(number_match.group(1))
            if prefix <= last_prefix:
                error(f"migration sequence is not strictly increasing: {file.name}")
            last_prefix = prefix

        for schema, table in re.findall(r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)", text, re.I):
            fq = f"{schema.lower()}.{table.lower()}"
            if fq in created_tables:
                error(f"duplicate CREATE TABLE across migrations: {fq}")
            created_tables.add(fq)

        for schema, table in re.findall(r"REFERENCES\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)", text, re.I):
            referenced_tables.append((file, f"{schema.lower()}.{table.lower()}"))

    for file, fq in referenced_tables:
        if fq not in created_tables:
            error(f"foreign key target absent from migration set: {file.relative_to(ROOT)} -> {fq}")


def check_critical_schema_invariants() -> None:
    migration_dir = ROOT / "db/migrations"
    all_sql = "\n".join(f.read_text(encoding="utf-8") for f in sorted(migration_dir.glob("*.sql")))

    required_fragments = {
        "single primary Trial": "trials_one_primary_per_person",
        "single open Trial access": "trials_one_open_access_per_person",
        "Order SETTLED state": "'SETTLED'",
        "recurring subscription add-on guard": "subscription.require_recurring_addon",
        "add-on cycle economics table": "subscription.subscription_addon_cycle_charges",
        "provider operation SUCCEEDED state": "'SUCCEEDED'",
        "financial ledger append-only": "financial_ledger_entries_append_only",
        "financial ledger balance check": "financial_ledger_balanced_at_commit",
        "financial transaction completeness check": "financial_transaction_complete_at_commit",
        "provider credit append-only": "provider_credit_entries_append_only",
        "message append-only": "messages_append_only",
        "conversation control history append-only": "conversation_control_events_append_only",
        "knowledge versions append-only": "knowledge_versions_append_only",
        "human review actions append-only": "human_review_actions_append_only",
        "reward ledger append-only": "reward_ledger_entries_append_only",
        "active referral attribution uniqueness": "referrals_active_person_per_program_unique",
    }
    for label, fragment in required_fragments.items():
        if fragment not in all_sql:
            error(f"critical schema invariant missing: {label}")

    # Canonical state sets for the most failure-sensitive aggregates.
    # NOTE: subscriptions_status_check reflects the reconciled 4-state
    # lifecycle (PENDING_ACTIVATION | ACTIVE | SUSPENDED | ENDED). The
    # matching SQL/OpenAPI alignment lands separately; until then this
    # check intentionally fails with a drift message.
    expected_state_sets = {
        "orders_status_check": {'DRAFT','AWAITING_PAYMENT','SETTLED','CANCELLED','EXPIRED'},
        "charges_status_check": {'PENDING','PROCESSING','PAID','FAILED','CANCELLED','EXPIRED'},
        "payments_status_check": {'CONFIRMED','PARTIALLY_REFUNDED','REFUNDED','CHARGEBACK'},
        "refund_requests_status_check": {'REQUESTED','UNDER_REVIEW','APPROVED','REJECTED','EXPIRED','CANCELLED','EXECUTED'},
        "refunds_status_check": {'PROCESSING','RECONCILING','SUCCEEDED','FAILED','CANCELLED'},
        "subscriptions_status_check": {'PENDING_ACTIVATION','ACTIVE','SUSPENDED','ENDED'},
        "entitlements_status_check": {'PENDING','ACTIVE','SUSPENDED','EXPIRED','REVOKED','CANCELLED'},
        "provider_operations_status_check": {'REQUESTED','QUEUED','RUNNING','VERIFYING','RETRY_WAIT','HUMAN_REQUIRED','SUCCEEDED','FAILED','CANCELLED'},
        "support_tickets_status_check": {'NEW','TRIAGING','IN_PROGRESS','WAITING_CUSTOMER','WAITING_INTERNAL','WAITING_PROVIDER','RESOLVED','CLOSED','CANCELLED'},
        "human_review_status_check": {'REQUESTED','QUEUED','ACKNOWLEDGED','IN_REVIEW','GUIDANCE_PROVIDED','ACTION_TAKEN','RESOLVED','EXPIRED','CANCELLED'},
        "referrals_status_check": {'CREATED','ATTRIBUTED','ENGAGED','QUALIFYING','CONFIRMED','REJECTED','EXPIRED','REVERSED'},
        "rewards_status_check": {'PENDING','APPROVED','ISSUED','AVAILABLE','REDEEMED','EXPIRED','REVOKED','FAILED'},
    }
    for constraint, expected in expected_state_sets.items():
        m = re.search(rf"CONSTRAINT\s+{re.escape(constraint)}\s+CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)\s*\)", all_sql, re.I | re.S)
        if not m:
            error(f"canonical status constraint not found: {constraint}")
            continue
        found = set(re.findall(r"'([^']+)'", m.group(1)))
        if found != expected:
            error(f"canonical status drift in {constraint}: expected {sorted(expected)}, found {sorted(found)}")


def check_seed_contracts() -> None:
    seed_dir = ROOT / "db/seeds"
    files = sorted(seed_dir.glob("*.sql")) if seed_dir.exists() else []
    if not files:
        error("synthetic pilot seed missing")
        return
    text = "\n".join(f.read_text(encoding="utf-8") for f in files)
    forbidden = ["sk_live_", "Bearer ", "api_key=", "password="]
    for marker in forbidden:
        if marker in text:
            error(f"potential live secret marker in seed: {marker}")
    if "'additional-connection'" not in text or "'RECURRING'" not in text:
        error("seed does not preserve recurring additional-connection semantics")
    if ",3000,'BRL'" not in text.replace(" ", ""):
        error("seed missing confirmed BRL 30.00 monthly price")
    if "seed://not-a-real-secret/cinevision" not in text:
        error("provider seed must use explicit non-secret placeholder")


def main() -> int:
    rows, parse_errors = parse_registry_file(ROOT / "docs/02-domain/event-model.md")
    for issue in parse_errors:
        error(issue)
    events = set(rows)
    check_markdown_links()
    per_file, spec_union = check_spec_events(events)
    spec_by_dir = group_spec_refs_by_dir(per_file)
    channels = check_yaml_contracts(events)
    if rows:
        check_registry_sources(rows, spec_by_dir, spec_union, channels)
        check_baseline_registry_matches(rows)
    check_sql_migrations()
    check_critical_schema_invariants()
    check_seed_contracts()

    if ERRORS:
        print(f"FAILED: {len(ERRORS)} issue(s)")
        for issue in ERRORS:
            print(f"- {issue}")
        return 1

    print("OK: documentation/contracts/migration static checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
