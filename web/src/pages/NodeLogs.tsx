import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Alert,
  Badge,
  Button,
  Card,
  Descriptions,
  Empty,
  Input,
  InputNumber,
  Radio,
  Select,
  Space,
  Switch,
  Tooltip,
  message,
} from 'antd'
import {
  ClearOutlined,
  DownloadOutlined,
  FileTextOutlined,
  ReloadOutlined,
  VerticalAlignBottomOutlined,
} from '@ant-design/icons'
import {
  downloadNodeLog,
  followNodeLog,
  listNodeLogFiles,
  tailNodeLog,
  type NodeLogFile,
} from '../api/logs'

// 前端缓冲上限：kuscia.log / k3s.log 写入极快，无上限会拖垮渲染。
const MAX_BUFFERED_LINES = 5000
// 流式追加合并到 state 的节流间隔，避免每批日志触发一次重渲染。
const FLUSH_INTERVAL_MS = 400

const CATEGORY_LABELS: Record<string, string> = {
  kuscia: 'Kuscia 主进程',
  kusciaapi: 'KusciaAPI 请求',
  k3s: 'k3s',
  'k3s-audit': 'k3s 审计',
  containerd: 'containerd',
  datamesh: 'DataMesh',
  envoy: 'Envoy 网关',
}

