import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, Button, Card, Empty, Input, message, Modal, Select, Space, Spin, Table, Tag, Typography } from 'antd'
import { ArrowLeftOutlined, CheckOutlined, CloseOutlined, ReloadOutlined } from '@ant-design/icons'
import { ComputationDelegation, decideComputationDelegation, listComputationDelegations } from '../api/computationDelegations'

const { Text, Title, Paragraph } = Typography
const statuses: Record<string, [string, string]> = {
  pending: ['待确认', 'gold'], active: ['已生效', 'green'], accepted: ['已接受', 'green'],
  effective: ['已生效', 'green'], revoked: ['已撤回', 'default'], rejected: ['已拒绝', 'red'],
  expired: ['已过期', 'default'], superseded: ['已被替代', 'default'],
}
const statusTag = (status: string) => <Tag color={statuses[status]?.[1]}>{statuses[status]?.[0] || status}</Tag>
const dateText = (date?: string) => date ? new Date(date).toLocaleString('zh-CN') : '—'
const errorText = (error: any) => error?.response?.data?.detail || error?.response?.data?.message || error?.message || '操作失败'
const isExpired = (row: ComputationDelegation) => Boolean(row.expires_at && new Date(row.expires_at).getTime() <= Date.now())
function selfDecision(row: ComputationDelegation, connectorId: string) {
  return row.decisions?.find(d => d.connector_id === (row.participant?.connector_id || connectorId) && d.kind !== 'business')
}

