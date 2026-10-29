"""Browser delegation commands, bound to this Portal's authenticated connector."""
from typing import Any, Callable
from urllib.parse import quote

from fastapi import Request

from ...config import Settings
from ...application.delegations import store_receipt
from ...infrastructure.database import Database
from ...domain.errors import DomainError
from ...infrastructure.platform import PlatformClient


class DelegationHttpAdapter:
    def __init__(self, settings: Settings, connector_id: Callable[[Request], str],
                 authorization: Callable[[Request], str | None], database: Database):
        self.settings = settings
        self.connector_id = connector_id
        self.authorization = authorization
        self.database = database

    async def inbox(self, request: Request) -> Any:
        result = await PlatformClient(self.settings, self.authorization(request)).request(
            'GET', '/computation-delegations/inbox',
            params={'connector_id': self.connector_id(request)},
        )
        items = result if isinstance(result, list) else result.get('items', [])
        for item in items:
            store_receipt(self.database, self.connector_id(request), item)
        return result

    async def decision(self, request: Request, delegation_id: str) -> Any:
        try:
            body = await request.json()
        except ValueError:
            raise DomainError(422, "计算委托决定需要有效的 JSON 请求") from None
        if not isinstance(body, dict) or body.get('decision') not in {'accepted', 'rejected'}:
            raise DomainError(422, '计算委托决定只能是接受或拒绝')
        # A browser may not choose which connector it represents. Authentication
        # and the Portal binding provide that identity; the center checks ownership.
        payload = {'connector_id': self.connector_id(request), 'decision': body['decision']}
        result = await PlatformClient(self.settings, self.authorization(request)).request(
            'POST', '/computation-delegations/' + quote(delegation_id, safe='') + '/decision', payload,
        )
        store_receipt(self.database, self.connector_id(request), result, body['decision'])
        return result
