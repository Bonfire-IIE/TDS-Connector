from __future__ import annotations

import hashlib
import re
import secrets
from datetime import datetime, timezone
from pathlib import PurePosixPath
from typing import Any

from ..domain.errors import DomainError
from ..domain.types import standard_type
from ..infrastructure.database import Database
from ..infrastructure.seatunnel import SeaTunnelClient, SeaTunnelError


def _fingerprint(value: Any) -> str:
    import json
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=True).encode()).hexdigest()


def _redact(value: Any, key: str = "") -> Any:
    if re.search(r"password|secret|token|access.?key|credential", key, re.I): return "[REDACTED]"
    if isinstance(value, dict): return {str(k): _redact(v, str(k)) for k, v in value.items()}
    if isinstance(value, list): return [_redact(item, key) for item in value]
    return value


def normalize_files(files: Any) -> list[str]:
    values = files if isinstance(files, list) else [files]
    result = [str(item or "").strip() for item in values if str(item or "").strip()]
    if not result: raise DomainError(422, "请至少选择一个需要搬运的文件")
    if len(set(result)) != len(result): raise DomainError(422, "需要搬运的文件不能重复")
    for item in result:
        parts = item.lstrip("/").split("/")
        if "\\" in item or ".." in parts or "" in parts: raise DomainError(422, f"源文件相对路径越界: {item}")
    return result


def _columns(columns: list[dict[str, Any]], as_string: set[str] | None = None) -> dict[str, str]:
    if not columns: raise DomainError(422, "搬运作业需要列定义")
    as_string = as_string or set()
    result = {}
    for col in columns:
        name = str(col.get("name") or "").strip(); typ = standard_type(col.get("type") or "string")
        if not name: raise DomainError(422, "列名不能为空")
        if name in result: raise DomainError(422, f"列名重复: {name}")
        result[name] = "string" if name in as_string else typ
    return result


def _plugin(source: dict[str, Any]) -> str:
    return str((source.get("info") or {}).get("seatunnel_plugin") or {
        "localfs": "LocalFile", "oss": "S3File", "ftp": "FtpFile", "sftp": "SftpFile", "jdbc": "Jdbc",
    }.get(source.get("type"), ""))


_EXTENSION_FORMATS = {
    ".csv": "csv",
    ".tsv": "tsv",
    ".json": "json",
    ".jsonl": "jsonl",
    ".ndjson": "jsonl",
    ".parquet": "parquet",
    ".orc": "orc",
}
_STRUCTURED_FORMATS = frozenset(_EXTENSION_FORMATS.values())


def _input_format(plan: dict[str, Any], plugin: str, files: list[str], content_kind: str) -> str:
    if content_kind == "unstructured":
        return "binary"
    if plugin == "Jdbc":
        return "jdbc"
    declared = str(plan.get("format") or "").strip().lower()
    inferred = {_EXTENSION_FORMATS.get(PurePosixPath(item).suffix.lower()) for item in files}
    inferred.discard(None)
    if len(inferred) > 1:
        raise DomainError(422, "一次结构化搬运的文件格式必须一致")
    detected = next(iter(inferred), "")
    value = declared or detected
    if value not in _STRUCTURED_FORMATS:
        raise DomainError(422, "无法识别结构化文件格式，请明确选择 CSV、TSV、JSON、JSONL、Parquet 或 ORC")
    if detected and value != detected:
        raise DomainError(422, f"声明的文件格式 {value} 与文件扩展名对应格式 {detected} 不一致")
    return value


def _file_format_options(format_name: str, columns: list[dict[str, Any]],
                         boolean_fields: set[str], *, source: bool) -> dict[str, Any]:
    seatunnel_format = "json" if format_name == "jsonl" else format_name
    result: dict[str, Any] = {"file_format_type": seatunnel_format}
    if format_name in {"csv", "tsv"}:
        result.update({
            "field_delimiter": "," if format_name == "csv" else "\t",
            "encoding": "UTF-8",
        })
        if source:
            result["skip_header_row_number"] = 1
        else:
            result.update({"enable_header_write": True, "is_enable_transaction": True})
    if source and format_name in {"csv", "tsv", "json", "jsonl"}:
        result["schema"] = {"fields": _columns(columns, boolean_fields)}
    return result


