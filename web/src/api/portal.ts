import { api } from './client'

// 注：api 的响应拦截已把 {code,message,data} 解包为 data，
// 故这里用 axios 的第二个泛型参数 R 声明「实际返回值」类型。

export interface LoginResp {
  access_token: string
  switched: boolean
}

export interface LiteStatus {
  reachable: boolean
  node_online: boolean
  endpoint: string
}

export interface ConnectorStatus {
  connector_id: string
  privacy_compute_configured?: boolean
  privacy_compute_endpoint?: string | null
  online?: boolean
  storage_root: string
}

export interface DataSourceItem {
  id: string
  name: string
  type: string
  external_source_ref: string | null
  uri: string | null
  info: Record<string, unknown> | null
  access_directly?: boolean
  created_by?: string
  created_at?: string
}

export interface DataSourceCreate {
  name: string
  type: 'localfs' | 'oss' | 'jdbc' | 'sftp' | 'ftp'
  uri?: string
  info: Record<string, unknown>
  access_directly?: boolean
}

export interface FileServiceStatus {
  available: boolean
  /** 当前绑定连接器的固定 KusciaAPI endpoint。 */
 endpoint?: string
 message: string
}

export interface FileEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  modified_at?: string
}

export interface ResourceItem {
  id: string
  resource_code: string
  resource_name: string
  resource_abstract: string
  industry_code: string
  theme_code?: string | null
  resource_owner_name: string
  resource_owner_id: string
  contact_name: string
  contact_information: string
  resource_format: string
  data_type: 'table' | 'file' | 'text' | 'image' | 'other'
  data_source_type: '01' | '02' | '03' | '04' | '05'
  update_frequency: string
  update_method?: string | null
  version_no?: string | null
  personal_information_level: '0' | '1' | '2'
  security_level: string
  data_items: Array<{ name: string; type: string; comment?: string }>
  datasource_id: string
  relative_uri: string
  object_ref?: string | null
  status: string
  created_at: string
  updated_at: string
}

export interface ResourceRegister {
  resource_id?: string
  resource_code?: string
  resource_name: string
  resource_abstract: string
  industry_code: string
  theme_code?: string
  resource_owner_name: string
  resource_owner_id: string
  contact_name: string
  contact_information: string
  resource_format: string
  data_type: 'table' | 'file' | 'text' | 'image' | 'other'
  data_source_type: '01' | '02' | '03' | '04' | '05'
  data_size?: string
  time_range?: string
  update_frequency: string
  update_method?: string
  version_no?: string
  security_level: string
  personal_information_level: '0' | '1' | '2'
  data_modalities?: string[]
  data_items?: Array<{ name: string; type?: string; comment?: string }>
  datasource_id: string
  relative_uri: string
  object_ref?: string
}

export interface CatalogObject {
  object_ref: string
  parent_ref?: string | null
  kind: 'directory' | 'file' | 'catalog' | 'schema' | 'table' | 'view' | 'workbook' | 'sheet'
  name: string
  path: string
  data_kind?: 'structured' | 'unstructured'
  format?: string
  selectable: boolean
  expandable: boolean
  inspectable: boolean
  transferable: boolean
  size?: number
  modified_at?: string
}

export interface CatalogObjectPage {
  items: CatalogObject[]
  next_cursor?: string | null
  truncated: boolean
  indexed_at?: string | null
}

export interface CatalogInspection {
  object_ref: string
  data_kind: 'structured' | 'unstructured'
  format: string
  columns: Array<{ name: string; type: string; physical_type?: string; nullable?: boolean }>
  sampled_rows: number
  complete: boolean
  sample: unknown[][]
}

// 门户复用平台身份，登录由门户后端代理平台 ROPC。
export async function login(username: string, password: string) {
  return api.post<unknown, LoginResp>('/portal/login', { username, password })
}

// 连接器管理：本地 Lite 状态 + 与 master 连通。
export async function getStatus() {
  return api.get<unknown, ConnectorStatus>('/portal/status')
}
export async function getOverview() { return api.get<unknown, any>('/portal/overview') }
export async function listRoutes() { return api.get<unknown, any[]>('/portal/routes') }
export async function deleteRoute(destination: string) { return api.delete(`/portal/routes/${encodeURIComponent(destination)}`) }

