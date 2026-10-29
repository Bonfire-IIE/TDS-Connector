import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Alert, Breadcrumb, Button, Card, Empty, Flex, Form, Input, Modal, Popconfirm, Segmented, Space, Spin, Table, Tag, Tooltip, Typography, Upload, message } from 'antd'
import { AppstoreOutlined, ArrowLeftOutlined, CloudOutlined, DeleteOutlined, DownloadOutlined, EditOutlined, FileOutlined, FolderAddOutlined, FolderOpenOutlined, HomeOutlined, ReloadOutlined, UnorderedListOutlined, UploadOutlined } from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFolder, deleteEntry, downloadFile, getFileServiceStatus, listFiles, renameEntry, uploadFile, type FileEntry } from '../api/portal'

const { Text, Title } = Typography

function sizeLabel(size?: number) {
  if (size === undefined) return '—'
  if (size < 1024) return `${size} B`
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`
  return `${(size / 1024 ** 3).toFixed(1)} GB`
}

function timeLabel(value?: string) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

/** 后端返回 {detail}，取不到时退回通用文案。 */
function errText(e: any, fallback: string) {
  return e?.response?.data?.detail ?? e?.message ?? fallback
}

const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)

export default function DataFiles() {
  const qc = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedPath = searchParams.get('path') || ''
  const safePath = !requestedPath.startsWith('/') && !requestedPath.includes('\\') && !requestedPath.split('/').some(part => part === '..' || part === '.')
  const [current, setCurrentState] = useState(safePath ? requestedPath : '')
  const setCurrent = (path: string) => {
    setCurrentState(path)
    setSearchParams(params => { if (path) params.set('path', path); else params.delete('path'); return params }, { replace: true })
  }
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [folderOpen, setFolderOpen] = useState(false)
  const [renaming, setRenaming] = useState<FileEntry | null>(null)
  const [folderForm] = Form.useForm<{ name: string }>()
  const [renameForm] = Form.useForm<{ name: string }>()

  const status = useQuery({ queryKey: ['file-service-status'], queryFn: getFileServiceStatus })
  const files = useQuery({
    queryKey: ['data-files', current],
    queryFn: () => listFiles(current),
    enabled: status.data?.available === true,
    refetchInterval: 5000,
    refetchOnWindowFocus: true,
  })

  const refresh = () => qc.invalidateQueries({ queryKey: ['data-files', current] })

  const upload = useMutation({
    mutationFn: (file: File) => uploadFile(current, file),
    onSuccess: () => { message.success('上传成功'); refresh() },
    onError: (e: any) => message.error(errText(e, '上传失败')),
  })
  const mkdir = useMutation({
    mutationFn: (name: string) => createFolder(joinPath(current, name)),
    onSuccess: () => { message.success('文件夹已创建'); setFolderOpen(false); folderForm.resetFields(); refresh() },
    onError: (e: any) => message.error(errText(e, '创建失败')),
  })
  const remove = useMutation({
    // 目录一律带 recursive：界面上已经二次确认过，不必再让用户理解 409。
    mutationFn: (entry: FileEntry) => deleteEntry(entry.path, entry.type === 'directory'),
    onSuccess: () => { message.success('已删除'); refresh() },
    onError: (e: any) => message.error(errText(e, '删除失败')),
  })
  const rename = useMutation({
    mutationFn: ({ entry, name }: { entry: FileEntry; name: string }) =>
      renameEntry(entry.path, joinPath(current, name)),
    onSuccess: () => { message.success('已重命名'); setRenaming(null); refresh() },
    onError: (e: any) => message.error(errText(e, '重命名失败')),
  })

  const parts = current ? current.split('/').filter(Boolean) : []
  const parent = parts.slice(0, -1).join('/')
  const entries = useMemo(() => [...(files.data?.files ?? [])].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    if (a.type === 'file') {
      const modified = Date.parse(b.modified_at ?? '') - Date.parse(a.modified_at ?? '')
      if (Number.isFinite(modified) && modified !== 0) return modified
    }
    return a.name.localeCompare(b.name, 'zh-CN')
  }), [files.data])
  const crumbs = [
    { title: <a onClick={() => setCurrent('')}><HomeOutlined /> 我的文件</a> },
    ...parts.map((part, i) => ({ title: <a onClick={() => setCurrent(parts.slice(0, i + 1).join('/'))}>{part}</a> })),
  ]

  if (!status.isLoading && !status.data?.available) {
    return <Card title="数据文件"><Alert type="warning" showIcon message="Lite 节点文件空间尚未就绪" description={`${status.data?.message ?? 'Lite KusciaAPI 不可用'}。请确认节点已启动并完成接入。`} /></Card>
  }

  const open = (entry: FileEntry) => entry.type === 'directory' ? setCurrent(entry.path) : downloadFile(entry.path, entry.name)

  const startRename = (entry: FileEntry) => {
    setRenaming(entry)
    renameForm.setFieldsValue({ name: entry.name })
  }

  const deleteButton = (entry: FileEntry, asLink: boolean) => (
    <Popconfirm
      title={entry.type === 'directory' ? '删除该文件夹及其全部内容？' : '删除该文件？'}
      description={entry.type === 'directory' ? entry.path : undefined}
      okButtonProps={{ danger: true, loading: remove.isPending }}
      okText="删除" cancelText="取消"
      onConfirm={() => remove.mutate(entry)}
    >
      <Button danger type={asLink ? 'link' : 'text'} icon={<DeleteOutlined />}>
        {asLink ? '删除' : undefined}
      </Button>
    </Popconfirm>
  )
  const renameButton = (entry: FileEntry, asLink: boolean) => (
    <Tooltip title="重命名">
      <Button type={asLink ? 'link' : 'text'} icon={<EditOutlined />} onClick={() => startRename(entry)}>
        {asLink ? '重命名' : undefined}
      </Button>
    </Tooltip>
  )

  const toolbar = <Space wrap>
    <Tooltip title={current ? '返回上一级' : '已经是根目录'}><Button disabled={!current} icon={<ArrowLeftOutlined />} onClick={() => setCurrent(parent)} /></Tooltip>
    <Button icon={<ReloadOutlined />} onClick={() => files.refetch()}>刷新</Button>
    <Segmented value={view} onChange={(v) => setView(v as 'grid' | 'list')} options={[{ value: 'grid', icon: <AppstoreOutlined /> }, { value: 'list', icon: <UnorderedListOutlined /> }]} />
    <Button icon={<FolderAddOutlined />} onClick={() => setFolderOpen(true)}>新建文件夹</Button>
    <Upload showUploadList={false} multiple beforeUpload={(file) => { upload.mutate(file); return false }}>
      <Button type="primary" loading={upload.isPending} icon={<UploadOutlined />}>上传文件</Button>
    </Upload>
  </Space>

  return <Card styles={{ body: { padding: 0 } }}>
    <div style={{ padding: '22px 24px 16px', borderBottom: '1px solid #f0f0f0' }}>
      <Flex justify="space-between" align="center" wrap gap={16}>
        <Space size="middle"><CloudOutlined style={{ fontSize: 28, color: '#1677ff' }} /><div>
          <Title level={4} style={{ margin: 0 }}>数据文件</Title>
          <Text type="secondary">Kuscia Lite 节点文件空间 · Lite 内置文件服务</Text>
        </div></Space>
        {toolbar}
      </Flex>
      <Breadcrumb items={crumbs} style={{ marginTop: 20 }} />
      {current && <Typography.Paragraph copyable={{ text: current }} style={{ marginTop: 12, marginBottom: 0 }}><Text type="secondary">当前目录：</Text><Text code>{current}</Text></Typography.Paragraph>}
      {!safePath && <Alert style={{ marginTop: 12 }} type="warning" showIcon message="结果目录无效，已返回文件根目录。" />}
      {files.data?.truncated ? <Alert style={{ marginTop: 12 }} type="warning" showIcon message="该目录条目超过 5000 项，列表已被节点截断，未全部显示" /> : null}
    </div>

    <Spin spinning={files.isLoading || status.isLoading}>
      {entries.length === 0 && !files.isLoading ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={current ? '此文件夹为空' : '暂无文件'} style={{ padding: 72 }} /> : view === 'grid' ?
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 16, padding: 24 }}>
          {entries.map((entry) => <Card key={entry.path} hoverable onDoubleClick={() => open(entry)} styles={{ body: { padding: 16 } }}>
            <Flex vertical align="center" gap={10}>
              {entry.type === 'directory' ? <FolderOpenOutlined style={{ fontSize: 48, color: '#2563eb' }} /> : <FileOutlined style={{ fontSize: 44, color: '#64748b' }} />}
              <Tooltip title={entry.name}><Text strong ellipsis style={{ width: '100%', textAlign: 'center' }}>{entry.name}</Text></Tooltip>
              <Text type="secondary" style={{ fontSize: 12 }}>{entry.type === 'directory' ? '文件夹' : sizeLabel(entry.size)}</Text>
              <Space size={0}>
                {entry.type === 'directory'
                  ? <Button type="link" onClick={() => setCurrent(entry.path)}>打开</Button>
                  : <Button type="link" icon={<DownloadOutlined />} onClick={() => downloadFile(entry.path, entry.name)}>下载</Button>}
                {renameButton(entry, false)}
                {deleteButton(entry, false)}
              </Space>
            </Flex>
          </Card>)}
        </div> :
        <Table<FileEntry> rowKey="path" dataSource={entries} pagination={false} onRow={(entry) => ({ onDoubleClick: () => open(entry) })} columns={[
          { title: '名称', dataIndex: 'name', render: (v, r) => r.type === 'directory' ? <Button type="link" icon={<FolderOpenOutlined />} onClick={() => setCurrent(r.path)}>{v}</Button> : <Space><FileOutlined style={{ color: '#64748b' }} />{v}</Space> },
          { title: '类型', dataIndex: 'type', width: 110, render: (v) => <Tag color={v === 'directory' ? 'blue' : undefined}>{v === 'directory' ? '文件夹' : '文件'}</Tag> },
          { title: '大小', dataIndex: 'size', width: 130, render: (_, r) => r.type === 'directory' ? '—' : sizeLabel(r.size) },
          { title: '修改时间', dataIndex: 'modified_at', width: 200, render: timeLabel },
          {
            title: '操作', width: 260, render: (_, r) => <Space size={0}>
              {r.type === 'file' ? <Button type="link" icon={<DownloadOutlined />} onClick={() => downloadFile(r.path, r.name)}>下载</Button> : null}
              {renameButton(r, true)}
              {deleteButton(r, true)}
            </Space>,
          },
        ]} />}
    </Spin>

    <Modal
      title="新建文件夹" open={folderOpen} okText="创建" cancelText="取消"
      confirmLoading={mkdir.isPending}
      onCancel={() => { setFolderOpen(false); folderForm.resetFields() }}
      onOk={() => folderForm.validateFields().then(({ name }) => mkdir.mutate(name.trim()))}
    >
      <Form form={folderForm} layout="vertical" preserve={false}>
        <Form.Item label="所在目录"><Text code>{current || '（根目录）'}</Text></Form.Item>
        <Form.Item
          name="name" label="文件夹名称"
          rules={[
            { required: true, message: '请输入文件夹名称' },
            // 目录层级由「所在目录」决定，名称里不允许再带路径，否则语义含糊。
            { pattern: /^[^/\\]+$/, message: '名称不能包含 / 或 \\' },
            { validator: (_, v) => (v === '.' || v === '..' ? Promise.reject(new Error('名称不合法')) : Promise.resolve()) },
          ]}
        >
          <Input placeholder="例如 inbound-2026-08" autoFocus />
        </Form.Item>
      </Form>
    </Modal>

    <Modal
      title="重命名" open={renaming !== null} okText="保存" cancelText="取消"
      confirmLoading={rename.isPending}
      onCancel={() => setRenaming(null)}
      onOk={() => renameForm.validateFields().then(({ name }) => renaming && rename.mutate({ entry: renaming, name: name.trim() }))}
    >
      <Form form={renameForm} layout="vertical" preserve={false}>
        <Form.Item label="原名称"><Text code>{renaming?.name}</Text></Form.Item>
        <Form.Item
          name="name" label="新名称"
          rules={[
            { required: true, message: '请输入新名称' },
            { pattern: /^[^/\\]+$/, message: '名称不能包含 / 或 \\' },
            { validator: (_, v) => (v === '.' || v === '..' ? Promise.reject(new Error('名称不合法')) : Promise.resolve()) },
          ]}
        >
          <Input autoFocus />
        </Form.Item>
      </Form>
    </Modal>
  </Card>
}
