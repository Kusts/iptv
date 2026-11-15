"""Keep documented commerce and billing routes aligned with Nest controllers."""
from pathlib import Path
import re

import yaml


ROOT = Path(__file__).resolve().parents[2]
OPENAPI = ROOT / "docs/05-contracts/openapi/openapi.yaml"
CONTROLLERS = tuple(sorted((ROOT / "apps/api/src").rglob("*.controller.ts")))


def normalize(path: str) -> str:
    path = re.sub(r"\{[^}]+\}", "{}", path)
    return re.sub(r":[^/]+", "{}", path)


def controller_routes(path: Path) -> set[tuple[str, str]]:
    source = path.read_text(encoding="utf-8")
    source = re.sub(r"/\*.*?\*/|//[^\r\n]*", "", source, flags=re.DOTALL)
    prefix_match = re.search(r"""@Controller\(\s*(["'])(.*?)\1\s*\)""", source)
    if not prefix_match:
        raise ValueError(f"{path}: @Controller prefix not found or is empty")
    prefix = prefix_match.group(2).strip("/")
    routes = set()
    for match in re.finditer(
        r"""@(Get|Post|Put|Patch|Delete)(?:\(\s*(?:["']([^"']*)["'])?\s*\))?\s""",
        source,
    ):
        method, suffix = match.groups()
        suffix = suffix or ""
        route = "/" + "/".join(part for part in (prefix, suffix.strip("/")) if part)
        routes.add((method.lower(), normalize(route)))
    return routes


def main() -> None:
    document = yaml.safe_load(OPENAPI.read_text(encoding="utf-8"))
    documented = {
        (method.lower(), normalize(path))
        for path, operations in document["paths"].items()
        if path.startswith(("/v1/orders", "/v1/charges"))
        for method in operations
        if method.lower() in {"get", "post", "put", "patch", "delete"}
    }
    implemented = set().union(*(controller_routes(path) for path in CONTROLLERS))
    implemented = {
        route for route in implemented
        if route[1].startswith(("/v1/orders", "/v1/charges"))
    }
    missing = sorted(documented - implemented)
    undocumented = sorted(implemented - documented)
    assert not missing, "Documented routes missing in controllers: " + ", ".join(
        f"{method.upper()} {path}" for method, path in missing
    )
    assert not undocumented, "Controller routes missing in OpenAPI: " + ", ".join(
        f"{method.upper()} {path}" for method, path in undocumented
    )
    required = {
        ("post", "/v1/orders/quote"), ("post", "/v1/orders/{}/submit"),
        ("post", "/v1/orders/{}/cancel"), ("get", "/v1/orders/{}"),
        ("get", "/v1/orders"), ("post", "/v1/charges"),
        ("get", "/v1/charges"), ("get", "/v1/charges/{}/pix"),
        ("post", "/v1/charges/{}/reconcile"),
    }
    absent = sorted(required - documented)
    assert not absent, "Required routes absent from OpenAPI: " + ", ".join(
        f"{method.upper()} {path}" for method, path in absent
    )
    print(f"OpenAPI route parity: PASS ({len(documented)} routes)")


if __name__ == "__main__":
    main()
