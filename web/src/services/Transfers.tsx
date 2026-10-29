import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, Form, Input, Modal, Select, Space, Table, Tag, Typography } from 'antd'
import { call, enc, key, Row, rows } from './client'
import TransferRules from './TransferRules'
import { Detail, EditDialog, ErrorBox, ObjectPicker, ResetDependent, useRoles } from './common'
import { WorkspaceHeader, MetricStrip, SectionCard } from '../components/ResourceWorkspace'

export default function Transfers() {
  const [offset, setOffset] = useState(0); const [create, setCreate] = useState<string>(); const [mode, setMode] = useState('structured-file'); const [source, setSource] = useState<string>(); const [error, setError] = useState<any>(); const [detail, setDetail] = useState<any>()
  const [actionKeys] = useState<Record<string, string>>({})
  const { can } = useRoles('di')
  const q = useQuery({ queryKey: ['di-transfers', offset], queryFn: () => call('di', `transfers?offset=${offset}&limit=20`), refetchInterval: 5000, retry: false })
  const sources = useQuery({ queryKey: ['di-sources'], queryFn: () => call('di', 'datasources'), retry: false })
  async function action(r: Row, action: string) { const id = `${r.id}:${action}`; try { setError(undefined); await call('di', `transfers/${enc(r.id)}/${action}`, 'POST', {}, { 'Idempotency-Key': actionKeys[id] ||= key() }); delete actionKeys[id]; q.refetch() } catch (e) { setError(e) } }
  return <div className="workspace-page resource-page-transfers"><WorkspaceHeader kicker="数据目录 / DELIVERY" title="数据搬运" description="将数据在受控数据源之间搬运，并跟踪每个任务的执行状态。" action={can('transfer:write') && <Button type="primary" onClick={() => setCreate(key())}>创建任务</Button>} /><MetricStrip items={[{ label: '全部任务', value: q.data?.total || 0, hint: '历史记录' }, { label: '执行中', value: rows(q.data).filter(r => ['queued', 'running'].includes(r.state)).length, hint: '正在处理' }, { label: '可重试', value: rows(q.data).filter(r => r.retryable).length, hint: '需要关注', tone: 'warning' }]} /><ErrorBox error={q.error || sources.error || error} /><SectionCard title="交付任务" description="查看搬运进度、结果和可执行操作" action={<Button onClick={() => q.refetch()}>刷新</Button>}><Table rowKey="id" dataSource={rows(q.data)} loading={q.isFetching} pagination={{ current: offset / 20 + 1, pageSize: 20, total: q.data?.total || 0, showSizeChanger: false, onChange: n => setOffset((n - 1) * 20) }} columns={[{ title: '任务', dataIndex: 'id' }, { title: '类型', dataIndex: 'mode' }, { title: '状态', render: (_, r) => <Tag>{r.state}</Tag> }, { title: '操作', render: (_, r) => <Space wrap><Button onClick={async () => { try { setDetail(await call('di', `transfers/${enc(r.id)}/items?limit=50`)) } catch (e) { setError(e) } }}>明细</Button>{can('transfer:write') && <>{r.state === 'created' && <Button onClick={() => action(r, 'run')}>执行</Button>}{r.retryable && <Button onClick={() => action(r, 'retry')}>重试失败项</Button>}{['created', 'queued', 'running'].includes(r.state) && <Button danger onClick={() => action(r, 'cancel')}>取消</Button>}</>}</Space> }]} /></SectionCard>
    {create && <EditDialog wide title="创建搬运任务" close={() => setCreate(undefined)} submit={async v => { await call('di', 'transfers', 'POST', { ...v, source_refs: Array.isArray(v.source_refs) ? v.source_refs : [v.source_refs] }, { 'Idempotency-Key': create }); await q.refetch() }}>
      <div className="dialog-columns"><section className="dialog-panel"><h3><b>01</b> 数据来源</h3>
      <Form.Item name="mode" label="搬运模式" initialValue={mode} rules={[{ required: true }]}><Select onChange={v => { setMode(v); setSource(undefined) }} options={[{ value: 'database', label: '数据库' }, { value: 'structured-file', label: '结构化文件' }, { value: 'binary-file', label: '二进制文件' }]} /></Form.Item>
      <Form.Item name="source_id" label="输入数据源" rules={[{ required: true }]}><Select onChange={setSource} options={rows(sources.data).filter(r => (r.kind === 'jdbc') === (mode === 'database')).map(r => ({ value: r.id, label: r.name }))} /></Form.Item>
      <Form.Item name="source_refs" label="输入对象" rules={[{ required: true }]}><ObjectPicker key={`${source}:${mode}`} source={source} multiple={mode !== 'database'} /></Form.Item>
      </section><section className="dialog-panel"><h3><b>02</b> 目标与输出</h3>
      <Form.Item name="target_id" label="输出数据源" rules={[{ required: true }]}><Select options={rows(sources.data).filter(r => r.kind !== 'jdbc').map(r => ({ value: r.id, label: r.name }))} /></Form.Item>
      <Form.Item name="target_path" label="目标目录" initialValue=""><Input /></Form.Item>
      {mode !== 'binary-file' && <><Form.Item name="input_format" label="输入格式" initialValue="auto"><Select options={['auto', 'csv', 'tsv', 'json', 'jsonl', 'parquet', 'orc'].map(value => ({ value, label: value }))} /></Form.Item><Form.Item name="output_format" label="输出格式" initialValue="csv"><Select options={['csv', 'tsv', 'json', 'jsonl', 'parquet', 'orc'].map(value => ({ value, label: value }))} /></Form.Item></>}
      <ResetDependent field="mode" names={['source_id', 'source_refs', 'columns', 'filter']} />
      <ResetDependent field="source_id" names={['source_refs', 'columns', 'filter']} />
      <ResetDependent field="source_refs" names={['columns', 'filter']} />
      {mode !== 'binary-file' && <><h3><b>03</b> 字段与过滤</h3><TransferRules /></>}
      <Typography.Text type="secondary">创建任务后，在列表中点击“执行”开始搬运。</Typography.Text>
      </section></div>
    </EditDialog>}
    <Modal open={detail !== undefined} title="搬运明细" width={850} footer={null} onCancel={() => setDetail(undefined)}><Detail value={detail} /></Modal>
  </div>
}
