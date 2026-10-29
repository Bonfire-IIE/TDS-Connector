import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Alert, Button, Checkbox, Form, Input, InputNumber, Modal, Select, Space, Table, Typography } from 'antd'
import { call, capabilities, enc, errorText, Row, rows, Service } from './client'

export function useRoles(service: Service) {
  const q = useQuery({ queryKey: ['service-capabilities'], queryFn: capabilities, staleTime: 15000, retry: false })
  return { can: (role: string) => (q.data?.services?.[service]?.roles || []).includes(role), data: q.data, error: q.error }
}
export function ErrorBox({ error }: { error?: unknown }) { return error ? <Alert style={{ marginBottom: 16 }} type="error" showIcon message={errorText(error)} /> : null }
export { default as Detail } from './DetailPanel'
export type Field = { name: string; label: string; required?: boolean; type?: 'number' | 'password' | 'boolean' | 'multiline' | 'datetime'; options?: { value: any; label: string }[]; initial?: any; min?: number; max?: number }
export function Fields({ fields }: { fields: Field[] }) {
  return <>{fields.map(f => <Form.Item key={f.name} name={f.name} label={f.label} preserve={false} initialValue={f.initial} valuePropName={f.type === 'boolean' ? 'checked' : 'value'} rules={f.required ? [{ required: true, message: `请填写${f.label}` }] : []}>
    {f.options ? <Select showSearch optionFilterProp="label" options={f.options} allowClear={!f.required} /> : f.type === 'number' ? <InputNumber min={f.min} max={f.max} style={{ width: '100%' }} /> : f.type === 'boolean' ? <Checkbox /> : f.type === 'password' ? <Input.Password autoComplete="new-password" /> : f.type === 'multiline' ? <Input.TextArea rows={3} /> : <Input type={f.type === 'datetime' ? 'datetime-local' : 'text'} />}
  </Form.Item>)}</>
}
export function EditDialog({ title, fields, initial, submit, close, children, wide = false }: { title: string; wide?: boolean; fields?: Field[]; initial?: Row; submit: (values: Row) => Promise<void>; close: () => void; children?: React.ReactNode }) {
  const [form] = Form.useForm(); const [error, setError] = useState<any>(); const [busy, setBusy] = useState(false)
  return <Modal open title={title} className={wide || (fields?.length || 0) > 4 ? "complex-dialog" : undefined} width={wide || (fields?.length || 0) > 4 ? 1160 : 720} styles={{ body: { maxHeight: '70vh', overflowY: 'auto', paddingRight: 8 } }} onCancel={() => { if (!busy) close() }} destroyOnClose confirmLoading={busy} onOk={() => form.submit()} maskClosable={false}>
    <ErrorBox error={error} /><Form form={form} layout="vertical" initialValues={initial} onFinish={async values => { setBusy(true); setError(undefined); try { await submit(values); close() } catch (e) { setError(e) } finally { setBusy(false) } }}>
      {fields && <div className={(fields.length > 4) ? "dialog-fields" : undefined}><Fields fields={fields} /></div>}{children}
    </Form>
  </Modal>
}
export function ObjectPicker({ source, value, onChange, multiple = false, service = 'di', onDirectoryChange }: { onDirectoryChange?: (prefix: string) => void; service?: 'di' | 'dr'; source?: string; value?: string | string[]; onChange?: (v: any) => void; multiple?: boolean }) {
  const [prefix, setPrefix] = useState(''); const [offset, setOffset] = useState(0); const [search, setSearch] = useState('')
  useEffect(() => { setPrefix(''); setOffset(0); setSearch('') }, [source])
  const q = useQuery({ queryKey: ['objects', service, source, prefix, offset, search], queryFn: () => call(service, `${service === 'di' ? 'datasources' : 'sources'}/${enc(source!)}/objects?prefix=${enc(prefix)}&offset=${offset}&limit=30&q=${enc(search)}`), enabled: !!source, retry: false })
  useEffect(() => { onDirectoryChange?.(prefix) }, [prefix, source, onDirectoryChange])
  const selected = Array.isArray(value) ? value : value ? [value] : []
  return <div><Space wrap style={{ marginBottom: 8 }}><Input.Search placeholder="搜索对象" onSearch={v => { setSearch(v); setOffset(0) }} /><Button onClick={() => { setPrefix(''); setOffset(0) }}>根目录</Button><Typography.Text>{prefix}</Typography.Text></Space>
    <ErrorBox error={q.error} /><Table size="small" loading={q.isFetching} dataSource={rows(q.data)} rowKey={r => r.ref || r.object_ref} pagination={false}
      rowSelection={{ type: multiple ? 'checkbox' : 'radio', selectedRowKeys: selected, preserveSelectedRowKeys: true, getCheckboxProps: r => ({ disabled: r.kind === 'directory' }), onChange: keys => onChange?.(multiple ? keys : keys[0]) }}
      columns={[{ title: '对象', render: (_, r) => r.kind === 'directory' ? <Button type="link" onClick={() => { setPrefix(r.ref || r.object_ref); setOffset(0) }}>{r.name}</Button> : r.name || r.ref || r.object_ref }, { title: '类型', dataIndex: 'kind' }]} />
    <Space style={{ marginTop: 8 }}><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 30))}>上一页</Button><Button disabled={q.data?.next_offset == null} onClick={() => setOffset(q.data.next_offset)}>下一页</Button><Typography.Text>{selected.length ? `已选择 ${selected.length} 个对象` : '请选择对象'}</Typography.Text></Space>
  </div>
}

export function ResetDependent({ field, names }: { field: string; names: string[] }) {
  const form = Form.useFormInstance(); const value = Form.useWatch(field, form)
  const [previous, setPrevious] = useState(value)
  useEffect(() => {
    if (previous !== undefined && value !== previous) form.setFieldsValue(Object.fromEntries(names.map(name => [name, undefined])))
    setPrevious(value)
  }, [value])
  return null
}
