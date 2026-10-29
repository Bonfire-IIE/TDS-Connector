import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, Card, Form, Input, Modal, Select, Space, Table, Tag, Typography } from 'antd'
import { call, enc, key, Row, rows } from './client'
import { Detail, EditDialog, ErrorBox, Field, Fields, ObjectPicker, ResetDependent, useRoles } from './common'
import { WorkspaceHeader, MetricStrip, SectionCard } from '../components/ResourceWorkspace'

const optionFields: [string, string, string, boolean][] = [
  ['industry_code', '行业分类', 'industries', true], ['data_type', '数据类型', 'data_types', true],
  ['data_source_type', '数据来源', 'data_source_types', true], ['security_level', '安全等级', 'security_levels', true],
  ['personal_information_level', '个人信息等级', 'personal_information_levels', true],
  ['update_method', '更新方式', 'update_methods', false], ['resource_quality', '数据质量', 'resource_quality', false],
  ['high_quality_flag', '高质量数据集', 'high_quality_flags', false], ['ai_readiness', 'AI 就绪度', 'ai_readiness', false],
  ['contains_synthetic_data', '合成数据', 'synthetic_data', false], ['ai_training_authorization', 'AI 训练授权', 'ai_training_authorization', false],
]
const textFields: Field[] = [
  { name: 'resource_name', label: '资源名称', required: true }, { name: 'resource_abstract', label: '资源摘要', required: true, type: 'multiline' },
  { name: 'resource_owner_name', label: '持有方名称', required: true }, { name: 'resource_owner_id', label: '持有方标识', required: true },
  { name: 'contact_name', label: '联系人', required: true }, { name: 'contact_information', label: '联系电话（11 位）', required: true },
  { name: 'update_frequency', label: '更新频率', initial: '不更新', required: true, options: ['不更新','实时','1次/天','1次/周','1次/月','1次/季度','1次/年','其他'].map(value=>({value,label:value})) },
  { name: 'data_size', label: '数据规模' }, { name: 'time_range', label: '覆盖时间范围' },
]
const editable = ['registered', 'rejected', 'delisted']
const statusLabels: Record<string, string> = { registered: '本地已登记', pending_review: '中心待审核', published: '中心已审核', rejected: '中心已驳回', delisted: '中心投影已撤回', publish_failed: '提交失败（自动重试）' }
export default function Resources() {
  const [offset, setOffset] = useState(0); const [search, setSearch] = useState(''); const [status, setStatus] = useState('')
  const [editing, setEditing] = useState<Row>(); const [source, setSource] = useState<string>(); const [detail, setDetail] = useState<any>(); const [error, setError] = useState<any>()
  const { can } = useRoles('dr')
  const q = useQuery({ queryKey: ['dr-resources', offset, search, status], queryFn: () => call('dr', `resources?offset=${offset}&limit=20&q=${enc(search)}${status ? '&status=' + status : ''}`), retry: false, refetchInterval: 15000 })
  const opts = useQuery({ queryKey: ['dr-options'], queryFn: () => call('dr', 'metadata-options'), retry: false })
  const sources = useQuery({ queryKey: ['dr-sources'], queryFn: () => call('dr', 'sources'), retry: false })
  const fields: Field[] = [...textFields, ...optionFields.map(([name, label, table, required]) => ({ name, label, required, options: Object.entries(opts.data?.[table] || {}).map(([value, label]) => ({ value, label: String(label) })) }))]
  async function action(r: Row, operation: string) { try { setError(undefined); await call('dr', `resources/${enc(r.id)}/${operation}`, 'POST', {}, { 'If-Match': String(r.revision) }); q.refetch() } catch (e) { setError(e); q.refetch() } }
  async function show(r: Row, section = '') { try { setDetail(await call('dr', `resources/${enc(r.id)}${section ? '/' + section : ''}`)) } catch (e) { setError(e) } }
  return <div className="workspace-page resource-page-resources"><WorkspaceHeader kicker="数据目录 / RESOURCES" title="数据资源" description="登记可用于产品和隐私计算的数据对象，跟踪中心投影、版本和同步状态。" action={<Button type="primary" onClick={() => { setEditing({ key: key() }); setSource(undefined) }}>登记资源</Button>} /><MetricStrip items={[{ label: '资源总数', value: q.data?.total || 0, hint: '本地登记' }, { label: '中心已审核', value: rows(q.data).filter(r => r.status === 'published').length, hint: '可供产品引用', tone: 'success' }, { label: '待处理', value: rows(q.data).filter(r => ['pending_review', 'publish_failed'].includes(r.status)).length, hint: '审核或同步', tone: 'warning' }]} /><Space direction="vertical" size="large" style={{ width: '100%' }}><div className="resource-action-row"><Typography.Text type="secondary">资源目录</Typography.Text></div>
    <Typography.Text type="secondary">资源由本连接器登记；中心投影仅属主和治理人员可见，对外公开的是数据产品。</Typography.Text>
    <ErrorBox error={q.error || opts.error || sources.error || error} /><Space><Input.Search placeholder="搜索资源" onSearch={v => { setSearch(v); setOffset(0) }} /><Select style={{ width: 180 }} placeholder="全部状态" allowClear onChange={v => { setStatus(v || ''); setOffset(0) }} options={['registered', 'pending_review', 'published', 'rejected', 'delisted', 'publish_failed'].map(value => ({ value, label: statusLabels[value] || value }))} /><Button onClick={() => q.refetch()}>刷新</Button></Space>
    <SectionCard title="资源目录" description="按状态筛选资源，查看版本、审计和中心同步情况"><Table rowKey="id" dataSource={rows(q.data)} loading={q.isFetching} pagination={{ current: offset / 20 + 1, pageSize: 20, total: q.data?.total || 0, showSizeChanger: false, onChange: n => setOffset((n - 1) * 20) }} columns={[{ title: '资源名称', render: (_, r) => r.metadata.resource_name }, { title: '版本', dataIndex: 'version' }, { title: '状态', render: (_, r) => <Tag>{statusLabels[r.status] || r.status}</Tag> }, { title: '操作', render: (_, r) => <Space wrap><Button onClick={() => show(r)}>详情</Button><Button onClick={() => show(r, 'versions')}>版本</Button><Button onClick={() => show(r, 'audit')}>审计</Button><Button onClick={() => action(r, 'sync')}>立即对账</Button><Button onClick={() => show(r, 'sync-status')}>同步状态</Button>
      {can('resource:write') && editable.includes(r.status) && <><Button onClick={() => { setEditing({ ...r, key: key() }); setSource(r.source_id) }}>编辑</Button><Button danger onClick={() => Modal.confirm({ title: '删除连接器本地资源登记？', content: '删除资源登记及绑定，保留审计历史；不会删除数据源中的原始文件或表。中心投影将同步撤回。', onOk: async () => { await call('dr', `resources/${enc(r.id)}`, 'DELETE', undefined, { 'If-Match': String(r.revision) }); q.refetch() } })}>删除</Button></>}
      {can('resource:publish') && [...editable, 'publish_failed'].includes(r.status) && <Button onClick={() => action(r, 'publish')}>提交中心审核</Button>}
    </Space> }]} /></SectionCard>
    {editing && <EditDialog wide title={editing.id ? '编辑资源' : '登记资源'} initial={{ ...editing.metadata, source_id: editing.source_id, object_ref: editing.object_ref, data_items: editing.data_items }} close={() => setEditing(undefined)} submit={async values => {
      const { source_id, object_ref, data_items, ...metadata } = values
      if (!metadata.annotation_info?.status) delete metadata.annotation_info
      const payload = { source_id, object_ref, data_items, metadata: Object.fromEntries(Object.entries(metadata).filter(([, v]) => v !== undefined && v !== '')) }
      await call('dr', editing.id ? `resources/${enc(editing.id)}` : 'resources', editing.id ? 'PUT' : 'POST', payload, editing.id ? { 'If-Match': String(editing.revision) } : { 'Idempotency-Key': editing.key }); await q.refetch()
    }}>
      <div className="dialog-columns"><section className="dialog-panel"><h3><b>01</b> 来源与信息项</h3>
      <Form.Item name="source_id" label="数据源" rules={[{ required: true }]}><Select onChange={setSource} options={rows(sources.data).map(r => ({ value: r.id, label: r.name }))} /></Form.Item>
      <Form.Item name="object_ref" label="源对象" rules={[{ required: true }]}><ObjectPicker source={source} service="dr" /></Form.Item>
      <ResetDependent field="source_id" names={['object_ref', 'data_items']} />
      <ResetDependent field="object_ref" names={['data_items']} />
      <ResourceColumns options={opts.data?.column_types} />
      </section><section className="dialog-panel"><h3><b>02</b> 目录信息与分类</h3><div className="dialog-fields"><Fields fields={fields} /></div><h3><b>03</b> 主题与标注</h3>
      <Form.Item name="theme_code" label="政务主题"><Select allowClear showSearch optionFilterProp="label" options={(opts.data?.themes || []).flatMap((v: Row) => [{ value: v.value || v.code, label: v.label || v.name }, ...(v.children || []).map((c: Row) => ({ value: c.value || c.code, label: c.label || c.name }))])} /></Form.Item>
      <Form.Item name={['annotation_info', 'status']} label="标注状态"><Select allowClear options={Object.entries(opts.data?.annotation_statuses || {}).map(([value, label]) => ({ value, label: String(label) }))} /></Form.Item>
      <Form.Item name={['annotation_info', 'types']} label="标注类型"><Select mode="multiple" options={Object.entries(opts.data?.annotation_types || {}).map(([value, label]) => ({ value, label: String(label) }))} /></Form.Item>
      <Form.Item name={['annotation_info', 'scale']} label="标注规模"><Input /></Form.Item>
      <Form.Item name={['annotation_info', 'quality']} label="标注质量"><Input /></Form.Item>
      {(['data_modalities', 'ai_task_types'] as const).map(name => <Form.Item name={name} key={name} label={name === 'data_modalities' ? '数据模态' : 'AI 任务'}><Select mode="multiple" options={Object.entries(opts.data?.[name] || {}).map(([value, label]) => ({ value, label: String(label) }))} /></Form.Item>)}
      </section></div>
    </EditDialog>}
    <Modal open={detail !== undefined} title="资源信息" width={850} footer={null} onCancel={() => setDetail(undefined)}><Detail value={detail} /></Modal>
  </Space></div>
}

