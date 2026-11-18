"""Settings for a stateless API: no database, no sessions, no admin.

Everything environment-specific comes from env vars so the same code runs locally,
in CI and on Vercel.
"""

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

DEBUG = os.environ.get("DJANGO_DEBUG", "0") == "1"
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "")
if not SECRET_KEY:
    if DEBUG:
        SECRET_KEY = "dev-only-insecure-key"  # noqa: S105
    else:
        raise RuntimeError("DJANGO_SECRET_KEY must be set when DJANGO_DEBUG is off")

ALLOWED_HOSTS = [
    h for h in os.environ.get("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1").split(",") if h
]
for var in ("VERCEL_URL", "VERCEL_BRANCH_URL", "VERCEL_PROJECT_PRODUCTION_URL"):
    if os.environ.get(var):
        ALLOWED_HOSTS.append(os.environ[var])

INSTALLED_APPS = ["planner"]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.middleware.common.CommonMiddleware",
]

ROOT_URLCONF = "config.urls"
ASGI_APPLICATION = "config.asgi.application"

DATABASES: dict[str, dict[str, str]] = {}

CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "planner",
        "TIMEOUT": 1800,
        "OPTIONS": {"MAX_ENTRIES": 2000},
    }
}

USE_TZ = True
TIME_ZONE = "UTC"
USE_I18N = False

# TLS is terminated by the platform proxy.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_SSL_REDIRECT = not DEBUG
SECURE_REDIRECT_EXEMPT = [r"^api/health$"]
SECURE_HSTS_SECONDS = 0 if DEBUG else 31536000
SECURE_REFERRER_POLICY = "strict-origin-when-cross-origin"
SECURE_CONTENT_TYPE_NOSNIFF = True
# HSTS subdomains/preload cannot be set on *.vercel.app.
SILENCED_SYSTEM_CHECKS = ["security.W005", "security.W021"]

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "root": {"handlers": ["console"], "level": "INFO"},
}

# Contact details sent to the free public routing servers, as their usage policies ask.
OPERATOR_EMAIL = os.environ.get("OPERATOR_EMAIL", "")
APP_URL = os.environ.get("APP_URL", "https://github.com/MuditAtrey/weather-truck-routing")
USER_AGENT = "weather-truck-routing/1.0 (+{}{})".format(
    APP_URL, f"; {OPERATOR_EMAIL}" if OPERATOR_EMAIL else ""
)
# FOSSGIS asks for a visible operator contact. Without one, use the OSRM demo only.
VALHALLA_ENABLED = (
    os.environ.get("VALHALLA_ENABLED", "1" if OPERATOR_EMAIL or DEBUG else "0") == "1"
)
VALHALLA_URL = os.environ.get("VALHALLA_URL", "https://valhalla1.openstreetmap.de")
OSRM_URL = os.environ.get("OSRM_URL", "https://router.project-osrm.org")