const RUN_MODE_LABELS: Record<string, string> = {
  lite: 'Lite（连接器）',
  master: 'Master（控制面）',
  autonomy: 'Autonomy（自治节点）',
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value.toFixed(1)} ${units[i]}`
}

function formatTime(unixSeconds: number): string {
  if (!unixSeconds) return '-'
  return new Date(unixSeconds * 1000).toLocaleString('zh-CN', { hour12: false })
}

function lineColor(line: string): string | undefined {
  if (/\b(ERROR|FATAL|PANIC)\b/.test(line)) return '#ff4d4f'
  if (/\bWARN(ING)?\b/.test(line)) return '#faad14'
  if (/\bDEBUG\b/.test(line)) return '#8c8c8c'
  return undefined
}

function renderLine(line: string, keyword: string) {
  if (!keyword) return line
  const idx = line.toLowerCase().indexOf(keyword.toLowerCase())
  if (idx < 0) return line
  return (
    <>
      {line.slice(0, idx)}
      <mark style={{ background: '#ffe58f', padding: 0 }}>
        {line.slice(idx, idx + keyword.length)}
      </mark>
      {line.slice(idx + keyword.length)}
    </>
  )
}

/** 文件在下拉框里的展示文案：pod 日志补上容器与重启轮次。 */
function fileLabel(f: NodeLogFile): string {
  const meta = [formatSize(f.size)]
  if (f.compressed) meta.push('已压缩')
  if (f.pod) meta.push(`容器 ${f.pod.container}`, `第 ${f.pod.restart_count} 次启动`)
  const name = f.pod ? `${f.pod.pod_name} / ${f.pod.container}` : f.name
  return `${name}  ·  ${meta.join('  ·  ')}`
}

type KindFilter = 'all' | 'component' | 'pod'

export default function NodeLogs() {
  const [kind, setKind] = useState<KindFilter>('all')
  const [filePath, setFilePath] = useState<string>()
  const [lines, setLines] = useState(500)
  const [keywordInput, setKeywordInput] = useState('')
  const [keyword, setKeyword] = useState('')
  const [following, setFollowing] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const [buffer, setBuffer] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [streamError, setStreamError] = useState<string>()

  const pending = useRef<string[]>([])
  const stopRef = useRef<(() => void) | null>(null)
  const viewRef = useRef<HTMLDivElement>(null)

  const filesQ = useQuery({
    queryKey: ['node-log-files', kind],
    queryFn: () => listNodeLogFiles(kind === 'all' ? undefined : kind),
  })
  const files = filesQ.data?.files ?? []

  // 默认选中 kuscia.log（排查最常用），否则退回第一个仍在写入的文件。
  useEffect(() => {
    if (!files.length) return
    if (filePath && files.some((f) => f.path === filePath)) return
    const preferred =
      files.find((f) => f.name === 'kuscia.log') ?? files.find((f) => !f.rotated) ?? files[0]
    setFilePath(preferred.path)
  }, [files, filePath])

  const stopFollow = () => {
    stopRef.current?.()
    stopRef.current = null
  }

  // 换文件或改过滤条件必须重建流：这些参数在服务端决定了 tail 的对象。
  useEffect(() => {
    stopFollow()
    setFollowing(false)
    setStreamError(undefined)
    setBuffer([])
    pending.current = []
  }, [filePath, keyword])

  useEffect(() => () => stopFollow(), [])

  useEffect(() => {
    if (!following) return
    const timer = setInterval(() => {
      if (!pending.current.length) return
      const incoming = pending.current
      pending.current = []
      setBuffer((prev) => {
        const next = prev.concat(incoming)
        return next.length > MAX_BUFFERED_LINES
          ? next.slice(next.length - MAX_BUFFERED_LINES)
          : next
      })
    }, FLUSH_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [following])

  useEffect(() => {
    if (autoScroll && viewRef.current) {
      viewRef.current.scrollTop = viewRef.current.scrollHeight
    }
  }, [buffer, autoScroll])

  const selectedFile = useMemo(
    () => files.find((f) => f.path === filePath),
    [files, filePath],
  )

  const loadTail = async () => {
    if (!filePath) return
    setLoading(true)
    setStreamError(undefined)
    try {
      const data = await tailNodeLog(filePath, lines, keyword || undefined)
      setBuffer(data.lines)
    } catch (e: any) {
      message.error(e.response?.data?.detail ?? '拉取日志失败')
    } finally {
      setLoading(false)
    }
  }

  const toggleFollow = (next: boolean) => {
    if (!filePath) return
    if (!next) {
      stopFollow()
      setFollowing(false)
      return
    }
    setBuffer([])
    pending.current = []
    setStreamError(undefined)
    setFollowing(true)
    setAutoScroll(true)
    stopRef.current = followNodeLog(filePath, lines, keyword || undefined, {
      onLines: (incoming) => pending.current.push(...incoming),
      onError: (msg) => {
        setStreamError(msg)
        setFollowing(false)
      },
      onEnd: () => setFollowing(false),
    })
  }

  const onDownload = async () => {
    if (!filePath) return
    try {
      const text = await downloadNodeLog(filePath, Math.max(lines, 1000))
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
      const a = document.createElement('a')
      a.href = url
      a.download = `${filesQ.data?.domain_id ?? 'node'}-${filePath.split('/').pop()}`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e: any) {
      // 导出走 responseType: text，错误体也是字符串形态的 JSON。
      const body = e.response?.data
      let detail: string | undefined
      try {
        detail = typeof body === 'string' ? JSON.parse(body)?.detail : body?.detail
      } catch {
        /* 非 JSON 错误体 */
      }
      message.error(detail ?? '导出失败')
    }
  }

  // 分组：正在写入的按组件/Pod 归类，轮转过的统一收到"历史轮转"里。
  const fileOptions = useMemo(() => {
    const groups = new Map<string, NodeLogFile[]>()
    for (const f of files) {
      let label: string
      if (f.rotated) label = '历史轮转'
      else if (f.kind === 'pod') label = '任务容器'
      else label = CATEGORY_LABELS[f.category] ?? f.category
      if (!groups.has(label)) groups.set(label, [])
      groups.get(label)!.push(f)
    }
    return [...groups.entries()].map(([label, items]) => ({
      label,
      options: items.map((f) => ({ value: f.path, label: fileLabel(f) })),
    }))
  }, [files])

  const node = filesQ.data

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {filesQ.isError && (
        <Alert
          type="error"
          showIcon
          message="无法获取本节点日志清单"
          description={
            (filesQ.error as any)?.response?.data?.detail ??
            '请确认本机 Lite 可达，且其 Kuscia 版本已包含节点日志接口。'
          }
        />
      )}

      <Card size="small">
        <Descriptions size="small" column={3} colon={false}>
          <Descriptions.Item label="节点域">{node?.domain_id || '-'}</Descriptions.Item>
          <Descriptions.Item label="运行模式">
            {node ? (RUN_MODE_LABELS[node.run_mode] ?? node.run_mode) : '-'}
          </Descriptions.Item>
          <Descriptions.Item label="节点名">{node?.node_name || '-'}</Descriptions.Item>
        </Descriptions>
        <div style={{ color: '#8c8c8c', fontSize: 12 }}>
          日志经本机 Lite 的 KusciaAPI 读取，只包含本节点；其它连接器与平台控制面的日志需在各自的控制台查看。
        </div>
      </Card>

      <Card
        title={
          <Space>
            <FileTextOutlined />
            本节点日志
            {following ? (
              <Badge status="processing" text="实时跟随中" />
            ) : (
              <Badge status="default" text="已暂停" />
            )}
          </Space>
        }
        extra={
          <Space>
            <Tooltip title="重新拉取当前文件尾部">
              <Button
                icon={<ReloadOutlined />}
                onClick={loadTail}
                loading={loading}
                disabled={!filePath || following}
              >
                拉取
              </Button>
            </Tooltip>
            <Button icon={<DownloadOutlined />} onClick={onDownload} disabled={!filePath}>
              导出
            </Button>
            <Button icon={<ClearOutlined />} onClick={() => setBuffer([])}>
              清屏
            </Button>
          </Space>
        }
      >
        <Space wrap size="middle" style={{ marginBottom: 16 }}>
          <Radio.Group
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            optionType="button"
            buttonStyle="solid"
            options={[
              { value: 'all', label: '全部' },
              { value: 'component', label: '节点组件' },
              { value: 'pod', label: '任务容器' },
            ]}
          />
          <Select
            style={{ width: 420 }}
            placeholder="选择日志文件"
            value={filePath}
            onChange={setFilePath}
            loading={filesQ.isLoading}
            options={fileOptions}
            showSearch
            optionFilterProp="label"
            notFoundContent={filesQ.isLoading ? '加载中…' : '该分类下没有日志文件'}
          />
          <Space size={4}>
            尾部行数
            <InputNumber
              min={1}
              max={MAX_BUFFERED_LINES}
              step={100}
              value={lines}
              onChange={(v) => setLines(v ?? 500)}
              style={{ width: 100 }}
            />
          </Space>
          <Input.Search
            allowClear
            style={{ width: 240 }}
            placeholder="关键字过滤（服务端）"
            value={keywordInput}
            onChange={(e) => setKeywordInput(e.target.value)}
            onSearch={(v) => setKeyword(v.trim())}
            enterButton="过滤"
          />
          <Space>
            实时跟随
            <Switch
              checked={following}
              onChange={toggleFollow}
              disabled={!filePath || selectedFile?.compressed}
            />
          </Space>
          <Space>
            <Tooltip title="有新日志时自动滚到底部">
              <VerticalAlignBottomOutlined />
            </Tooltip>
            <Switch size="small" checked={autoScroll} onChange={setAutoScroll} />
          </Space>
        </Space>

        {streamError && (
          <Alert
            type="error"
            showIcon
            closable
            style={{ marginBottom: 12 }}
            message="日志流中断"
            description={streamError}
            onClose={() => setStreamError(undefined)}
          />
        )}

        {selectedFile?.rotated && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message={
              selectedFile.compressed
                ? '这是已压缩的历史轮转文件，内容不再增长，无法实时跟随'
                : '这是历史文件，内容不再增长'
            }
          />
        )}

        <div
          ref={viewRef}
          onScroll={(e) => {
            const el = e.currentTarget
            // 用户往上翻时自动停掉跟随滚动，避免被新日志拽回底部
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
            if (!atBottom && autoScroll) setAutoScroll(false)
          }}
          style={{
            height: 'calc(100vh - 420px)',
            minHeight: 320,
            overflow: 'auto',
            background: '#1e1e1e',
            color: '#d4d4d4',
            borderRadius: 6,
            padding: '10px 14px',
            fontFamily: 'Menlo, Consolas, "Courier New", monospace',
            fontSize: 12,
            lineHeight: 1.6,
          }}
        >
          {buffer.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <span style={{ color: '#8c8c8c' }}>
                  {filePath ? '暂无内容，点击「拉取」或开启「实时跟随」' : '请选择日志文件'}
                </span>
              }
              style={{ marginTop: 80 }}
            />
          ) : (
            buffer.map((line, i) => (
              <div
                key={i}
                style={{ color: lineColor(line), whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
              >
                {renderLine(line, keyword)}
              </div>
            ))
          )}
        </div>

        <div style={{ marginTop: 8, color: '#8c8c8c', fontSize: 12 }}>
          共 {buffer.length} 行
          {buffer.length >= MAX_BUFFERED_LINES &&
            `（已达前端缓冲上限，仅保留最新 ${MAX_BUFFERED_LINES} 行）`}
          {selectedFile &&
            `　·　${selectedFile.path}　·　${formatSize(selectedFile.size)}　·　更新于 ${formatTime(selectedFile.modified_time)}`}
        </div>
      </Card>
    </Space>
  )
}
