from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol


ObjectKind = Literal["directory", "file", "catalog", "schema", "table", "view", "workbook", "sheet"]
DataKind = Literal["structured", "unstructured"]
SchemaSource = Literal["declared", "inferred", "user-confirmed"]


@dataclass(frozen=True)
class DataObject:
    object_ref: str
    kind: ObjectKind
    name: str
    path: str
    parent_ref: str | None = None
    selectable: bool = False
    expandable: bool = False
    data_kind: DataKind | None = None
    format: str | None = None
    size: int | None = None
    modified_at: str | None = None
    inspectable: bool = False
    transferable: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ObjectPage:
    items: list[DataObject]
    next_cursor: str | None = None
    truncated: bool = False
    indexed_at: str | None = None


@dataclass(frozen=True)
class ColumnSchema:
    name: str
    type: str
    physical_type: str | None = None
    nullable: bool | None = None
    confidence: float | None = None


@dataclass(frozen=True)
class InspectionResult:
    object_ref: str
    data_kind: DataKind
    format: str
    schema_source: SchemaSource
    columns: list[ColumnSchema]
    sampled_rows: int = 0
    complete: bool = False
    sample: list[list[Any]] = field(default_factory=list)
    fingerprint: str = ""
    warnings: list[str] = field(default_factory=list)


class DiscoveryProvider(Protocol):
    def capability(self) -> dict[str, Any]: ...
    def list_objects(self, parent_ref: str | None, cursor: str | None, limit: int) -> ObjectPage: ...
    def inspect(self, object_ref: str, sample_rows: int, options: dict[str, Any]) -> InspectionResult: ...