// 数据源配置：本地 Lite 已建/已上报的数据源集合。
export async function listDatasources() {
  return api.get<unknown, DataSourceItem[]>('/portal/datasources')
}

export async function createDatasource(body: DataSourceCreate) {
  return api.post<unknown, DataSourceItem>('/portal/datasources', body)
}

export async function deleteDatasource(id: string) {
  return api.delete<unknown, { deleted: string }>(`/portal/datasources/${id}`)
}
export interface DataSourceProbeResult {
  datasource_id: string
  status: 'available' | 'unavailable'
  checked_at: string
  message: string
  object_count_hint?: string
}
export async function probeDatasource(id: string) {
  return api.post<unknown, DataSourceProbeResult>(`/portal/datasources/${id}/probe`)
}
export async function getDatasourceDetails(id: string) {
  return api.get<unknown, Record<string, unknown>>(`/portal/datasources/${id}/details`)
}
export async function listDatasourceObjects(id: string, parentRef?: string, query?: string, cursor?: string) {
  return api.get<unknown, CatalogObjectPage>(`/portal/datasources/${id}/objects`, {
    params: { parent_ref: parentRef || undefined, q: query || undefined, cursor: cursor || undefined, limit: 200 },
  })
}
export async function inspectDatasourceObject(id: string, objectRef: string) {
  return api.post<unknown, CatalogInspection>(`/portal/datasources/${id}/inspect`, {
    object_ref: objectRef, options: { sample_rows: 20 },
  })
}
export async function startDatasourceIndex(id: string) {
  return api.post<unknown, { id: string; datasource_id: string; state: string }>(`/portal/datasources/${id}/index`, {})
}
export interface IngestionFile { path: string; size: number; sha256: string; rows?: number }
export interface IngestionTask {
  channel: 'extractions'; registers_compute_input: true
  id: string; resource_ref: string; resource_version: string; node: string; mode: 'manual' | 'seatunnel'; backend: string;
  state: string; phase: string; created_at: string; updated_at: string; job_id?: string; session_id?: string; engine_status?: string;
  received_files?: IngestionFile[]; batch?: { state: string; expires_at?: string; files?: IngestionFile[]; object_uri?: string };
  resources?: Array<{ engine_input_id: string; relative_uri: string; sha256: string; rows?: number }>;
  error?: { phase: string; message: string; retryable: boolean };
}
export interface IngestionOptions { node: string; host: string; port: number; backend: string; backends: string[];
  max_session_bytes: number; max_files: number; require_tls: boolean; sources: Array<{ id: string; name: string; type: string }> }
export interface UploadCredentials { host: string; port: number; username: string; password: string; directory: string; session_id: string; expires_at: string }
export async function ingestionOptions() { return api.get<unknown, IngestionOptions>('/portal/extractions/options') }
export async function listExtractions() { return api.get<unknown, IngestionTask[]>('/portal/extractions') }
export async function prepareExtraction(body: {
  datasource_id?: string; request_key: string; resource_ref: string; resource_version: string; mode?: 'manual' | 'seatunnel'; staging_backend?: string;
  relative_uri?: string; columns: Array<{ name: string; type: string }>; format?: string
  input_format?: string; output_format?: string
}) { return api.post<unknown, IngestionTask & { extraction_id: string }>('/portal/extractions/prepare', body) }
export async function runExtraction(extraction_id: string) { return api.post('/portal/extractions/run', { extraction_id }) }
export async function getExtraction(id: string) { return api.get<unknown, IngestionTask>(`/portal/extractions/${id}`) }
export async function uploadCredentials(id: string) { return api.post<unknown, UploadCredentials>(`/portal/extractions/${id}/credentials`) }
export async function receivedFiles(id: string) { return api.get<unknown, IngestionTask>(`/portal/extractions/${id}/received`) }
export async function completeExtraction(id: string, files: IngestionFile[]) { return api.post(`/portal/extractions/${id}/complete`, { files }) }
export async function cancelExtraction(id: string) { return api.post(`/portal/extractions/${id}/cancel`) }