def _relativize(root: str, files: list[str]) -> list[str]:
    base = root.rstrip("/")
    result = []
    for file in files:
        if not file.startswith("/"): result.append(file); continue
        if base and file.startswith(base + "/"): result.append(file[len(base) + 1:]); continue
        if not base and root.startswith("/"): result.append(file[1:]); continue
        raise DomainError(422, f"源文件越界，不在登记目录内: {file}")
    return result


def _locate(root: str, files: list[str]) -> dict[str, str]:
    base = root.rstrip("/")
    if len(files) == 1: return {"path": f"{base}/{files[0]}"}
    directories = {item.rsplit("/", 1)[0] if "/" in item else "" for item in files}
    if len(directories) != 1: raise DomainError(422, "一次搬运的多个文件必须位于同一个目录")
    directory = next(iter(directories)); names = [item.rsplit("/", 1)[-1] for item in files]
    escaped = [re.escape(name) for name in names]
    return {"path": f"{base}/{directory}" if directory else base, "file_filter_pattern": f"^({'|'.join(escaped)})$"}


def _absolute_root(source: dict[str, Any], label: str) -> str:
    raw = str((source.get("info") or {}).get("path") or source.get("uri") or "")
    root = raw.rstrip("/") or ("/" if raw.startswith("/") else "")
    if not root.startswith("/") or ".." in root.split("/"): raise DomainError(422, f"{label}需要登记绝对根目录")
    return root


def _subpath(value: Any, label: str) -> str:
    result = str(value or "").strip("/")
    if result and ("\\" in result or ".." in result.split("/") or "" in result.split("/")):
        raise DomainError(422, f"{label}越界")
    return result


def _s3_common(info: dict[str, Any]) -> dict[str, Any]:
    if not info.get("endpoint") or not info.get("bucket"): raise DomainError(422, "OSS 数据源缺少 endpoint 或 bucket")
    bucket = str(info["bucket"]).removeprefix("s3a://").removeprefix("s3://")
    return {"bucket": f"s3a://{bucket}", "fs.s3a.endpoint": info["endpoint"],
        "access_key": info.get("access_key_id"), "secret_key": info.get("access_key_secret"),
        "fs.s3a.aws.credentials.provider": '"SimpleAWSCredentialsProvider"',
        "hadoop_s3_properties": {"fs.s3a.path.style.access": str(not bool(info.get("virtualhost"))).lower(),
            "fs.s3a.connection.ssl.enabled": str(str(info["endpoint"]).startswith("https://")).lower()}}


