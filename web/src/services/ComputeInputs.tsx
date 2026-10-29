import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Alert, Button, Card, Form, Input, Modal, Select, Space, Table } from 'antd'
import { api } from '../api/client'
import { call, enc, key, rows, Row } from './client'
import { Detail, EditDialog, ErrorBox, useRoles } from './common'

export default function ComputeInputs() {
  const { can } = useRoles('di'); const [create, setCreate] = useState<string>(); const [mode, setMode] = useState('di'); const [detail, setDetail] = useState<any>(); const [secret, setSecret] = useState<any>(); const [error, setError] = useState<any>()
  const q = useQuery({ queryKey: ['compute-inputs'], queryFn: () => api.get<unknown, Row[]>('/portal/extractions'), refetchInterval: 5000, retry: false })
  const resources = useQuery({ queryKey: ['published-resources'], queryFn: () => call('dr', 'resources?status=published&limit=50'), enabled: !!create, retry: false })
  async function action(r: Row, name: string) { try { setError(undefined); const result = await api.post(`/portal/extractions/${enc(r.id)}/${name}`); if (name === 'credentials') setSecret(result); else setDetail(result); q.refetch() } catch (e) { setError(e) } }
  async function complete(r: Row) { try {
    const received = await api.get<unknown, Row>(`/portal/extractions/${enc(r.id)}/received`)
    Modal.confirm({ title: '确认提交全部已接收文件？', content: <Detail value={received.received_files} />, width: 700, onOk: async () => { await api.post(`/portal/extractions/${enc(r.id)}/complete`, { files: received.received_files }); q.refetch() } })
  } catch (e) { setError(e) } }
  return <Card title="计算输入准备" style={{ marginTop: 24 }} extra={can('transfer:write') && <Button onClick={() => setCreate(key())}>准备输入</Button>}>
    <ErrorBox error={q.error || error} /><Table rowKey="id" dataSource={q.data || []} columns={[{ title: '资源', dataIndex: 'resource_ref' }, { title: '版本', dataIndex: 'resource_version' }, { title: '阶段', dataIndex: 'phase' }, { title: '状态', dataIndex: 'state' }, { title: '操作', render: (_, r) => <Space wrap><Button onClick={() => setDetail(r)}>详情</Button>{can('transfer:write') && <>
      {r.mode === 'manual' && <><Button onClick={() => action(r, 'credentials')}>上传凭据</Button><Button onClick={() => complete(r)}>核对并完成</Button></>}
      {!['ready', 'cancelled', 'cleaned'].includes(r.state) && <Button onClick={async () => { try { await api.post('/portal/extractions/run', { extraction_id: r.id }); q.refetch() } catch (e) { setError(e) } }}>执行 / 恢复</Button>}
      <Button onClick={() => action(r, 'cancel')}>取消</Button><Button onClick={() => action(r, 'cleanup')}>清理</Button></>}</Space> }]} />
    {create && <EditDialog title="准备计算输入" close={() => setCreate(undefined)} submit={async v => {
      const resource = rows(resources.data).find(r => r.id === v.dr_resource_id)
      if (mode === 'di' && !resource) throw new Error('请选择有效的公开资源')
      await api.post('/portal/extractions/prepare', { request_key: create, mode, output_format: 'csv', ...(mode === 'di' ? { dr_resource_id: resource!.id, resource_ref: resource!.id, resource_version: String(resource!.version) } : { resource_ref: v.resource_ref, resource_version: v.resource_version, columns: v.columns }) }); q.refetch()
    }}>
      <Form.Item label="准备方式"><Select value={mode} onChange={setMode} options={[{ value: 'di', label: '已公开资源自动搬运' }, { value: 'manual', label: '手动上传 CSV' }]} /></Form.Item>
      {mode === 'di' ? <><ErrorBox error={resources.error} /><Form.Item name="dr_resource_id" label="公开资源" rules={[{ required: true }]}><Select options={rows(resources.data).map(r => ({ value: r.id, label: `${r.metadata.resource_name} · V${r.version}` }))} /></Form.Item></> : <>
        <Form.Item name="resource_ref" label="资源引用" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="resource_version" label="资源版本" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.List name="columns" initialValue={[{ name: '', type: 'string' }]}>{(fields, { add, remove }) => <>{fields.map(f => <Space key={f.key}><Form.Item name={[f.name, 'name']} rules={[{ required: true }]}><Input placeholder="列名" /></Form.Item><Form.Item name={[f.name, 'type']} initialValue="string"><Select style={{ width: 120 }} options={['string', 'integer', 'double', 'boolean'].map(value => ({ value, label: value }))} /></Form.Item><Button onClick={() => remove(f.name)}>移除</Button></Space>)}<Button onClick={() => add({ type: 'string' })}>添加列</Button></>}</Form.List>
      </>}
    </EditDialog>}
    <Modal open={detail !== undefined} title="计算准备详情" footer={null} width={800} onCancel={() => setDetail(undefined)}><Detail value={detail} /></Modal>
    <Modal open={secret !== undefined} title="临时上传凭据" footer={null} destroyOnClose onCancel={() => setSecret(undefined)}><Alert type="info" message="请在有效期内上传 CSV，然后核对并完成。关闭后凭据不保存在浏览器。" /><Detail value={secret} /></Modal>
  </Card>
}
