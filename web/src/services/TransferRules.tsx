import { useState } from 'react'
import { Button, Card, Form, Input, InputNumber, Select, Space, Typography } from 'antd'
import { call, enc, Row } from './client'
import { ErrorBox } from './common'

function Condition({ index }: { index: number }) {
  const form = Form.useFormInstance(); const name = Form.useWatch(['filter', 'conditions', index, 'field'], form)
  const columns = Form.useWatch('columns', form) || []
  const column = columns.find((v: Row) => v.name === name); const numeric = /int|long|double|float|decimal/.test(column?.type || '')
  const bool = column?.type === 'boolean'
  return <Space align="start" wrap>
    <Form.Item name={[index, 'field']} rules={[{ required: true }]}><Select placeholder="字段" style={{ width: 150 }} options={columns.map((v: Row) => ({ value: v.name, label: v.name }))} /></Form.Item>
    <Form.Item name={[index, 'op']} initialValue="eq" rules={[{ required: true }]}><Select style={{ width: 120 }} options={(bool ? [['eq', '等于']] : numeric ? [['eq', '等于'], ['ne', '不等于'], ['gte', '大于等于'], ['lte', '小于等于']] : [['eq', '等于'], ['ne', '不等于']]).map(([value, label]) => ({ value, label }))} /></Form.Item>
    <Form.Item name={[index, 'value']} rules={[{ required: true }]}>{bool ? <Select style={{ width: 120 }} options={[{ value: true, label: '是' }, { value: false, label: '否' }]} /> : numeric ? <InputNumber /> : <Input placeholder="取值" />}</Form.Item>
  </Space>
}
export default function TransferRules() {
  const form = Form.useFormInstance(); const source = Form.useWatch('source_id', form); const refs = Form.useWatch('source_refs', form)
  const columns = Form.useWatch('columns', form) || []; const [error, setError] = useState<any>(); const [busy, setBusy] = useState(false)
  return <Card size="small" title="字段与筛选" style={{ marginBottom: 16 }} extra={<Button loading={busy} disabled={!source || !refs?.length} onClick={async () => {
    setBusy(true); try { setError(undefined); const result = await call('di', `datasources/${enc(source)}/inspect`, 'POST', { object_ref: Array.isArray(refs) ? refs[0] : refs })
      form.setFieldsValue({ columns: result.columns.map((v: any) => typeof v === 'string' ? { name: v, type: result.column_types?.[v] || 'string' } : v), filter: undefined })
    } catch (e) { setError(e) } finally { setBusy(false) }
  }}>探测结构</Button>}><ErrorBox error={error} />
    <Form.List name="columns">{fields => <>{fields.map(f => <Space key={f.key}><Form.Item name={[f.name, 'name']}><Input readOnly /></Form.Item><Form.Item name={[f.name, 'type']}><Select style={{ width: 130 }} options={['string', 'int', 'bigint', 'double', 'boolean', 'date', 'timestamp'].map(value => ({ value, label: value }))} /></Form.Item></Space>)}</>}</Form.List>
    {columns.length > 0 && <><Form.Item name={['filter', 'fields']} label="输出字段（不选表示全部）"><Select mode="multiple" options={columns.map((v: Row) => ({ value: v.name, label: v.name }))} /></Form.Item><Form.List name={['filter', 'conditions']}>{(fields, { add, remove }) => <>{fields.map(f => <div key={f.key}><Condition index={f.name} /><Button danger onClick={() => remove(f.name)}>移除条件</Button></div>)}<Button onClick={() => add({ op: 'eq' })}>添加筛选条件</Button></>}</Form.List></>}
    <Typography.Text type="secondary">结构探测使用首个所选对象；任务创建时服务会检查每个对象。所有条件同时满足时输出。</Typography.Text>
  </Card>
}
