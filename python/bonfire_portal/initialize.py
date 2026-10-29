"""Explicit identity-only initialization from an archived Portal database."""
import argparse
import json
import sqlite3
from pathlib import Path
from .infrastructure.portal_database import PortalDatabase


def initialize(source: Path, destination: Path):
    if source.resolve() == destination.resolve(): raise ValueError('source_and_destination_must_differ')
    if destination.exists(): raise ValueError('destination_already_exists')
    with sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True) as old:
        row = old.execute('SELECT payload FROM portal_state WHERE id=1').fetchone()
        if not row: raise ValueError('identity_not_found')
        state = json.loads(row[0])
        state['pending_by_user'] = {}
        if not state.get('connectors'): raise ValueError('no_connector_identity')
        for profile in state['connectors'].values():
            # Older Node/Python versions embedded execution history in identity
            # profiles. It must not cross the fresh business-data boundary.
            profile.pop('local_execution_runs', None)
    db = PortalDatabase(destination)
    with db.transaction(immediate=True) as tx:
        tx.execute('INSERT INTO portal_state(id,payload) VALUES(1,?)', (json.dumps(state),))
    db.connection().close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--destination', type=Path, required=True)
    args = parser.parse_args()
    initialize(args.source, args.destination)

if __name__ == '__main__': main()
