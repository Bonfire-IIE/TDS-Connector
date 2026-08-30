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
  domain_id: string
  connector_id: string
  lite: LiteStatus
  master: { endpoint: string }
  storage_root: string
}

export interface DataSourceItem {
  id: string
  name: string
  type: string
  kuscia_datasource_id: string
  uri: string | null
  info: Record<string, unknown> | null
  access_directly?: boolean
  created_by?: string
  created_at?: string
}

export interface DataSourceCreate {
  name: string
  type: 'localfs' | 'oss'
  uri?: string
  info: Record<string, unknown>
  access_directly?: boolean
}

export interface FileServiceStatus {
  available: boolean
  /** 本机 Lite 的域网关地址（文件服务经它路由，没有固定地址）。 */
  endpoint?: string
  /** 网关路由用的 Host，形如 filesvc-<domain>-http.<domain>.svc。 */
  service_host?: string
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
  name: string
  tds_code?: string | null
  data_type: string
  security_level: string
  kuscia_domaindata_id?: string | null
  relative_uri?: string | null
  datasource_name?: string | null
  status: string
  created_at: string
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

// 删除：路径带门户记录 id，query 带 Kuscia 数据源 id（本地 Lite 删除用）。
export async function deleteDatasource(id: string, kuscia_datasource_id: string) {
  return api.delete<unknown, { deleted: string }>(`/portal/datasources/${id}`, {
    params: { kuscia_datasource_id },
  })
}

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

export async function listProjects() { return api.get<unknown, any[]>('/portal/projects') }
export async function getProject(id: string) { return api.get<unknown, any>(`/portal/projects/${id}`) }
export async function getJobLog(jobId: string, taskId?: string) { return api.get<unknown, any>(`/portal/jobs/${jobId}/log`, { params: taskId ? { task_id: taskId } : undefined }) }

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