def _filter_query(filters: dict[str, Any], columns: list[str], table: str) -> str | None:
    known = set(columns); selected_requested = filters.get("fields") or []
    for field in selected_requested:
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", str(field)) or field not in known:
            raise DomainError(422, f"筛选字段不在列定义中: {field}")
    selected = [name for name in columns if not selected_requested or name in selected_requested]
    if not selected: raise DomainError(422, "至少需要选取一个字段")
    clauses = []
    for condition in filters.get("conditions") or []:
        field = str(condition.get("field") or "")
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", field) or field not in known:
            raise DomainError(422, f"筛选字段不在列定义中: {field}")
        kind, op, raw = condition.get("kind"), condition.get("op"), condition.get("value")
        if kind == "boolean":
            if op != "eq": raise DomainError(422, f"布尔字段 {field} 只支持精确筛选")
            clauses.append(f"{field} = '{'true' if raw else 'false'}'")
        elif kind in {"integer", "double"}:
            try: number = float(raw)
            except (TypeError, ValueError): raise DomainError(422, f"字段 {field} 的筛选值必须是数字")
            if not number == number or number in {float("inf"), float("-inf")}: raise DomainError(422, f"字段 {field} 的筛选值必须是数字")
            if op == "between":
                try: upper = float(condition.get("value2"))
                except (TypeError, ValueError): raise DomainError(422, f"字段 {field} 的筛选值必须是数字")
                if number > upper: raise DomainError(422, f"字段 {field} 的范围下界大于上界")
                clauses.append(f"{field} >= {number:g} and {field} <= {upper:g}")
            else:
                operator = {"eq": "=", "ne": "<>", "gte": ">=", "lte": "<="}.get(str(op))
                if not operator: raise DomainError(422, f"数值字段 {field} 不支持筛选方式 {op}")
                clauses.append(f"{field} {operator} {number:g}")
        else:
            values = raw if isinstance(raw, list) else [raw]
            def quote(item: Any) -> str:
                text = str(item)
                if re.search(r"[\x00-\x1f]", text): raise DomainError(422, "筛选值不能包含控制字符")
                return "'" + text.replace("'", "''") + "'"
            if op == "in":
                values = [item for item in values if str(item)]
                if not values: raise DomainError(422, f"字段 {field} 的候选值列表为空")
                clauses.append(f"{field} in ({', '.join(quote(item) for item in values)})")
            elif op in {"eq", "ne"}: clauses.append(f"{field} {'<>' if op == 'ne' else '='} {quote(values[0])}")
            else: raise DomainError(422, f"字段 {field} 不支持筛选方式 {op}")
    if selected == columns and not clauses: return None
    return f"select {', '.join(selected)} from {table}" + (f" where {' and '.join(clauses)}" if clauses else "")


