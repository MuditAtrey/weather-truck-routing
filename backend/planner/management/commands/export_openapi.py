import json
from pathlib import Path
from typing import Any

from django.core.management.base import BaseCommand

from planner.api import api


class Command(BaseCommand):
    help = "Write the OpenAPI schema used to generate the frontend's TypeScript types."

    def handle(self, *args: Any, **options: Any) -> None:
        out = Path(__file__).resolve().parents[3] / "openapi.json"
        out.write_text(json.dumps(api.get_openapi_schema(path_prefix="/api/"), indent=2) + "\n")
        self.stdout.write(f"wrote {out}")
