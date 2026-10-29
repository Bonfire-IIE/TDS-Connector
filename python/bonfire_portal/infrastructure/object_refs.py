from __future__ import annotations

import base64
import json
from typing import Any

from ..domain.errors import DomainError


def encode_ref(provider: str, locator: dict[str, Any]) -> str:
    payload = json.dumps({"v": 1, "provider": provider, "locator": locator}, ensure_ascii=True,
                         sort_keys=True, separators=(",", ":")).encode()
    return "obj1." + base64.urlsafe_b64encode(payload).rstrip(b"=").decode()


def decode_ref(value: str, expected_provider: str | None = None) -> dict[str, Any]:
    try:
        if not value.startswith("obj1."):
            raise ValueError("version")
        raw = value[5:]
        payload = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
        if payload.get("v") != 1 or not isinstance(payload.get("locator"), dict):
            raise ValueError("shape")
        if expected_provider and payload.get("provider") != expected_provider:
            raise ValueError("provider")
        return payload["locator"]
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        raise DomainError(422, "无效或不属于当前数据源的 object_ref") from exc