def _compile_transfer(plan: dict[str, Any], source: dict[str, Any], settings: Any,
                      output_source: dict[str, Any] | None = None) -> dict[str, Any]:
    columns = plan.get("columns") or []
    content_kind = "unstructured" if plan.get("content_kind") == "unstructured" else "structured"
    if content_kind == "unstructured" and plan.get("filter"): raise DomainError(422, "非结构化数据不支持字段与取值筛选")
    info = source.get("info") or {}; source_type = source.get("type"); plugin = _plugin(source)
    if not plugin: raise DomainError(422, "尚未接入受管搬运的源插件")
    files = normalize_files((plan.get("input") or {}).get("files"))
    input_format = _input_format(plan, plugin, files, content_kind)
    source_config: dict[str, Any] = {**(info.get("options") or {}), "plugin_name": plugin}
    filters = plan.get("filter") or {}; boolean_fields = {str(c.get("field")) for c in filters.get("conditions") or [] if c.get("kind") == "boolean"}
    if plugin == "Jdbc":
        if content_kind == "unstructured": raise DomainError(422, "数据库源没有非结构化形态")
        if not all(source_config.get(key) for key in ("url", "driver")): raise DomainError(422, "JDBC 源缺少 url 或 driver")
        source_config.pop("query", None)
        table = files[0]
        parts = table.split(".")
        if len(parts) not in {1, 2} or any(not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_$]*", part) for part in parts):
            raise DomainError(422, "数据库输入必须是目录中选择的合法表或视图")
        quote = "`" if str(source_config.get("url")).startswith("jdbc:mysql:") else '"'
        source_config["query"] = "SELECT * FROM " + ".".join(f"{quote}{part}{quote}" for part in parts)
        source_config["schema"] = {"fields": _columns(columns, boolean_fields)}
    elif plugin in {"S3File", "OssFile"}:
        prefix = str(info.get("prefix") or "").strip("/"); relative_files = _relativize(prefix, files)
        location = _locate(prefix, relative_files); source_config.update(_s3_common(info)); source_config.update(location); source_config["path"] = "/" + source_config["path"].lstrip("/")
    elif plugin == "LocalFile":
        root = str(info.get("path") or source.get("uri") or "").rstrip("/")
        if not root: raise DomainError(422, "本地源目录为空")
        mounted = str(settings.seatunnel_source_root).rstrip("/") + root[5:] if root == "/data" or root.startswith("/data/") else root
        source_config.update(_locate(mounted, _relativize(root, files)))
    else:
        root = _absolute_root(source, "FTP/SFTP 源"); options = info.get("options") or {}
        if not options.get("host") or not options.get("user") or not options.get("password"): raise DomainError(422, "FTP/SFTP 源缺少 host、user 或 password")
        source_config.update(_locate(root, _relativize(root, files)))
        source_config["port"] = int(options.get("port") or (21 if plugin == "FtpFile" else 22))
        if plugin == "FtpFile": source_config["connection_mode"] = options.get("connection_mode") or '"PASSIVE_LOCAL_DATA_CONNECTION_MODE"'
    if content_kind == "structured":
        if plugin != "Jdbc":
            source_config.update(_file_format_options(input_format, columns, boolean_fields, source=True))
            if input_format in {"csv", "tsv"}:
                source_config["skip_header_row_number"] = int((info.get("options") or {}).get("skip_header_row_number", 1))
    else: source_config["file_format_type"] = "binary"
    names = [str(column.get("name")) for column in columns]
    query = _filter_query(filters, names, "bonfire_source") if content_kind == "structured" else None
    selected = [column for column in columns if not filters.get("fields") or column.get("name") in filters["fields"]]
    if query: source_config["result_table_name"] = "bonfire_source"
    target = (plan.get("output") or {}).get("target")
    if target == "compute-input": raise DomainError(422, "输出为计算引擎入口时请使用数据接入任务")
    if target == "staging-dir":
        sink = {"plugin_name": "LocalFile", "path": str(settings.seatunnel_staging_root).rstrip("/") + "/" + str((plan.get("output") or {}).get("path") or "").strip("/")}
    elif target == "datasource":
        if not output_source: raise DomainError(422, "缺少输出数据源")
        out_info = output_source.get("info") or {}; out_plugin = _plugin(output_source); options = out_info.get("options") or {}
        if out_plugin == "Jdbc" or not out_plugin: raise DomainError(422, "尚未接入受管搬运的输出插件")
        sub = _subpath((plan.get("output") or {}).get("path"), "输出子目录")
        sink = {**options, "plugin_name": out_plugin}
        if out_plugin in {"S3File", "OssFile"}:
            sink.update(_s3_common(out_info)); prefix = "/".join(x for x in (str(out_info.get("prefix") or "").strip("/"), sub) if x); sink["path"] = "/" + prefix
        else:
            root = _absolute_root(output_source, "输出目录"); sink["path"] = f"{root}/{sub}" if sub else root
            if not options.get("host") and out_plugin in {"FtpFile", "SftpFile"}: raise DomainError(422, "FTP/SFTP 输出缺少 host")
            if out_plugin == "FtpFile": sink.update({"port": int(options.get("port") or 21), "connection_mode": options.get("connection_mode") or '"PASSIVE_LOCAL_DATA_CONNECTION_MODE"'})
            elif out_plugin == "SftpFile": sink["port"] = int(options.get("port") or 22)
    else: raise DomainError(422, "不支持的输出数据源类型")
    output_format = str((plan.get("output") or {}).get("format") or plan.get("output_format") or
                        (input_format if input_format != "jdbc" else "")).strip().lower()
    if content_kind == "structured" and output_format not in _STRUCTURED_FORMATS:
        raise DomainError(422, "结构化输出需要明确选择 CSV、TSV、JSON、JSONL、Parquet 或 ORC")
    if content_kind == "structured":
        sink.update(_file_format_options(output_format, selected, boolean_fields, source=False))
        # SeaTunnel 2.3.8 always finalizes a file sink through its aggregated
        # committer.  Its default tmp_path is local (/tmp/seatunnel), which
        # cannot be renamed into an FTP filesystem.  Keep both sides of the
        # atomic rename inside the writable FTP target tree.
        if sink.get("plugin_name") == "FtpFile":
            sink["is_enable_transaction"] = True
            sink["tmp_path"] = sink["path"].rstrip("/") + "/.seatunnel-tmp"
        sink["sink_columns"] = [str(c.get("name")) for c in selected]
    else: sink["file_format_type"] = "binary"
    if query: sink["source_table_name"] = "bonfire_result"
    job_id = str(int.from_bytes(secrets.token_bytes(8), "big") & ((1 << 62) - 1) or 1)
    result = {"env": {"parallelism": 1, "job.mode": "BATCH", "job.name": str(plan.get("job_name") or "transfer")}, "source": [source_config], "sink": [sink], "_job_id": job_id}
    if query: result["transform"] = [{"plugin_name": "Sql", "source_table_name": "bonfire_source", "result_table_name": "bonfire_result", "query": query}]
    return result