export default function ComputationDelegations() {
  const navigate = useNavigate()
  const { delegationId } = useParams()
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [confirm, setConfirm] = useState<{ row: ComputationDelegation; decision: 'accepted' | 'rejected' }>()
  const inbox = useQuery({ queryKey: ['computation-delegations'], queryFn: listComputationDelegations, refetchInterval: 15000 })
  const items = inbox.data?.items || []
  const connectorId = inbox.data?.connector_id || ''
  const selected = items.find(item => item.id === delegationId)
  const decide = useMutation({
    mutationFn: ({ row, decision }: { row: ComputationDelegation; decision: 'accepted' | 'rejected' }) => decideComputationDelegation(row.id, decision),
    onSuccess: () => { message.success(confirm?.decision === 'rejected' ? '已拒绝计算委托' : '已接受计算委托'); setConfirm(undefined); qc.invalidateQueries({ queryKey: ['computation-delegations'] }) },
    onError: (error: any) => { message.error(errorText(error)); qc.invalidateQueries({ queryKey: ['computation-delegations'] }) },
  })
  const available = (row: ComputationDelegation) => row.status === 'pending' && !isExpired(row) && !selfDecision(row, connectorId)
  const filtered = items.filter(row => (filter === 'all' || (filter === 'pending' ? available(row) : row.status === filter)) && `${row.project_name || ''} ${row.project_id} ${row.id}`.toLowerCase().includes(search.toLowerCase()))
  const identity = selected?.participant || inbox.data
  const instances = selected?.scope.instances || selected?.scope.applications || []
  const own = selected && selfDecision(selected, connectorId)
  const roles = selected?.participant?.roles || selected?.scope.participants?.find(p => p.connector_id === (selected?.participant?.connector_id || connectorId))?.roles || []

  return <div className="workspace-page delegation-workspace">
    <header className="workspace-header"><div className="workspace-header-copy"><div className="workspace-kicker">PROJECT EXECUTION AUTHORIZATION</div><Title level={2}>{delegationId ? '计算委托详情' : '计算委托'}</Title><Paragraph type="secondary">查看项目授予本连接器的计算职责，确认接受后由中心统一调度。</Paragraph></div><div className="workspace-header-actions">{delegationId && <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/computation-delegations')}>返回收件箱</Button>}<Button icon={<ReloadOutlined />} onClick={() => inbox.refetch()} loading={inbox.isFetching}>刷新</Button></div></header>
    {inbox.isError && <Alert type="error" showIcon message="无法加载计算委托" description={errorText(inbox.error)} action={<Button onClick={() => inbox.refetch()}>重试</Button>} />}
    {inbox.isLoading ? <div className="delegation-loading"><Spin size="large" /></div> : !delegationId ? <>
      <div className="workspace-metrics delegation-metrics"><Card><Text type="secondary">本节点收到的委托</Text><strong>{items.length}</strong></Card><Card><Text type="secondary">等待本节点确认</Text><strong>{items.filter(available).length}</strong></Card><Card><Text type="secondary">已生效</Text><strong>{items.filter(row => ['active', 'effective'].includes(row.status)).length}</strong></Card></div>
      <Card title="委托收件箱"><div className="delegation-filters"><Input.Search aria-label="搜索项目或委托" placeholder="搜索项目名称或委托标识" allowClear value={search} onChange={e => setSearch(e.target.value)} /><Select aria-label="筛选委托状态" value={filter} onChange={setFilter} options={[{ value: 'all', label: '全部状态' }, { value: 'pending', label: '等待本节点确认' }, { value: 'active', label: '已生效' }, { value: 'revoked', label: '已撤回' }, { value: 'rejected', label: '已拒绝' }, { value: 'expired', label: '已过期' }]} /></div>
        <Table rowKey="id" dataSource={filtered} pagination={{ pageSize: 8, hideOnSinglePage: true }} scroll={{ x: 760 }} locale={{ emptyText: <Empty description="暂无符合条件的计算委托" /> }} columns={[
          { title: '项目 / 委托', key: 'project', render: (_, row: ComputationDelegation) => <div><Link to={`/computation-delegations/${encodeURIComponent(row.id)}`}>{row.project_name || row.project_id}</Link><div><Text type="secondary">委托版本 {row.version}</Text></div></div> },
          { title: '执行职责', key: 'roles', render: (_, row: ComputationDelegation) => row.participant?.roles?.length ? <Space wrap>{row.participant.roles.map(role => <Tag key={role}>{role}</Tag>)}</Space> : <Text type="secondary">见授权范围</Text> },
          { title: '委托状态', key: 'status', render: (_, row: ComputationDelegation) => <Space direction="vertical" size={2}>{statusTag(row.status)}{selfDecision(row, connectorId) && <Text type="secondary">本节点：{selfDecision(row, connectorId)?.decision === 'accepted' ? '已接受' : '已拒绝'}</Text>}</Space> },
          { title: '有效期至', dataIndex: 'expires_at', render: (date: string) => dateText(date) },
          { title: '操作', key: 'actions', render: (_, row: ComputationDelegation) => <Link to={`/computation-delegations/${encodeURIComponent(row.id)}`}>查看与确认</Link> },
        ]} />
      </Card>
    </> : selected ? <>
      <Alert type={['revoked', 'rejected', 'expired', 'superseded'].includes(selected.status) || isExpired(selected) ? 'warning' : 'info'} showIcon message={<Space wrap><span>{selected.project_name || '项目计算委托'}</span>{statusTag(selected.status)}{own && <Tag>{own.decision === 'accepted' ? '本节点已接受' : '本节点已拒绝'}</Tag>}</Space>} description="接受仅授权本节点承担下列计算职责，不授予完整项目编辑、原始资源浏览或结果下载权限。" />
      <div className="delegation-detail-grid"><Card title="本节点执行身份"><dl className="delegation-facts"><dt>服务主体</dt><dd>{identity?.org_name || '—'}</dd><dt>连接器</dt><dd>{identity?.connector_name || '—'}<Text code>{identity?.connector_id || connectorId || '—'}</Text></dd><dt>计算域</dt><dd><Text code>{identity?.domain_id || '尚未登记'}</Text></dd><dt>受托角色</dt><dd><Space wrap>{roles.length ? roles.map(role => <Tag key={role}>{role}</Tag>) : '见应用职责约定'}</Space></dd></dl></Card>
      <Card title="委托依据与有效范围"><dl className="delegation-facts"><dt>项目</dt><dd>{selected.project_name || selected.project_id}</dd><dt>委托版本</dt><dd>{selected.version}</dd><dt>有效期至</dt><dd>{dateText(selected.expires_at)}{isExpired(selected) && <Tag>已过期</Tag>}</dd><dt>确认人</dt><dd>{own?.decided_by || '尚未确认'}{own?.decided_at && <small>{dateText(own.decided_at)}</small>}</dd></dl></Card>
      <Card title="受托应用与执行职责" className="delegation-full-width">{instances.length ? <div className="delegation-instance-grid">{instances.map((instance, index) => <section className="delegation-instance" key={instance.id || index}><h3>{instance.name || instance.id || `应用实例 ${index + 1}`}</h3><p><Text type="secondary">固定应用版本</Text> <Text code>{instance.version_id || '—'}</Text></p>{instance.roles && <Space wrap>{Object.entries(instance.roles).filter(([, connector]) => connector === (selected.participant?.connector_id || connectorId)).map(([role]) => <Tag key={role}>{role}</Tag>)}</Space>}</section>)}</div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="委托未列出应用实例，请联系项目发起方核对" />}<div className="delegation-obligations"><h3>执行边界</h3><ul><li>只读取分配给本域、本角色的输入和中间产物。</li><li>任务间产物在所属计算域交接；跨方通信由应用协议完成。</li><li>执行结束按约定清理临时产物并返回清理结果。</li><li>委托变更、撤回或过期后，由中心重新核验后续执行授权。</li></ul></div></Card></div>
      <div className="delegation-decision-bar"><div><Text strong>{own ? '本节点已提交决定' : available(selected) ? '请核对职责后确认是否接受' : '当前委托不可提交决定'}</Text><div><Text type="secondary">以当前已绑定连接器身份确认，决定将记录在中心平台。</Text></div></div><Space><Button danger icon={<CloseOutlined />} disabled={!available(selected)} onClick={() => setConfirm({ row: selected, decision: 'rejected' })}>拒绝委托</Button><Button type="primary" icon={<CheckOutlined />} disabled={!available(selected)} onClick={() => setConfirm({ row: selected, decision: 'accepted' })}>接受委托</Button></Space></div>
    </> : !inbox.isError && <Card><Empty description="委托不存在，或当前连接器无权查看此委托" /><Button onClick={() => navigate('/computation-delegations')}>返回收件箱</Button></Card>}
    <Modal title={confirm?.decision === 'accepted' ? '接受计算委托？' : '拒绝计算委托？'} open={Boolean(confirm)} onCancel={() => !decide.isPending && setConfirm(undefined)} okText={confirm?.decision === 'accepted' ? '确认接受' : '确认拒绝'} cancelText="返回核对" confirmLoading={decide.isPending} maskClosable={!decide.isPending} onOk={() => confirm && decide.mutate(confirm)}><Paragraph>{confirm?.decision === 'accepted' ? '接受后，本连接器将在委托有效范围内承担计算职责。只有项目所需确认全部完成，中心才会允许执行。' : '拒绝后，当前计算组合无法据此委托启动；项目发起方需要调整并重新确认。'}</Paragraph><Text type="secondary">项目：{confirm?.row.project_name || confirm?.row.project_id} · 委托版本 {confirm?.row.version}</Text></Modal>
  </div>
}
