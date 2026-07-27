import { api } from './client'

// 注：api 的响应拦截已把 {code,message,data} 解包为 data，
// 故这里用 axios 的第二个泛型参数 R 声明「实际返回值」类型。

export interface LoginResp {
  access_token: string
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
  backend: 'remote'
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

export async function listFiles(path = '') {
  return api.get<unknown, FileEntry[]>('/portal/files', { params: { path } })
}

export async function uploadFile(path: string, file: File) {
  return api.put('/portal/files', file, {
    params: { path, filename: file.name },
    headers: { 'Content-Type': 'application/octet-stream' },
    timeout: 0,
  })
}

export async function downloadFile(path: string, filename: string) {
  const blob = await api.get<unknown, Blob>('/portal/files/download', { params: { path }, responseType: 'blob', timeout: 0 })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export async function listResources() {
  return api.get<unknown, ResourceItem[]>('/portal/resources')
}
