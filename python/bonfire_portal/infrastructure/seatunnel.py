from __future__ import annotations

import asyncio
from typing import Any

import httpx


class SeaTunnelError(Exception):
    pass


class SeaTunnelClient:
    def __init__(self, base_url: str, timeout_seconds: float = 180.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout_seconds

    async def submit(self, config: dict[str, Any], job_id: str) -> str:
        try:
            async with httpx.AsyncClient(timeout=self.timeout, trust_env=False) as client:
                response = await client.post(f"{self.base_url}/hazelcast/rest/maps/submit-job",
                    params={"jobId": job_id}, json=config)
            response.raise_for_status(); value = response.json()
            returned = str(value.get("jobId") or "")
            if not returned: raise SeaTunnelError("SeaTunnel 提交成功但未返回 jobId")
            return returned
        except (httpx.HTTPError, ValueError) as exc:
            raise SeaTunnelError(f"SeaTunnel 作业提交失败: {exc}") from exc

    async def job(self, job_id: str) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=self.timeout, trust_env=False) as client:
                response = await client.get(f"{self.base_url}/hazelcast/rest/maps/job-info/{job_id}")
            response.raise_for_status(); return response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise SeaTunnelError(f"SeaTunnel 作业状态查询失败: {exc}") from exc

    async def wait(self, job_id: str, timeout_seconds: float, poll_seconds: float = .5) -> dict[str, Any]:
        deadline = asyncio.get_running_loop().time() + timeout_seconds
        while asyncio.get_running_loop().time() < deadline:
            value = await self.job(job_id); status = str(value.get("jobStatus") or "").upper()
            if status == "FINISHED": return value
            if status in {"FAILED", "CANCELED", "CANCELLED"}:
                raise SeaTunnelError(f"SeaTunnel 作业 {job_id} 执行失败 ({status}): {value.get('errorMsg') or '未返回错误详情'}")
            await asyncio.sleep(poll_seconds)
        raise SeaTunnelError(f"SeaTunnel 作业 {job_id} 在 {timeout_seconds * 1000:.0f}ms 内未完成")
