/**
 * 源文件选择器：能列目录就给可选清单，不能就退回手填。
 *
 * 不支持浏览的源（sftp/jdbc）由后端 capability 明确给出原因，这里原样展示，
 * 而不是给一个空列表让用户以为没有文件。
 */
import { useEffect, useState } from 'react'
import { Alert, Breadcrumb, Button, Input, Space, Table, Tag, Tooltip, Typography } from 'antd'
import { FileOutlined, FolderOutlined, ReloadOutlined } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { browseDatasource, BrowseCapability, BrowsedEntry } from '../../api/portal'
const { Text } = Typography

const bytes = (n?: number) => n === undefined ? '—' : n >= 1048576 ? `${(n / 1048576).toFixed(2)} MiB` : `${n} B`
const errorText = (e: any) => String(e?.response?.data?.detail || e?.message || '读取失败')

export default function FilePicker({ datasourceId, capability, value, onChange, onFormatChange, multiple }: {
  datasourceId?: string
  capability?: BrowseCapability
  value: string[]
  onChange: (files: string[]) => void
  onFormatChange?: (format: string, dataKind?: 'structured' | 'unstructured') => void
  multiple: boolean
}) {
  const [directory, setDirectory] = useState('')
  const [manual, setManual] = useState('')
  useEffect(() => { setDirectory('') }, [datasourceId])

  const canList = !!datasourceId && capability?.listing === true
  const listing = useQuery({
    queryKey: ['datasource-files', datasourceId, directory],
    queryFn: () => browseDatasource(datasourceId!, directory),
    enabled: canList, retry: false,
  })

  // 不能浏览时保留手填：用户仍要能干活。
  if (!canList) {
    return <Space direction="vertical" style={{ width: '100%' }}>
      {capability?.reason && <Alert type="info" showIcon message={capability.reason} />}
      <Input.TextArea aria-label="手填文件路径" rows={multiple ? 3 : 1}
        placeholder={multiple ? '每行一个相对路径，例如 customers/input.csv' : 'customers/input.csv'}
        value={value.join('\n')}
        onChange={event => onChange(event.target.value.split('\n').map(x => x.trim()).filter(Boolean))} />
      <Text type="secondary">相对登记根目录的路径{multiple ? '；多个文件须位于同一目录' : ''}。</Text>
    </Space>
  }

  const segments = directory ? directory.split('/') : []
  const toggle = (file: string) => {
    if (!multiple) { onChange([file]); return }
    onChange(value.includes(file) ? value.filter(x => x !== file) : [...value, file])
  }
  const select = (row: BrowsedEntry) => {
    toggle(row.path)
    if (!value.includes(row.path) && row.format) onFormatChange?.(row.format, row.data_kind)
  }

  return <Space direction="vertical" style={{ width: '100%' }} size={8}>
    <Space wrap>
      <Breadcrumb items={[
        { title: <a onClick={() => setDirectory('')}>根目录</a> },
        ...segments.map((name, index) => ({
          title: index === segments.length - 1 ? name
            : <a onClick={() => setDirectory(segments.slice(0, index + 1).join('/'))}>{name}</a>,
        })),
      ]} />
      <Button size="small" icon={<ReloadOutlined />} onClick={() => listing.refetch()}>刷新</Button>
    </Space>
    {listing.isError && <Alert type="error" showIcon message="无法列出文件" description={errorText(listing.error)} />}
    {listing.data?.truncated && <Alert type="warning" showIcon message="该目录条目过多，仅显示前若干条；可进入子目录或改用手填" />}
    <Table size="small" rowKey="path" loading={listing.isLoading} pagination={{ pageSize: 8, size: 'small' }}
      dataSource={listing.data?.entries || []}
      rowClassName={(row: BrowsedEntry) => value.includes(row.path) ? 'ant-table-row-selected' : ''}
      columns={[
        { title: '名称', render: (_: unknown, row: BrowsedEntry) => <Space size={6}>
            {row.kind === 'directory' ? <FolderOutlined /> : <FileOutlined />}
            {row.kind === 'directory'
              ? <a onClick={() => setDirectory(row.path)}>{row.path.split('/').pop()}</a>
              : <span>{row.path.split('/').pop()}</span>}
            {value.includes(row.path) && <Tag color="blue">已选</Tag>}
          </Space> },
        { title: '大小', dataIndex: 'size', width: 110, render: bytes },
        { title: '修改时间', dataIndex: 'modified_at', width: 170,
          render: (v?: string) => v ? new Date(v).toLocaleString() : '—' },
        { title: '操作', width: 90, render: (_: unknown, row: BrowsedEntry) => row.kind === 'file'
            ? <Tooltip title={row.transferable === false ? '该格式可查看结构，但当前 SeaTunnel 通道不能直接搬运' : undefined}>
              <Button type="link" size="small" disabled={row.transferable === false} onClick={() => select(row)}>
                {value.includes(row.path) ? '取消' : multiple ? '添加' : '选择'}
              </Button></Tooltip>
            : null },
      ]} />
    <Space wrap>
      <Text strong>已选 {value.length} 个：</Text>
      {value.length ? value.map(file => <Tag key={file} closable onClose={() => onChange(value.filter(x => x !== file))}>{file}</Tag>)
        : <Text type="secondary">尚未选择</Text>}
    </Space>
    <Space.Compact style={{ width: '100%' }}>
      <Input aria-label="补充文件路径" placeholder="也可手填相对路径后点添加" value={manual}
        onChange={event => setManual(event.target.value)} />
      <Button onClick={() => {
        const file = manual.trim()
        if (!file) return
        onChange(multiple ? [...new Set([...value, file])] : [file])
        setManual('')
      }}>添加</Button>
    </Space.Compact>
  </Space>
}
