from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TransferOutput(StrictModel):
    target: Literal["staging-dir", "datasource"]
    datasource_id: str | None = None
    path: str | None = None
    format: Literal["csv", "tsv", "json", "jsonl", "parquet", "orc", "binary"] | None = None

    @model_validator(mode="after")
    def require_datasource(self):
        if self.target == "datasource" and not self.datasource_id:
            raise ValueError("输出到数据源时需要 datasource_id")
        if self.target == "staging-dir" and self.datasource_id:
            raise ValueError("输出到 staging 时不能指定 datasource_id")
        return self


class ColumnDefinition(StrictModel):
    name: str = Field(min_length=1, max_length=256)
    type: str = Field(min_length=1, max_length=64)


class TransferFilter(StrictModel):
    fields: list[str] | None = None
    conditions: list[dict] | None = None
    preview_rows: int | None = Field(default=None, ge=1, le=1000)


class DatabaseInput(StrictModel):
    datasource_id: str = Field(min_length=1)
    relation: str = Field(min_length=1, max_length=513)


class FileInput(StrictModel):
    datasource_id: str = Field(min_length=1)
    files: Annotated[list[str], Field(min_length=1)]


class DatabaseTransferPlan(StrictModel):
    plan_kind: Literal["database"] = "database"
    input: DatabaseInput
    output: TransferOutput
    columns: Annotated[list[ColumnDefinition], Field(min_length=1)]
    output_format: Literal["csv", "tsv", "json", "jsonl", "parquet", "orc"]
    filter: TransferFilter | None = None
    job_name: str | None = None
    request_key: str | None = None

    @model_validator(mode="after")
    def validate_output_format(self):
        if self.output.format and self.output.format != self.output_format:
            raise ValueError("output.format 必须与 output_format 一致")
        return self


class StructuredFileTransferPlan(StrictModel):
    plan_kind: Literal["structured-file"] = "structured-file"
    input: FileInput
    output: TransferOutput
    columns: Annotated[list[ColumnDefinition], Field(min_length=1)]
    input_format: Literal["csv", "tsv", "json", "jsonl", "parquet", "orc"]
    output_format: Literal["csv", "tsv", "json", "jsonl", "parquet", "orc"]
    filter: TransferFilter | None = None
    job_name: str | None = None
    request_key: str | None = None

    @model_validator(mode="after")
    def validate_output_format(self):
        if self.output.format and self.output.format != self.output_format:
            raise ValueError("output.format 必须与 output_format 一致")
        return self


class BinaryFileTransferPlan(StrictModel):
    plan_kind: Literal["binary-file"] = "binary-file"
    input: FileInput
    output: TransferOutput
    job_name: str | None = None
    request_key: str | None = None

    @model_validator(mode="after")
    def validate_binary_output(self):
        if self.output.format not in {None, "binary"}:
            raise ValueError("非结构化文件只能按 binary 原样输出")
        return self


class ComputeInputFields(StrictModel):
    request_key: str = Field(min_length=1)
    resource_ref: str = Field(min_length=1)
    resource_version: str = Field(min_length=1)
    staging_backend: Literal["directory", "s3"]
    columns: Annotated[list[ColumnDefinition], Field(min_length=1)]


class DatabaseExtractionPlan(ComputeInputFields):
    source_kind: Literal["database"] = "database"
    input: DatabaseInput
    filter: TransferFilter | None = None


class StructuredFileExtractionPlan(ComputeInputFields):
    source_kind: Literal["structured-file"] = "structured-file"
    input: FileInput
    input_format: Literal["csv", "tsv", "json", "jsonl", "parquet", "orc"]
    filter: TransferFilter | None = None