/** 通用数据搬运：小配置单（输入源 / 输出源 / 文件）→ 后端生成 SeaTunnel 胖配置单。 */
export interface TransferFormField { name: string; label: string; type: string; required: boolean; hint?: string; source?: string; options?: string[] }
export interface TransferOutput {
  target: 'compute-input' | 'staging-dir' | 'datasource'; datasource_id?: string; label: string
  /** 执行通道由后端给出，前端不按输出类型推断。 */
  via: 'extractions' | 'transfers'
  registers_compute_input: boolean
  /** 选中输出后立即展示的固定提示文案。 */
  notice: string
  /** 该输出需要额外填写的字段名。 */
  fields: string[]
}
export interface TransferForm {
  node: string; staging_dir: string; node_available: boolean
  compute_input: { host: string; port: number; backend: string; require_tls?: boolean
    max_session_bytes?: number; max_files?: number; backends: string[] }
  inputs: Array<{ id: string; name: string; type: string; plugin: string }>
  outputs: TransferOutput[]
  /** 明确不可作为输出的已登记数据源（如 jdbc），前端据此给出禁用说明。 */
  excluded_outputs: Array<{ datasource_id: string; label: string; reason: string }>
  input_modes?: Record<string, { source_types: string[]; content_kind: ContentKind; selects: string; allows_compute_input: boolean }>
  fields?: TransferFormField[]
}
/** 数据形态：结构化按 CSV 解析并可筛选；非结构化整文件直通。 */
export type ContentKind = 'structured' | 'unstructured'
export type ColumnKind = 'integer' | 'double' | 'boolean' | 'enum' | 'string' | 'unknown'
export interface ScannedColumn {
  name: string; kind: ColumnKind
  /** 数值列的采样极值，用于预填范围输入框。 */
  min?: number; max?: number
  /** 枚举/布尔列的采样取值。 */
  values?: string[]
  nullable?: boolean
}
export interface ScannedSchema {
  format: string
  columns: ScannedColumn[]
  sampled_rows: number
  /** false 表示采样未读到文件末尾，极值与候选值只是样本。 */
  complete: boolean
  sample: string[][]
}
export type FilterCondition =
  | { field: string; kind: 'integer' | 'double'; op: 'eq' | 'ne' | 'gte' | 'lte' | 'between'; value: number; value2?: number }
  | { field: string; kind: 'boolean'; op: 'eq'; value: boolean }
  | { field: string; kind: 'enum' | 'string'; op: 'eq' | 'ne' | 'in'; value: string | string[] }
export interface TransferFilter {
  fields?: string[]
  conditions?: FilterCondition[]
  /** 仅扫描预览生效；SeaTunnel 2.3.8 不支持搬运时限制行数。 */
  preview_rows?: number
}
export interface BrowsedEntry {
  path: string; kind: 'file' | 'directory'; size?: number; modified_at?: string
  format?: string; data_kind?: ContentKind; transferable?: boolean; inspectable?: boolean; object_ref?: string
}
export interface BrowseResult { directory: string; entries: BrowsedEntry[]; truncated: boolean }
export interface BrowseCapability {
  datasource_id: string; type: string
  listing: boolean; scanning: boolean
  structured_formats?: string[]
  /** 不支持时的原因，直接展示给用户。 */
  reason?: string
}
export async function datasourceCapability(id: string) {
  return api.get<unknown, BrowseCapability>(`/portal/datasources/${id}/capability`)
}
export async function browseDatasource(id: string, path = '') {
  return api.get<unknown, BrowseResult>(`/portal/datasources/${id}/files?path=${encodeURIComponent(path)}`)
}
export async function scanDatasourceFile(id: string, file: string, sampleRows = 20) {
  return api.post<unknown, ScannedSchema>(`/portal/datasources/${id}/scan`, { file, sample_rows: sampleRows })
}
export interface DatabaseSchema { name: string; object_ref: string }
export interface DatabaseRelation {
  name: string; schema: string; qualified_name: string; relation_type: 'table' | 'view'
  object_ref: string; inspectable: boolean; transferable: boolean
}
export async function listDatabaseSchemas(id: string, cursor?: string) {
  return api.get<unknown, { items: DatabaseSchema[]; next_cursor?: string | null; truncated: boolean }>(`/portal/datasources/${id}/database/schemas`, {
    params: { cursor: cursor || undefined },
  })
}
export async function listDatabaseRelations(id: string, schemaRef: string, cursor?: string) {
  return api.get<unknown, { items: DatabaseRelation[]; next_cursor?: string | null; truncated: boolean }>(`/portal/datasources/${id}/database/relations`, {
    params: { schema_ref: schemaRef, cursor: cursor || undefined },
  })
}
export async function inspectDatabaseRelation(id: string, objectRef: string, sampleRows = 20) {
  return api.post<unknown, ScannedSchema>(`/portal/datasources/${id}/database/inspect`, {
    object_ref: objectRef, sample_rows: sampleRows,
  })
}

