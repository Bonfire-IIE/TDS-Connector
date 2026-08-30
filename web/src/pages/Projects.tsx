import { Card, Table, Tag, Typography, Button, Drawer, Descriptions, Space, Collapse, Alert } from 'antd'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { listProjects, getProject, getJobLog } from '../api/portal'
const { Text } = Typography
export default function Projects() {
  const q = useQuery({ queryKey: ['portal-projects'], queryFn: listProjects, refetchInterval: 15000 })
  const rows = Array.isArray(q.data) ? q.data : []
  const [id, setId] = useState<string>()
  const detail = useQuery({ queryKey: ['portal-project', id], queryFn: () => getProject(id!), enabled: !!id })
  const d: any = detail.data
  return <Card title="项目管理" loading={q.isLoading}><Table rowKey={(r: any) => r.id || r.project_id} dataSource={rows} pagination={{ pageSize: 8 }} columns={[{ title: '项目', dataIndex: 'name', render: (v: any, r: any) => <><Text strong>{v || r.project_id || r.id}</Text><br /><Text type="secondary" code>{r.project_id || r.id}</Text></> }, { title: '状态', dataIndex: 'status', render: (v: any) => <Tag>{v || '未知'}</Tag> }, { title: '更新时间', dataIndex: 'updated_at' }, { title: '操作', render: (_: any, r: any) => <Button type="link" onClick={() => setId(r.id || r.project_id)}>进入项目</Button> }]} locale={{ emptyText: '暂无可见项目' }} />
    <Drawer title="项目详情" width={760} open={!!id} onClose={() => setId(undefined)} loading={detail.isLoading}>{d && <Space direction="vertical" style={{ width: '100%' }}><Descriptions bordered size="small" column={1}><Descriptions.Item label="项目">{d.project?.name}</Descriptions.Item><Descriptions.Item label="状态"><Tag>{d.project?.status}</Tag></Descriptions.Item></Descriptions><Collapse items={(d.runs ?? []).map((run: any) => ({ key: run.id, label: `作业 ${run.id} · ${run.status}`, children: <JobLog jobId={run.kuscia_job_id || run.id} status={run.status} /> }))} /></Space>}</Drawer></Card>
}

function JobLog({ jobId, status }: { jobId: string; status?: string }) {
  const l = useQuery({ queryKey: ['job-log', jobId], queryFn: () => getJobLog(jobId), refetchInterval: 10000 })
  const detail = (l.error as any)?.response?.data?.detail ?? (l.error as any)?.message ?? ''
  const cleaned = /not found|不存在|not exist/i.test(String(detail))
  if (l.isError && cleaned) return <Alert type="warning" showIcon message="作业日志不可用" description={`该作业当前状态为“${status || '未知'}”，Kuscia 中的任务资源可能已清理，暂时没有归档日志可供查看。Job ID：${jobId}`} />
  if (l.isError) return <Alert type="error" showIcon message="日志获取失败" description={String(detail || 'Kuscia Log API 返回异常')} />
  return <pre style={{ maxHeight: 420, overflow: 'auto', background: '#111827', color: '#d1d5db', padding: 12, borderRadius: 6, fontSize: 12 }}>{JSON.stringify(l.data, null, 2)}</pre>
}