def compile_database_transfer(plan: dict[str, Any], source: dict[str, Any], settings: Any,
                              output_source: dict[str, Any] | None = None) -> dict[str, Any]:
    if source.get("type") != "jdbc" or _plugin(source) != "Jdbc":
        raise DomainError(422, "数据库搬运接口只接受 JDBC 数据源")
    input_plan = plan.get("input") or {}
    relation = str(input_plan.get("relation") or "")
    normalized = {
        "input": {"datasource_id": input_plan.get("datasource_id"), "files": [relation]},
        "output": plan.get("output") or {},
        "columns": plan.get("columns") or [],
        "format": "jdbc",
        "output_format": plan.get("output_format"),
        "content_kind": "structured",
        "filter": plan.get("filter"),
        "job_name": plan.get("job_name"),
    }
    return _compile_transfer(normalized, source, settings, output_source)


def compile_structured_file_transfer(plan: dict[str, Any], source: dict[str, Any], settings: Any,
                                     output_source: dict[str, Any] | None = None) -> dict[str, Any]:
    if source.get("type") == "jdbc" or _plugin(source) == "Jdbc":
        raise DomainError(422, "结构化文件搬运接口不接受数据库数据源")
    normalized = {
        "input": plan.get("input") or {},
        "output": plan.get("output") or {},
        "columns": plan.get("columns") or [],
        "format": plan.get("input_format"),
        "output_format": plan.get("output_format"),
        "content_kind": "structured",
        "filter": plan.get("filter"),
        "job_name": plan.get("job_name"),
    }
    return _compile_transfer(normalized, source, settings, output_source)


def compile_binary_file_transfer(plan: dict[str, Any], source: dict[str, Any], settings: Any,
                                 output_source: dict[str, Any] | None = None) -> dict[str, Any]:
    if source.get("type") == "jdbc" or _plugin(source) == "Jdbc":
        raise DomainError(422, "非结构化文件搬运接口不接受数据库数据源")
    normalized = {
        "input": plan.get("input") or {},
        "output": {**(plan.get("output") or {}), "format": "binary"},
        "columns": [],
        "format": "binary",
        "output_format": "binary",
        "content_kind": "unstructured",
        "job_name": plan.get("job_name"),
    }
    return _compile_transfer(normalized, source, settings, output_source)


def compile_transfer(plan: dict[str, Any], source: dict[str, Any], settings: Any,
                     output_source: dict[str, Any] | None = None) -> dict[str, Any]:
    """Compatibility dispatcher for persisted jobs created before typed endpoints."""
    kind = plan.get("plan_kind")
    if kind == "database":
        return compile_database_transfer(plan, source, settings, output_source)
    if kind == "structured-file":
        return compile_structured_file_transfer(plan, source, settings, output_source)
    if kind == "binary-file":
        return compile_binary_file_transfer(plan, source, settings, output_source)
    return _compile_transfer(plan, source, settings, output_source)


