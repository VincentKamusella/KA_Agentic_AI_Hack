"""Settings for scripts/preview_ui.py only: accounts in a local SQLite file.

The deployed application always uses web.config.settings and PostgreSQL.
"""
from web.config.settings import *  # noqa: F401,F403
from web.config.settings import BASE_DIR

DATABASES = {'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': BASE_DIR / 'preview.sqlite3'}}
# The backend's migrations use PostgreSQL features; the preview fakes its store.
MIGRATION_MODULES = {'backend': None}