function ResourceColumns({ options }: { options: any }) {
  const form = Form.useFormInstance(); const [error, setError] = useState<any>(); const [busy, setBusy] = useState(false)
  const source = Form.useWatch('source_id', form); const ref = Form.useWatch('object_ref', form)
  const types = Array.isArray(options) ? options.map(value => ({ value, label: value })) : Object.entries(options || {}).map(([value, label]) => ({ value, label: String(label) }))
  return <Card size="small" title="信息项" style={{ marginBottom: 16 }} extra={<Button disabled={!source || !ref} loading={busy} onClick={async () => { setBusy(true); try { setError(undefined); const result = await call('dr', `sources/${enc(source)}/inspect`, 'POST', { object_ref: ref }); form.setFieldValue('data_items', result.columns || result.data_items || []) } catch (e) { setError(e) } finally { setBusy(false) } }}>探测字段</Button>}>
    <ErrorBox error={error} /><Form.List name="data_items">{fields => <>{fields.map(f => <Space key={f.key} align="start"><Form.Item name={[f.name, 'name']}><Input readOnly /></Form.Item><Form.Item name={[f.name, 'type']} rules={[{ required: true }]}><Select style={{ width: 130 }} options={types} /></Form.Item><Form.Item name={[f.name, 'comment']}><Input placeholder="字段说明" /></Form.Item></Space>)}</>}</Form.List>
    <Typography.Text type="secondary">未填写时由资源服务自动探测；字段名称必须与源结构一致。</Typography.Text>
    </Card>
}