class MovementService:
    def __init__(self, database: Database, settings: Any): self.db, self.settings = database, settings

    def task(self, task_id: str, connector_id: str) -> dict[str, Any]:
        task = self.db.durable_read("transfer", task_id)
        if not task or task.get("connector_id") != connector_id: raise DomainError(404, "搬运任务不存在或不属于当前连接器")
        return task

    def create(self, plan: dict[str, Any], connector_id: str, request_key: str) -> dict[str, Any]:
        if not request_key: raise DomainError(422, "搬运任务需要幂等键")
        task_id = "tr-" + _fingerprint([connector_id, request_key])[:32]; existing = self.db.durable_read("transfer", task_id)
        binding_hash = _fingerprint(plan)
        if existing:
            if existing.get("binding_hash") != binding_hash: raise DomainError(409, "搬运任务幂等键已绑定其他配置")
            return existing
        source = self.db.datasource(str((plan.get("input") or {}).get("datasource_id")), connector_id)
        if not source: raise DomainError(404, "输入数据源不存在或不属于当前连接器")
        output_id = str((plan.get("output") or {}).get("datasource_id") or "")
        output = self.db.datasource(output_id, connector_id) if output_id else None
        config = compile_transfer(plan, source, self.settings, output)
        now = datetime.now(timezone.utc).isoformat(); task = {"id": task_id, "connector_id": connector_id, "request_key": request_key,
            "binding_hash": binding_hash, "plan": plan, "preview": _redact({k: v for k, v in config.items() if k != "_job_id"}), "job_id": config.pop("_job_id"),
            "state": "queued", "created_at": now, "updated_at": now}
        self.db.durable_write("transfer", task_id, task, "queued"); return task

    @staticmethod
    def public(task: dict[str, Any]) -> dict[str, Any]:
        return {"id": task["id"], "connector_id": task["connector_id"], "plan": task["plan"],
            "config": task.get("preview") or {}, "channel": "transfers", "registers_compute_input": False,
            "state": task.get("state"), "job_id": task.get("job_id") if task.get("submission_started") else None,
            "engine_status": task.get("engine_status"), "error": task.get("error"),
            "created_at": task.get("created_at"), "updated_at": task.get("updated_at")}

    def list(self, connector_id: str) -> list[dict[str, Any]]:
        return [self.public(x) for x in self.db.durable_list("transfer") if x.get("connector_id") == connector_id]

    async def run(self, task_id: str, connector_id: str) -> dict[str, Any]:
        task = self.task(task_id, connector_id)
        if task.get("state") == "succeeded": return task
        source = self.db.datasource(str((task["plan"].get("input") or {}).get("datasource_id") or ""), connector_id)
        if not source: raise DomainError(404, "输入数据源不存在或不属于当前连接器")
        output_id = str((task["plan"].get("output") or {}).get("datasource_id") or "")
        output = self.db.datasource(output_id, connector_id) if output_id else None
        config = compile_transfer(task["plan"], source, self.settings, output); config.pop("_job_id", None)
        engine = SeaTunnelClient(self.settings.seatunnel_api_base, self.settings.seatunnel_job_timeout_ms / 1000)
        try:
            if not task.get("submission_started"):
                task.update({"state": "submitting", "submission_started": True, "updated_at": datetime.now(timezone.utc).isoformat()})
                self.db.durable_write("transfer", task_id, task, "submitting")
                try:
                    returned = await engine.submit(config, task["job_id"])
                    if returned != task["job_id"]: raise SeaTunnelError("SeaTunnel 未保留预先分配的 Job ID")
                except Exception:
                    current = await engine.job(task["job_id"])
                    if not str(current.get("jobStatus") or "").strip(): raise
            task.update({"state": "running", "updated_at": datetime.now(timezone.utc).isoformat()})
            self.db.durable_write("transfer", task_id, task, "running")
            result = await engine.wait(task["job_id"], self.settings.seatunnel_job_timeout_ms / 1000)
            task.update({"state": "succeeded", "engine_status": result.get("jobStatus") or "FINISHED", "error": None,
                         "updated_at": datetime.now(timezone.utc).isoformat()})
            self.db.durable_write("transfer", task_id, task, "succeeded"); return task
        except Exception as exc:
            task.update({"state": "failed", "error": {"phase": task.get("state"), "message": str(exc)[:500], "retryable": True},
                         "updated_at": datetime.now(timezone.utc).isoformat()})
            self.db.durable_write("transfer", task_id, task, "failed"); raise
