import json
from pathlib import Path
from typing import Any

import pytest
from django.core.cache import cache

from planner.providers import osrm, valhalla

FIXTURES = Path(__file__).parent / "fixtures"


def load(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text())


@pytest.fixture(autouse=True)
def _fresh_state(monkeypatch: pytest.MonkeyPatch) -> None:
    cache.clear()
    # No politeness delay against mocked servers.
    monkeypatch.setattr(valhalla.gate, "interval", 0.0)
    monkeypatch.setattr(osrm.gate, "interval", 0.0)
    valhalla.gate._next = 0.0
    osrm.gate._next = 0.0
