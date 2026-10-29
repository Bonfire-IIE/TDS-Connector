import axios from 'axios'
import { TOKEN_KEY } from '../api/client'

export type Service = 'di' | 'dr' | 'ts'
export type Row = Record<string, any>
const http = axios.create({ baseURL: import.meta.env.VITE_PORTAL_API ?? '', timeout: 35000 })
http.interceptors.request.use(config => {
  const token = sessionStorage.getItem(TOKEN_KEY)
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})
export async function call(service: Service, path: string, method = 'GET', body?: unknown, headers?: Record<string, string>) {
  return (await http.request({ url: `/portal/services/${service}/${path}`, method, data: body, headers })).data
}
export async function capabilities() { return (await http.get('/portal/services/capabilities')).data }
export async function download(source: string, ref: string) {
  const response = await http.get(`/portal/services/di/datasources/${encodeURIComponent(source)}/files`, { params: { ref }, responseType: 'blob' })
  const url = URL.createObjectURL(response.data)
  const a = document.createElement('a'); a.href = url; a.download = ref.split('/').pop() || 'download'; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export function key() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
export function errorText(error: any): string {
  const value = error?.response?.data
  const code = typeof value?.error === 'string' ? value.error : value?.detail
  if (code === 'integration_rejected_422' || code === 'source_inspection_failed') return '无法读取源文件结构。请检查文件格式、编码及读取权限；CSV 支持 UTF-8、GB18030/GBK 和带 BOM 的 UTF-16。可先点击“探测字段”检查。'
  if (code === 'file_already_exists') return '当前目录已存在同名文件。请在本地重命名后重新上传，原文件不会被覆盖。'
  if (code === 'source_in_use') return '数据源仍被未完成的任务使用，请等待任务结束后再移除。'
  if (value?.detail && typeof value.detail === 'string') return value.detail
  if (value?.error) return typeof value.error === 'string' ? value.error : JSON.stringify(value.error)
  if (Array.isArray(value?.detail)) return value.detail.map((v: any) => `${v.loc?.join('.')}: ${v.msg}`).join('；')
  return error?.message || '请求失败，请稍后重试'
}
export const rows = (v: any): Row[] => Array.isArray(v) ? v : v?.items || []
export const enc = encodeURIComponent
