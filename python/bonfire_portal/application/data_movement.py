from __future__ import annotations
from typing import Any
from ..domain.errors import DomainError

class DataMovementService:
    """Only compute-input orchestration remains local; ordinary movement belongs to DI."""
    def __init__(self, settings, database, state, extractions, schedule):
        self.settings, self.database, self.state = settings, database, state
        self.extractions, self.schedule = extractions, schedule

    def _profile(self, connector_id):
        profile = self.state.profile(connector_id)
        if not profile: raise DomainError(409, "连接器尚未完成接入")
        return profile

    def extraction_options(self, connector_id):
        profile = self._profile(connector_id)
        return {'node': profile.get('domain_id'), 'backend': self.settings.engine_upload_backend}

    def prepare_extraction(self, body, connector_id):
        # Automatic preparation selects DR resource/version, never arbitrary source paths.
        if body.get('mode') != 'manual' and not body.get('dr_resource_id'):
            raise DomainError(422, 'dr_resource_id_required')
        body['output_format'] = 'csv'
        task = self.extractions.create(body, connector_id, self._profile(connector_id))
        return {'extraction_id': task['id'], **self.extractions.public(task)}

    def run_extraction(self, extraction_id: str, connector_id: str) -> dict[str, Any]:
        profile = self._profile(connector_id)
        task = self.extractions.task(extraction_id, connector_id)
        self.schedule(
            f"extraction:{extraction_id}",
            self.extractions.run(extraction_id, connector_id, profile),
        )
        return {"extraction_id": extraction_id, **self.extractions.public(task)}

    def list_extractions(self, connector_id: str) -> list[dict[str, Any]]:
        return [self.extractions.public(item) for item in self.database.durable_list("extraction")
                if item.get("connector_id") == connector_id]

    def get_extraction(self, extraction_id: str, connector_id: str) -> dict[str, Any]:
        return self.extractions.public(self.extractions.task(extraction_id, connector_id))

    async def extraction_action(self, extraction_id: str, action: str,
                                connector_id: str) -> dict[str, Any]:
        profile = self._profile(connector_id)
        if action == "credentials":
            if self.extractions.task(extraction_id, connector_id).get('mode') != 'manual':
                raise DomainError(403, 'automatic_delivery_credentials_private')
            return await self.extractions.credentials(extraction_id, connector_id, profile)
        if action == "received":
            return await self.extractions.received(extraction_id, connector_id, profile)
        if action == "cancel":
            return self.extractions.public(await self.extractions.cancel(extraction_id, connector_id, profile))
        if action == "cleanup":
            return self.extractions.public(await self.extractions.cleanup(extraction_id, connector_id, profile))
        raise DomainError(404, "未知接入任务操作")

    def complete_extraction(self, extraction_id: str, files: Any,
                            connector_id: str) -> dict[str, Any]:
        task = self.extractions.task(extraction_id, connector_id)
        if not isinstance(files, list) or not files:
            raise DomainError(422, "请先核对全部已接收文件")
        task["expected_files"] = files
        self.database.durable_write("extraction", extraction_id, task, task.get("state"))
        self.schedule(
            f"extraction:{extraction_id}",
            self.extractions.run(extraction_id, connector_id, self._profile(connector_id)),
        )
        return self.extractions.public(task)

