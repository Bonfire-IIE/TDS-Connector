import { useState } from 'react'
import { Alert, Breadcrumb, Button, Card, Space, Table, Tag, Upload, message } from 'antd'
import { DownloadOutlined, FileOutlined, FolderOpenOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { downloadFile, getFileServiceStatus, listFiles, uploadFile, type FileEntry } from '../api/portal'

function sizeLabel(size?: number) {
  if (size === undefined) return '—'
  if (size < 1024) return `${size} B`
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 ** 2).toFixed(1)} MB`
}

export default function DataFiles() {
  const qc = useQueryClient()
  const [current, setCurrent] = useState('')
  const status = useQuery({ queryKey: ['file-service-status'], queryFn: getFileServiceStatus })
  const files = useQuery({ queryKey: ['data-files', current], queryFn: () => listFiles(current), enabled: status.data?.available === true })
  const upload = useMutation({
    mutationFn: (file: File) => uploadFile(current, file),
    onSuccess: () => { message.success('上传成功'); qc.invalidateQueries({ queryKey: ['data-files', current] }) },
    onError: (e: any) => message.error(e.response?.data?.detail ?? '上传失败'),
  })
  const parts = current ? current.split('/').filter(Boolean) : []
  const crumbs = [{ title: <a onClick={() => setCurrent('')}>根目录</a> }, ...parts.map((part, i) => ({ title: <a onClick={() => setCurrent(parts.slice(0, i + 1).join('/'))}>{part}</a> }))]

  if (!status.isLoading && !status.data?.available) {
    return <Card title="数据文件"><Alert type="warning" showIcon message="节点文件服务尚未就绪" description={`${status.data?.message ?? '未配置文件服务'}。Portal 不会直接访问或修改 Kuscia Lite 的数据目录，请先完成节点文件服务部署。`} /></Card>
  }

  return <Card title="数据文件" extra={<Space><Button icon={<ReloadOutlined />} onClick={() => files.refetch()}>刷新</Button><Upload showUploadList={false} beforeUpload={(file) => { upload.mutate(file); return false }}><Button type="primary" loading={upload.isPending} icon={<UploadOutlined />}>上传到当前目录</Button></Upload></Space>}>
    <Alert type="info" showIcon style={{ marginBottom: 16 }} message="文件操作由本节点文件服务执行，Portal 不直接访问 Kuscia Lite 挂载目录。" />
    <Breadcrumb items={crumbs} style={{ marginBottom: 16 }} />
    <Table<FileEntry> rowKey="path" loading={files.isLoading || status.isLoading} dataSource={files.data ?? []} pagination={false} columns={[
      { title: '名称', dataIndex: 'name', render: (v, r) => r.type === 'directory' ? <Button type="link" icon={<FolderOpenOutlined />} onClick={() => setCurrent(r.path)}>{v}</Button> : <Space><FileOutlined />{v}</Space> },
      { title: '类型', dataIndex: 'type', width: 110, render: (v) => <Tag color={v === 'directory' ? 'blue' : 'default'}>{v === 'directory' ? '目录' : '文件'}</Tag> },
      { title: '大小', dataIndex: 'size', width: 130, render: sizeLabel },
      { title: '修改时间', dataIndex: 'modified_at', width: 200, render: (v) => v ? new Date(v).toLocaleString() : '—' },
      { title: '操作', width: 100, render: (_, r) => r.type === 'file' ? <Button type="link" icon={<DownloadOutlined />} onClick={() => downloadFile(r.path, r.name)}>下载</Button> : null },
    ]} />
  </Card>
}
