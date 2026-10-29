"""Local receipts for project-scoped computational delegation."""
from datetime import datetime, timezone
from typing import Any

from ..domain.errors import DomainError
from ..infrastructure.database import Database


def receipt_key(delegation_id: str, connector_id: str) -> str:
    return f'{connector_id}:{delegation_id}'


def store_receipt(database: Database, connector_id: str, delegation: dict[str, Any], decision: str | None = None) -> None:
    delegation_id = str(delegation.get('id') or '')
    if not delegation_id:
        return
    decisions = delegation.get('decisions') or []
    own = next((item.get('decision') for item in decisions
                if item.get('connector_id') == connector_id and item.get('kind') != 'business'), None)
    existing = database.durable_read('delegation-receipt', receipt_key(delegation_id, connector_id)) or {}
    accepted = decision or own or existing.get('decision')
    # Keep an accepted local receipt while other services are still confirming;
    # the center independently requires the entire delegation to be effective.
    status = str(delegation.get('status') or '')
    if status in {'pending', 'active', 'effective'} and accepted == 'accepted':
        status = 'accepted'
    receipt = {'id': delegation_id, 'connector_id': connector_id, 'decision': accepted,
               'status': status, 'scope_hash': delegation.get('scope_hash'),
               'scope': delegation.get('scope') or {}, 'expires_at': delegation.get('expires_at')}
    database.durable_write('delegation-receipt', receipt_key(delegation_id, connector_id), receipt, status)


def validate_receipt(database: Database, connector_id: str, request: dict[str, Any]) -> None:
    snapshot = request.get('delegation_snapshot') or {}
    receipt = database.durable_read('delegation-receipt', receipt_key(str(snapshot.get('id') or ''), connector_id))
    if snapshot.get('status') == 'active' and snapshot.get('service_authorization') == 'system':
        # This snapshot comes from the authenticated center dispatch, whose
        # project authorization has already verified both business approvals.
        receipt = {**snapshot, 'decision': 'accepted', 'status': 'accepted'}
    if not receipt or receipt.get('status') != 'accepted' or receipt.get('decision') != 'accepted':
        raise DomainError(403, '本连接器尚未接受本次计算委托，或委托已失效')
    if not snapshot.get('scope_hash') or snapshot['scope_hash'] != receipt.get('scope_hash'):
        raise DomainError(403, '执行请求与本地计算委托范围不一致')
    try:
        expiry = datetime.fromisoformat(str(receipt.get('expires_at') or '').replace('Z', '+00:00'))
        if expiry.tzinfo is None:
            expiry = expiry.replace(tzinfo=timezone.utc)
        if expiry <= datetime.now(timezone.utc):
            raise ValueError('expired')
    except (ValueError, TypeError):
        raise DomainError(403, '计算委托已过期或有效期无效') from None
    scope = receipt.get('scope') or {}
    if connector_id not in {p.get('connector_id') for p in scope.get('participants') or []}:
        raise DomainError(403, '本连接器不在已接受的委托参与方范围内')
    versions = {i.get('version_id') for i in scope.get('instances') or []}
    own_tasks = [n for n in (request.get('workflow') or {}).get('nodes') or []
                 if any((p.get('connector_id') or p.get('domain_id')) == connector_id
                        for p in n.get('parties') or [])]
    project_seats = scope.get('mode') == 'project-seats' and snapshot.get('service_authorization') == 'system'
    if not own_tasks or any(not n.get('template_version') or (not project_seats and n['template_version'] not in versions) for n in own_tasks):
        raise DomainError(403, '计算任务不属于本连接器已接受的应用版本')