export interface TransferPlan {
  input: { datasource_id: string; files: string[] }
  output: { target: string; datasource_id?: string; path?: string; format?: string }
  content_kind?: ContentKind
  filter?: TransferFilter
  columns: Array<{ name: string; type: string }>
  format?: string
  output_format?: string
}
export interface TransferOutputPlan {
  target: 'staging-dir' | 'datasource'; datasource_id?: string; path?: string
  format?: 'csv' | 'tsv' | 'json' | 'jsonl' | 'parquet' | 'orc' | 'binary'
}
export interface DatabaseTransferPlan {
  plan_kind: 'database'
  input: { datasource_id: string; relation: string }
  output: TransferOutputPlan
  columns: Array<{ name: string; type: string }>
  output_format: 'csv' | 'tsv' | 'json' | 'jsonl' | 'parquet' | 'orc'
  filter?: TransferFilter
}
export interface StructuredFileTransferPlan {
  plan_kind: 'structured-file'
  input: { datasource_id: string; files: string[] }
  output: TransferOutputPlan
  columns: Array<{ name: string; type: string }>
  input_format: 'csv' | 'tsv' | 'json' | 'jsonl' | 'parquet' | 'orc'
  output_format: 'csv' | 'tsv' | 'json' | 'jsonl' | 'parquet' | 'orc'
  filter?: TransferFilter
}
export interface BinaryFileTransferPlan {
  plan_kind: 'binary-file'
  input: { datasource_id: string; files: string[] }
  output: TransferOutputPlan
}
export type TypedTransferPlan = DatabaseTransferPlan | StructuredFileTransferPlan | BinaryFileTransferPlan
export interface SeaTunnelJobConfig { env: Record<string, unknown>; source: Array<Record<string, unknown>>; sink: Array<Record<string, unknown>> }
export interface TransferTask {
  channel: 'transfers'; registers_compute_input: false
  id: string; plan: TransferPlan | TypedTransferPlan; config: SeaTunnelJobConfig; state: string; job_id?: string; engine_status?: string
  created_at: string; updated_at: string; error?: { phase: string; message: string; retryable: boolean }
}
/** 合并入口的任务列表：两类任务保留各自记录，靠 channel 区分。 */
export type Movement = IngestionTask | TransferTask
export const isIngestion = (task: Movement): task is IngestionTask => task.channel === 'extractions'
export async function listMovements(channel: 'all' | 'extractions' | 'transfers' = 'all') {
  return api.get<unknown, Movement[]>(`/portal/movements?channel=${channel}`)
}
export async function transferForm() { return api.get<unknown, TransferForm>('/portal/transfers/form') }
export async function previewDatabaseTransfer(plan: DatabaseTransferPlan) {
  return api.post<unknown, { channel: 'transfers'; registers_compute_input: false; config: SeaTunnelJobConfig }>('/portal/transfers/database/preview', plan)
}
export async function previewStructuredFileTransfer(plan: StructuredFileTransferPlan) {
  return api.post<unknown, { channel: 'transfers'; registers_compute_input: false; config: SeaTunnelJobConfig }>('/portal/transfers/files/structured/preview', plan)
}
export async function previewBinaryFileTransfer(plan: BinaryFileTransferPlan) {
  return api.post<unknown, { channel: 'transfers'; registers_compute_input: false; config: SeaTunnelJobConfig }>('/portal/transfers/files/binary/preview', plan)
}
export async function createDatabaseTransfer(body: DatabaseTransferPlan & { request_key: string }) {
  return api.post<unknown, TransferTask>('/portal/transfers/database', body)
}
export async function createStructuredFileTransfer(body: StructuredFileTransferPlan & { request_key: string }) {
  return api.post<unknown, TransferTask>('/portal/transfers/files/structured', body)
}
export async function createBinaryFileTransfer(body: BinaryFileTransferPlan & { request_key: string }) {
  return api.post<unknown, TransferTask>('/portal/transfers/files/binary', body)
}
export async function prepareDatabaseExtraction(body: {
  request_key: string; resource_ref: string; resource_version: string; staging_backend: 'directory' | 's3'
  input: { datasource_id: string; relation: string }; columns: Array<{ name: string; type: string }>
  filter?: TransferFilter
}) {
  return api.post<unknown, IngestionTask & { extraction_id: string }>('/portal/extractions/database/prepare', body)
}
export async function prepareStructuredFileExtraction(body: {
  request_key: string; resource_ref: string; resource_version: string; staging_backend: 'directory' | 's3'
  input: { datasource_id: string; files: string[] }; columns: Array<{ name: string; type: string }>
  input_format: 'csv' | 'tsv' | 'json' | 'jsonl' | 'parquet' | 'orc'
  filter?: TransferFilter
}) {
  return api.post<unknown, IngestionTask & { extraction_id: string }>('/portal/extractions/files/structured/prepare', body)
}
export async function listTransfers() { return api.get<unknown, TransferTask[]>('/portal/transfers') }
export async function getTransfer(id: string) { return api.get<unknown, TransferTask>(`/portal/transfers/${id}`) }
export async function runTransfer(id: string) { return api.post<unknown, TransferTask>(`/portal/transfers/${id}/run`) }

