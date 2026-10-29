import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Drawer, Form, Input, Modal, Select, Space, Table, Upload, message } from 'antd'
import { call, download, enc, Row, rows, errorText } from './client'
import { Detail, EditDialog, ErrorBox, Field, Fields, ObjectPicker, useRoles } from './common'
import { WorkspaceHeader, MetricStrip, SectionCard } from '../components/ResourceWorkspace'

const configs: Record<string, Field[]> = {
  localfs: [{ name: 'path', label: '受控目录绝对路径', required: true }],
  oss: [{ name: 'endpoint', label: '存储地址', required: true }, { name: 'bucket', label: '存储桶', required: true }, { name: 'prefix', label: '目录前缀' }, { name: 'access_key_id', label: '访问密钥 ID', required: true }, { name: 'access_key_secret', label: '访问密钥', type: 'password', required: true }],
  ftp: [{ name: 'host', label: '主机', required: true }, { name: 'port', label: '端口', type: 'number', initial: 21, min: 1, max: 65535, required: true }, { name: 'user', label: '用户名', required: true }, { name: 'password', label: '密码', type: 'password', required: true }, { name: 'path', label: '目录', initial: '/', required: true }],
  sftp: [{ name: 'host', label: '主机', required: true }, { name: 'port', label: '端口', type: 'number', initial: 22, min: 1, max: 65535, required: true }, { name: 'user', label: '用户名', required: true }, { name: 'password', label: '密码', type: 'password', required: true }, { name: 'path', label: '目录', initial: '/', required: true }],
  jdbc: [{ name: 'url', label: '数据库连接地址', required: true }, { name: 'driver', label: '数据库驱动', initial: 'org.postgresql.Driver', options: [{ value: 'org.postgresql.Driver', label: 'PostgreSQL' }, { value: 'com.mysql.cj.jdbc.Driver', label: 'MySQL' }], required: true }, { name: 'user', label: '用户名', required: true }, { name: 'password', label: '密码', type: 'password', required: true }],
}
export default function Sources() {
  const qc = useQueryClient()
  const [directory, setDirectory] = useState('')
  const q = useQuery({ queryKey: ['di-sources'], queryFn: () => call('di', 'datasources'), retry: false })
  const { can } = useRoles('di'); const [create, setCreate] = useState(false); const [kind, setKind] = useState('localfs')
  const [source, setSource] = useState<Row>(); const [ref, setRef] = useState(''); const [detail, setDetail] = useState<any>(); const [error, setError] = useState<any>()
  async function act(fn: () => Promise<any>) { try { setError(undefined); setDetail(await fn()); await q.refetch() } catch (e) { setError(e) } }
  return <div className="workspace-page resource-page-sources"><WorkspaceHeader kicker="数据目录 / SOURCES" title="数据源" description="管理连接器能够访问的本地文件、数据库和对象存储。凭据只保存在当前连接器。" action={<Button type="primary" onClick={() => setCreate(true)}>登记数据源</Button>} /><MetricStrip items={[{ label: '已登记数据源', value: rows(q.data).length, hint: '本地目录' }, { label: '支持浏览', value: rows(q.data).filter(r => r.kind !== 'jdbc').length, hint: '文件与对象' }, { label: '连接验证', value: '可用', hint: '按需探活', tone: 'success' }]} /><ErrorBox error={q.error || error} /><SectionCard title="数据源目录" description="选择数据源浏览对象、探测结构或执行连接验证" action={<Button onClick={() => q.refetch()}>刷新</Button>}><Table rowKey="id" loading={q.isFetching} dataSource={rows(q.data)} columns={[{ title: '名称', dataIndex: 'name' }, { title: '类型', dataIndex: 'kind' }, { title: '操作', render: (_, r) => <Space><Button onClick={() => { setSource(r); setRef(''); setDirectory('') }}>浏览</Button><Button onClick={() => act(() => call('di', `datasources/${enc(r.id)}/probe`, 'POST'))}>探活</Button>{can('source:write') && <Button danger onClick={() => Modal.confirm({ title: `移除数据源“${r.name}”？`, content: '将移除本连接器保存的连接配置和访问凭据。源端文件、对象和数据库表会保留；依赖此数据源的资源将无法继续读取。请先确认关联资源与任务不再使用该连接。', okText: '移除连接', cancelText: '取消', onOk: async () => { await call('di', `datasources/${enc(r.id)}`, 'DELETE'); q.refetch() } })}>移除连接</Button>}</Space> }]} /></SectionCard>
    {create && <EditDialog wide title="登记数据源" close={() => setCreate(false)} submit={async v => { const { name, kind: type, ...config } = v; await call('di', 'datasources', 'POST', { name, kind: type, config: Object.fromEntries(configs[type].map(f => [f.name, config[f.name]]).filter(([, v]) => v !== undefined)) }); await q.refetch() }}>
      <div className="dialog-columns"><section className="dialog-panel"><h3><b>01</b> 数据源信息</h3><Form.Item name="name" label="名称" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="kind" label="类型" initialValue={kind}><Select onChange={setKind} options={Object.keys(configs).map(value => ({ value, label: value.toUpperCase() }))} /></Form.Item></section><section className="dialog-panel"><h3><b>02</b> 连接配置</h3><div key={kind}><Fields fields={configs[kind]} /></div></section></div>
    </EditDialog>}
    <Drawer open={!!source} title={source?.name} width={760} onClose={() => setSource(undefined)} destroyOnClose>
      {source && <><ObjectPicker source={source.id} value={ref} onChange={setRef} onDirectoryChange={setDirectory} /><Space style={{ marginTop: 20 }}><Button disabled={!ref} onClick={() => act(() => call('di', `datasources/${enc(source.id)}/inspect`, 'POST', { object_ref: ref }))}>结构探测</Button><Button disabled={!ref || source.kind === 'jdbc'} onClick={() => act(async () => { await download(source.id, ref) })}>下载</Button></Space>{can('source:write') && source.kind !== 'jdbc' && <Upload.Dragger key={`${source.id}/${directory}`} multiple style={{marginTop:20}} beforeUpload={file=>{if(file.size>32*1024*1024){message.error('单个文件不能超过 32 MB');return Upload.LIST_IGNORE}return true}} customRequest={async ({file,onSuccess,onError})=>{
        const item=file as File
        try { const result=await call('di', `datasources/${enc(source.id)}/files?ref=${enc([directory,item.name].filter(Boolean).join('/'))}`, 'POST', item, {'Content-Type':'application/octet-stream'});onSuccess?.(result);message.success(`${item.name} 已上传`);await qc.invalidateQueries({queryKey:['objects','di',source.id]}) }
        catch(e){onError?.(e as Error);message.error(errorText(e))}
      }}><p className="ant-upload-text">将文件拖到这里，或点击选择文件</p><p className="ant-upload-hint">上传到当前目录：{directory || '根目录'}。自动保留文件名，同名文件不会覆盖。</p></Upload.Dragger>}</>}
    </Drawer>

    <Modal open={detail !== undefined} title="操作结果" footer={null} onCancel={() => setDetail(undefined)} width={760}><Detail value={detail} /></Modal>
  </div>
}
