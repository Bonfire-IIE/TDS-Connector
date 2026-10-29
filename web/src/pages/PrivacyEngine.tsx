import { Link } from 'react-router-dom'
import ComputeInputs from '../services/ComputeInputs'
import { useState } from 'react'
import { Alert, Button, Descriptions, Form, Input, InputNumber, Modal, Space, Spin, Tag, Typography, Upload, message } from 'antd'
import { CloudDownloadOutlined, ReloadOutlined, SwapOutlined, UploadOutlined } from '@ant-design/icons'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { activateEngine, deploymentScript, getEngineState, listExecutionRequests, ProvisionInfo, provisionEngine } from '../api/privacyEngine'

const { Paragraph, Text, Title } = Typography
const errorText = (e: any) => e?.response?.data?.detail ?? e?.message ?? '操作失败'
const defaults = { gateway_port: 28080, api_port: 28081, grpc_port: 28082, internal_port: 28083, metrics_port: 28084 }

export default function PrivacyEngine() {
  const qc = useQueryClient(); const state = useQuery({ queryKey: ['privacy-engine'], queryFn: getEngineState }); const requests = useQuery({ queryKey: ['privacy-engine-requests'], queryFn: listExecutionRequests, enabled: state.data?.status === 'available', refetchInterval: 10000 })
  const [open, setOpen] = useState(false); const [provision, setProvision] = useState<ProvisionInfo>(); const [script, setScript] = useState(''); const [files, setFiles] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false); const [form] = Form.useForm()
  const available = state.data?.status === 'available'
  const begin = () => { setOpen(true); setProvision(undefined); setScript(''); setFiles({}); form.setFieldsValue({ ...defaults, portal_endpoint: window.location.origin, portal_browser_url: state.data?.portal_browser_url, implementation_ref: state.data?.implementation_ref || `bonfire-${(state.data?.connector_id || 'node').replace(/[^a-z0-9-]/gi, '').slice(-12).toLowerCase()}`, control_endpoint: state.data?.control_endpoint, engine_datasource_ref: state.data?.engine_datasource_ref }) }
  const prepare = async () => { setBusy(true); try { const valuesBefore = form.getFieldsValue(); const p = await provisionEngine(valuesBefore.implementation_ref); const control_endpoint = `https://host.docker.internal:${valuesBefore.api_port || defaults.api_port}`; setProvision(p); form.setFieldsValue({ implementation_ref: p.implementation_ref, control_endpoint, engine_datasource_ref: p.engine_datasource_ref }); const values = { ...valuesBefore, control_endpoint, ...p }; setScript((await deploymentScript(values)).commands) } catch (e) { message.error(errorText(e)) } finally { setBusy(false) } }
  const encode = async (file: File) => { const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''; bytes.forEach(b => { binary += String.fromCharCode(b) }); setFiles(old => ({ ...old, [file.name]: btoa(binary) })); return false }
  if (state.isLoading) return <Spin />
  return <div>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, marginBottom: 20 }}><div><Title level={3} style={{ margin: 0 }}>引擎状态</Title><Text type="secondary">本地 Lite 执行节点连接中心 PETs Master，作业由中心统一调度。</Text></div><Space><Link to="/project-runs"><Button type="primary">项目日志与结果</Button></Link><Button icon={<ReloadOutlined />} onClick={() => state.refetch()}>刷新</Button><Button type="primary" icon={state.data?.configured ? <SwapOutlined /> : <CloudDownloadOutlined />} onClick={begin}>{state.data?.configured ? '部署/切换引擎' : '部署引擎'}</Button></Space></div>
    <Descriptions bordered column={1}><Descriptions.Item label="集成状态"><Tag color={available ? 'green' : state.data?.configured ? 'red' : 'default'}>{available ? '可用' : state.data?.configured ? '不可用' : '未配置'}</Tag></Descriptions.Item><Descriptions.Item label="引擎类型">{state.data?.engine_type || '—'}</Descriptions.Item><Descriptions.Item label="实现引用"><Text code>{state.data?.implementation_ref || '—'}</Text></Descriptions.Item><Descriptions.Item label="本地控制地址"><Text code>{state.data?.control_endpoint || '—'}</Text></Descriptions.Item><Descriptions.Item label="已验证能力">{available && state.data?.capabilities?.length ? state.data.capabilities.map(code => <Tag color="blue" key={code}>{code}</Tag>) : '—'}</Descriptions.Item>{state.data?.reason && <Descriptions.Item label="异常">{state.data.reason}</Descriptions.Item>}</Descriptions>
    {available && (requests.data?.length ?? 0) > 0 && <Alert type="info" showIcon style={{ marginTop: 16 }} message="隐私计算请求正在由连接器后台处理" description="连接器准备本地数据，计算调度和作业状态由中心 Kuscia Master 管理。" />} 
    <ComputeInputs />
    <Modal title="部署/切换隐私保护计算引擎" open={open} onCancel={() => setOpen(false)} width={760} footer={null}>
      <Form form={form} layout="vertical" initialValues={defaults} onFinish={async values => { setBusy(true); try { await activateEngine({ ...values, files }); message.success('Kuscia Lite 引擎已接入并通过能力验证'); setOpen(false); qc.invalidateQueries({ queryKey: ['privacy-engine'] }) } catch (e) { message.error(errorText(e)) } finally { setBusy(false) } }}>
        <Form.Item name="control_endpoint" hidden><Input /></Form.Item>
        <Form.Item name="implementation_ref" label="引擎节点名称" rules={[{ required: true, pattern: /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/ }]}><Input placeholder="例如 alice-bj" /></Form.Item>
        <Form.Item name="portal_endpoint" label="连接器服务地址" rules={[{ required: true }]} extra="中心平台用于向本连接器推送作业请求的地址。"><Input placeholder="例如 https://203.0.113.10:8122" /></Form.Item>
        <Form.Item name="portal_browser_url" label="Portal 浏览器访问地址（可选）" rules={[{type:'url',message:'请输入完整的 HTTP(S) 地址'}]} extra="填写业务用户实际访问的 Portal 地址，用于中心结果入口；留空时中心提供数据文件目录指引。服务地址不会自动作为浏览器地址。"><Input placeholder="例如 https://connector.example.com" /></Form.Item>
        <Form.Item name="gateway_endpoint" label="隐私计算引擎地址" rules={[{ required: true }]} extra="填写合作方可以访问本节点 Kuscia 引擎的地址。"><Input placeholder="例如 https://203.0.113.10:28080" /></Form.Item>
        <Form.Item name="engine_datasource_ref" label="引擎暂存数据源标识" rules={[{ required: true, message: '请输入部署中实际创建的数据源标识' }]}><Input placeholder="部署脚本创建的数据源标识" /></Form.Item>
        <Space wrap>{Object.entries({ gateway_port: '网关', api_port: '控制 API', grpc_port: '通信', internal_port: '应用', metrics_port: '监控' }).map(([name, label]) => <Form.Item key={name} name={name} label={`${label}端口`}><InputNumber min={1} max={65535} /></Form.Item>)}</Space>
        <Space style={{ marginBottom: 16 }}><Button type="primary" onClick={prepare} loading={busy}>生成 Kuscia 部署指令</Button>{provision && <Tag color="blue">节点 ID：{provision.implementation_ref}</Tag>}</Space>
        {script && <Paragraph copyable={{ text: script }} style={{ whiteSpace: 'pre-wrap', background: '#161b22', color: '#e6edf3', padding: 14, borderRadius: 6, fontFamily: 'monospace', maxHeight: 220, overflow: 'auto' }}>{script}</Paragraph>}
        <Form.Item label="引擎 API 证书"><Upload.Dragger multiple beforeUpload={encode} fileList={Object.keys(files).map((name, i) => ({ uid: String(i), name, status: 'done' }))} onRemove={f => { setFiles(old => { const next = { ...old }; delete next[f.name]; return next }); return true }}><UploadOutlined /> 上传部署脚本导出的证书文件</Upload.Dragger></Form.Item>
        <Button type="primary" htmlType="submit" loading={busy} disabled={!provision && !state.data?.configured}>接入本地引擎并验证能力</Button>
      </Form>
    </Modal>
  </div>
}
