import os

os.environ.setdefault("DJANGO_SECRET_KEY", "test-only-key")
os.environ.setdefault("VALHALLA_ENABLED", "1")

from config.settings import *  # noqa: F403

SECURE_SSL_REDIRECT = False
