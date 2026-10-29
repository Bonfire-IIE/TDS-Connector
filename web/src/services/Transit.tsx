import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Alert, Button, Input, Modal, Select, Space, Table, Typography } from 'antd'
import { call, enc, key, Row, rows } from './client'
import { Detail, EditDialog, ErrorBox, Field, useRoles } from './common'
import { WorkspaceHeader, MetricStrip, SectionCard } from '../components/ResourceWorkspace'

type Operation = { title: string; path: string; method?: string; fields?: Field[]; initial?: Row; key: string; secret?: boolean }
const text = (name: string, label: string, required = true): Field => ({ name, label, required })
const num = (name: string, label: string, initial: number, min = 1, max?: number): Field => ({ name, label, type: 'number', initial, min, max, required: true })
const time = (name: string, label: string): Field => ({ name, label, type: 'datetime', required: true })
const collections = [
  ['objects', '对象'], ['imports', '入仓与业务任务'], ['grants', '消费授权'], ['accesses', '访问记录'],
  ['admin/warehouses', '仓库'], ['admin/retention-policies', '保留策略'], ['admin/lifecycle-jobs', '生命周期任务'],
  ['admin/approvals', '清理审批'], ['admin/anomalies', '异常'], ['admin/access-observations', '存储访问审计'],
]
export default function Transit() {
  const { can } = useRoles('ts'); const [collection, setCollection] = useState('objects'); const [cursors, setCursors] = useState<string[]>(['']); const cursor = cursors[cursors.length - 1]
  const [operation, setOperation] = useState<Operation>(); const [detail, setDetail] = useState<any>(); const [secret, setSecret] = useState<any>(); const [error, setError] = useState<any>(); const [reference, setReference] = useState('')
  const q = useQuery({ queryKey: ['ts', collection, cursor], queryFn: () => call('ts', `${collection}?limit=20${cursor ? '&cursor=' + enc(cursor) : ''}`), retry: false, refetchInterval: 10000 })
  const summary = useQuery({ queryKey: ['ts-summary'], queryFn: () => call('ts', 'admin/summary'), enabled: can('admin'), retry: false })
  function open(title: string, path: string, fields?: Field[], initial?: Row, method = 'POST', isSecret = false) { setOperation({ title, path, fields, initial, method, key: key(), secret: isSecret }) }
  async function show(path: string) { try { setError(undefined); setDetail(await call('ts', path)) } catch (e) { setError(e) } }
  const detailPath = (r: Row) => collection === 'imports' ? `imports/${enc(r.id)}` : `${collection}/${enc(r.id)}`
  return <div className="workspace-page resource-page-transit"><WorkspaceHeader kicker="数据目录 / TRANSIT" title="数据中转仓" description="管理对象入仓、授权、访问租约和生命周期任务。" /><MetricStrip items={[{ label: '对象', value: summary.data?.objects ?? '—', hint: '已登记对象' }, { label: '逻辑字节', value: summary.data?.bytes ?? '—', hint: '存储规模' }, { label: '待处理事件', value: summary.data?.outbox_pending ?? '—', hint: '发布队列', tone: 'warning' }, { label: '失败任务', value: summary.data?.dead_jobs ?? '—', hint: '需要处理', tone: 'danger' }]} /><Space direction="vertical" size="large" style={{ width: '100%' }}><ErrorBox error={q.error || error || summary.error} />
    <Space wrap><Select value={collection} style={{ width: 210 }} options={collections.filter(([v]) => !v.startsWith('admin/') && v !== 'grants' || can('admin')).map(([value, label]) => ({ value, label }))} onChange={v => { setCollection(v); setCursors(['']) }} /><Button onClick={() => q.refetch()}>刷新</Button>
      {can('admin') && collection === 'admin/warehouses' && <Button type="primary" onClick={() => open('登记仓库', 'admin/warehouses', [text('name', '名称'), { ...text('provider', '存储类型'), initial: 'minio', options: ['minio', 's3'].map(value => ({ value, label: value })) }, text('endpoint', '存储地址'), text('bucket', '存储桶'), { ...text('region', '区域'), initial: 'us-east-1' }, text('credential_ref', '运维凭据引用'), { name: 'private', label: '私网', type: 'boolean', initial: true }, { name: 'sts_enabled', label: '启用 STS', type: 'boolean', initial: false }])}>登记仓库</Button>}
      {can('admin') && collection === 'admin/retention-policies' && <Button type="primary" onClick={() => open('新增保留策略', 'admin/retention-policies', [text('name', '名称'), num('retain_days', '保留天数', 7, 1, 3650), num('grace_hours', '删除宽限小时', 24, 1, 8760), num('failed_upload_hours', '失败上传保留小时', 24, 1, 8760)])}>新增策略</Button>}
      {can('import') && can('import:unbound') && <Button onClick={() => open('运维入仓', 'imports', [text('source_id', '数据源 ID'), text('object_ref', '对象引用'), text('warehouse_ref', '仓库 ID'), text('retention_policy_ref', '保留策略 ID', false), text('logical_name', '名称'), text('purpose', '用途'), { ...text('classification', '数据等级'), initial: 'general1', options: ['general1', 'general2', 'important'].map(value => ({ value, label: value })) }])}>运维入仓</Button>}
    </Space>
    {collection === 'imports' && <Space><Input value={reference} onChange={e => setReference(e.target.value)} placeholder="业务任务编号" /><Button disabled={!reference} onClick={() => show(`business-tasks/by-reference/${enc(reference)}`)}>查询业务任务</Button></Space>}
    <SectionCard title="数据目录" description="按集合查看对象、入仓、授权和访问记录"><Table rowKey="id" pagination={false} loading={q.isFetching} dataSource={rows(q.data)} scroll={{ x: 900 }} columns={[{ title: '标识 / 名称', render: (_, r) => <><div>{r.logical_name || r.name || r.business_task_ref}</div><Typography.Text type="secondary">{r.id}</Typography.Text></> }, { title: '状态', render: (_, r) => r.state || '—' }, { title: '创建时间', render: (_, r) => r.created_at ? new Date(r.created_at * 1000).toLocaleString() : '—' }, { title: '操作', render: (_, r) => <Space wrap>
      <Button onClick={() => ['objects', 'imports', 'admin/warehouses', 'admin/retention-policies', 'admin/lifecycle-jobs', 'admin/approvals'].includes(collection) ? show(detailPath(r)) : setDetail(r)}>详情</Button>
      {collection === 'objects' && <><Button onClick={() => open('申请访问', `objects/${enc(r.id)}/access`, [text('version_id', '物理版本 ID'), text('purpose', '用途'), text('project_ref', '项目引用', false), text('contract_ref', '合约引用', false), { ...text('access_mode', '访问方式'), initial: 'presigned_get', options: [{ value: 'presigned_get', label: '预签名下载' }, { value: 'sts', label: '临时存储凭据（有效期须为 900 秒）' }] }, num('ttl_seconds', '有效秒数', 300, 1, 900), num('lease_seconds', '租约秒数', 300, 1, 3600)], undefined, 'POST', true)}>访问</Button>
        {can('grant') && <Button onClick={() => open('授予消费权限', 'grants', [text('object_id', '对象 ID'), text('subject', '消费者主体'), text('purpose', '用途'), text('project_ref', '项目引用', false), text('contract_ref', '合约引用', false), time('valid_from', '生效时间'), time('valid_to', '失效时间'), num('max_uses', '最多签发次数', 1)], { object_id: r.id })}>授权</Button>}
        <Button danger onClick={() => open('软删除对象', `objects/${enc(r.id)}`, [], undefined, 'DELETE')}>删除</Button><Button onClick={() => open('恢复对象', `objects/${enc(r.id)}/restore`, [num('retain_days', '保留天数', 7, 1, 3650)])}>恢复</Button>
        {can('admin') && <><Button onClick={() => open('保留对象', `admin/objects/${enc(r.id)}/hold`, [text('reason', '保留原因')])}>Hold</Button><Button onClick={() => open('解除保留', `admin/objects/${enc(r.id)}/unhold`, [])}>解除 Hold</Button><Button onClick={() => open('申请永久清理审批', `admin/objects/${enc(r.id)}/purge-approvals`, [])}>申请清理</Button><Button danger onClick={() => open('执行永久清理', `admin/objects/${enc(r.id)}/purge`, [text('approval_id', '已由另一主体批准的审批 ID')])}>永久清理</Button></>}
      </>}
      {collection === 'imports' && <Button onClick={() => open('取消入仓', `imports/${enc(r.id)}/cancel`, [])}>取消</Button>}
      {collection === 'grants' && can('grant') && <Button danger onClick={() => open('撤销消费授权', `grants/${enc(r.id)}/revoke`, [])}>撤销</Button>}
      {collection === 'accesses' && <Button onClick={() => open('释放访问租约', `accesses/${enc(r.id)}/release`, [])}>释放租约</Button>}
      {collection === 'admin/retention-policies' && <Button onClick={() => open('预览保留策略影响', `${collection}/${enc(r.id)}/dry-run`, [])}>影响预览</Button>}
      {collection === 'admin/approvals' && <Button onClick={() => open('批准清理（需与申请人不同）', `${collection}/${enc(r.id)}/approve`, [])}>批准</Button>}
      {collection === 'admin/lifecycle-jobs' && <Button onClick={() => open('重试生命周期任务', `${collection}/${enc(r.id)}/retry`, [])}>重试</Button>}
    </Space> }]} /><Space style={{ marginTop: 16 }}><Button disabled={cursors.length === 1} onClick={() => setCursors(v => v.slice(0, -1))}>上一页</Button><Button disabled={!q.data?.next_cursor} onClick={() => setCursors(v => [...v, q.data.next_cursor])}>下一页</Button></Space></SectionCard>
    {operation && <EditDialog title={operation.title} fields={operation.fields} initial={operation.initial} close={() => setOperation(undefined)} submit={async v => {
      const payload = Object.fromEntries(Object.entries(v).filter(([, value]) => value !== undefined && value !== '').map(([k, value]) => [k, ['valid_from', 'valid_to'].includes(k) ? new Date(value as string).getTime() / 1000 : value]))
      const result = await call('ts', operation.path, operation.method, operation.method === 'DELETE' ? undefined : payload, { 'Idempotency-Key': operation.key })
      if (operation.secret) setSecret(result); else setDetail(result)
      await q.refetch()
    }} />}
    <Modal open={detail !== undefined} title="中转仓详情" width={850} footer={null} onCancel={() => setDetail(undefined)}><Detail value={detail} /></Modal>
    <Modal open={secret !== undefined} title="访问能力" width={800} footer={null} destroyOnClose onCancel={() => setSecret(undefined)}><Alert type="info" message="访问凭证仅显示本次返回结果，关闭后不会保存。重放请求不会重新签发凭证。" /><Detail value={secret} /></Modal>
  </Space></div>
}