export async function getFileServiceStatus() {
  return api.get<unknown, FileServiceStatus>('/portal/files/status')
}

export interface FileListResult {
  files: FileEntry[]
  /** 节点侧单目录最多返回 5000 条，为 true 时列表不完整。 */
  truncated: boolean
}

export async function listFiles(path = '') {
  return api.get<unknown, FileListResult>('/portal/files', { params: { path } })
}

export async function uploadFile(path: string, file: File) {
  return api.put('/portal/files', file, {
    params: { path, filename: file.name },
    headers: { 'Content-Type': 'application/octet-stream' },
    timeout: 0,
  })
}

export async function createFolder(path: string) {
  return api.post<unknown, FileEntry>('/portal/files/mkdir', { path })
}

/** 目录必须显式 recursive，否则节点侧对非空目录返回 409。 */
export async function deleteEntry(path: string, recursive: boolean) {
  return api.post<unknown, { deleted: string }>('/portal/files/delete', { path, recursive })
}

export async function renameEntry(source: string, destination: string) {
  return api.post<unknown, FileEntry>('/portal/files/rename', { source, destination })
}

export async function downloadFile(path: string, filename: string) {
  const grant = await api.post<unknown, { ticket: string }>('/portal/files/download-ticket', { path })
  const a = document.createElement('a')
  a.href = `/portal/files/download?ticket=${encodeURIComponent(grant.ticket)}`
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

export async function listResources() {
  return api.get<unknown, ResourceItem[]>('/portal/resources')
}

export async function registerResource(body: ResourceRegister) {
  return api.post<unknown, ResourceItem>('/portal/resources/register', body)
}

export async function updateResource(id: string, body: ResourceRegister) {
  return api.put<unknown, ResourceItem>(`/portal/resources/${id}`, body)
}

export async function publishResource(id: string) {
  return api.post<unknown, { resource: ResourceItem; catalog: unknown }>(`/portal/resources/${id}/publish`, {})
}

export async function deleteResource(id: string) {
  return api.delete<unknown, { deleted: string }>(`/portal/resources/${id}`)
}

export async function cleanupExtraction(id: string) { return api.post(`/portal/extractions/${id}/cleanup`) }
