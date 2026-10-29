"""Portal-owned state only. Data sources, resources and transfers live in services."""
from .database import Database


class PortalDatabase(Database):
    def migrate(self):
        self.connection().executescript('''
        CREATE TABLE IF NOT EXISTS durable_record (
          scope TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL, state TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(scope,key));
        CREATE INDEX IF NOT EXISTS idx_durable_scope_state ON durable_record(scope,state);
        CREATE TABLE IF NOT EXISTS application_image (
          name TEXT PRIMARY KEY, payload TEXT NOT NULL, registered_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS portal_state (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
        ''')
