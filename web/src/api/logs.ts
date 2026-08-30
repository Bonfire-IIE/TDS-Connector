import axios from 'axios'
import { api, TOKEN_KEY } from './client'

// 注：api 的响应拦截已把 {code,message,data} 解包为 data，
// 故这里用 axios 的第二个泛型参数 R 声明「实际返回值」类型。

export interface NodeLogFile {
  /** 节点上的绝对路径，查询时原样回传。 */
  path: string
  /** 相对日志根目录的路径，用于展示。 */
  name: string
  kind: 'component' | 'pod'
  category: string
  size: number
  /** Unix 秒。 */
  modified_time: number
  /** 已轮转，内容不再增长。 */
  rotated: boolean
  compressed: boolean
  pod?: {
    namespace: string
    pod_name: string
    container: string
    restart_count: number
  }
}

export interface NodeLogFiles {
  domain_id: string
  node_name: string
  run_mode: string
  files: NodeLogFile[]
}

export interface NodeLogTail {
  path: string
  lines: string[]
  requested_lines: number
  truncated: boolean
}

export async function listNodeLogFiles(kind?: string) {
  return api.get<unknown, NodeLogFiles>('/portal/logs/files', {
    params: kind ? { kind } : undefined,
  })
}

export async function tailNodeLog(path: string, lines: number, keyword?: string) {
  return api.get<unknown, NodeLogTail>('/portal/logs/tail', {
    params: { path, lines, keyword: keyword || undefined },
  })
}

/**
 * 导出要带 Bearer 头，没法用 <a download> 直链，故取回文本再走 Blob。
 * 该接口返回纯文本而非 {code,message,data}，所以绕开 api 实例的解包拦截。
 */
export async function downloadNodeLog(path: string, lines: number) {
  const token = sessionStorage.getItem(TOKEN_KEY)
  const resp = await axios.get<string>(`${api.defaults.baseURL ?? ''}/portal/logs/download`, {
    params: { path, lines },
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    responseType: 'text',
    transformResponse: [(v) => v],
    timeout: 0,
  })
  return resp.data
}

export interface FollowHandlers {
  onLines: (lines: string[]) => void
  onError: (message: string) => void
  onEnd: () => void
}

/**
 * SSE 跟随日志。用 fetch + ReadableStream 而非 EventSource：EventSource 无法
 * 自定义请求头，带不上 Bearer 令牌，改用查询串传令牌会把令牌写进访问日志。
 *
 * 返回值用于主动中止；中止会一路传导到 Kuscia，让节点上的 tail 及时退出。
 */
export function followNodeLog(
  path: string,
  lines: number,
  keyword: string | undefined,
  handlers: FollowHandlers,
): () => void {
  const controller = new AbortController()
  const qs = new URLSearchParams({ path, lines: String(lines) })
  if (keyword) qs.set('keyword', keyword)
  const token = sessionStorage.getItem(TOKEN_KEY)

  void (async () => {
    try {
      const resp = await fetch(`/portal/logs/stream?${qs}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
      })
      if (!resp.ok || !resp.body) {
        let detail = `日志流建立失败（HTTP ${resp.status}）`
        try {
          detail = (await resp.json())?.detail ?? detail
        } catch {
          /* 非 JSON 错误体，保留默认文案 */
        }
        handlers.onError(detail)
        return
      }

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        // SSE 以空行分隔事件；最后一段可能不完整，留到下一轮
        const events = buffer.split('\n\n')
        buffer = events.pop() ?? ''
        for (const raw of events) {
          let event = 'message'
          const dataParts: string[] = []
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim()
            else if (line.startsWith('data:')) dataParts.push(line.slice(5).trim())
            // 以 ':' 开头的是心跳注释帧，忽略
          }
          if (!dataParts.length) continue
          const payload = JSON.parse(dataParts.join('\n'))
          if (event === 'error') handlers.onError(payload.message ?? '日志流异常')
          else if (event === 'end') handlers.onEnd()
          else if (payload.lines?.length) handlers.onLines(payload.lines)
        }
      }
      handlers.onEnd()
    } catch (e: any) {
      if (e?.name !== 'AbortError') handlers.onError(e?.message ?? '日志流中断')
    }
  })()

  return () => controller.abort()
}
