import { useEffect, useState } from 'react'
import {
  Card, Steps, Form, Input, InputNumber, Button, Alert, message, Typography,
  Row, Col, Space, Spin, Result, Upload, Select, Segmented, Tooltip,
} from 'antd'
import type { UploadFile } from 'antd'
import {
  UserOutlined, LockOutlined, CopyOutlined, DownloadOutlined, UploadOutlined,
  QuestionCircleOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { useAuth } from '../auth/AuthContext'
import {
  getOnboardingState, register, getDeployScript, finalize, uploadCerts, listConnectors,
  discoverConnector,
  type NodeInfo, type RegisteredConnector,
} from '../api/onboarding'

// 读文件为 base64（去掉 dataURL 前缀）
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

const { Title, Text, Paragraph } = Typography

// 各端口默认值（设计 §8.3）。
const DEFAULT_NODE: NodeInfo = {
  lite_api_endpoint: '',
  lite_api_port: 28081,
  auth_port: 28080,
  grpc_port: 28082,
  app_port: 28083,
  data_port: 28084,
}

const errMsg = (e: any) =>
  e?.response?.data?.message ?? e?.response?.data?.detail ?? e?.message ?? '操作失败'

// —— 第 1 步：登录 ——
function StepLogin({ onDone }: { onDone: () => void }) {
  const { login } = useAuth()
  const [loading, setLoading] = useState(false)

  const onFinish = async (v: { username: string; password: string }) => {
    setLoading(true)
    try {
      await login(v.username, v.password)
      message.success('登录成功')
      onDone()
    } catch (e) {
      message.error(errMsg(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="接入向导第一步：登录平台身份。门户复用平台身份，登录由门户后端代理平台校验。"
      />
      <Form onFinish={onFinish} size="large" style={{ maxWidth: 400 }}>
        <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
          <Input prefix={<UserOutlined />} placeholder="用户名" />
        </Form.Item>
        <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
          <Input.Password prefix={<LockOutlined />} placeholder="密码" />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading}>
            登录
          </Button>
        </Form.Item>
      </Form>
    </>
  )
}

// —— 第 2 步：注册连接器 ——
function StepRegister({ onDone }: { onDone: (c: RegisteredConnector, node: NodeInfo) => void }) {
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)

  const onFinish = async (v: any) => {
    setLoading(true)
    const node: NodeInfo = {
      lite_api_endpoint: v.lite_api_endpoint,
      lite_api_port: v.lite_api_port,
      auth_port: v.auth_port,
      grpc_port: v.grpc_port,
      app_port: v.app_port,
      data_port: v.data_port,
    }
    try {
      const c = await register({
        name: v.name,
        org_name: v.org_name || undefined,
        kuscia_domain_id: v.kuscia_domain_id,
        ...node,
      })
      message.success('注册已提交，等待运营方审批')
      onDone(c, node)
    } catch (e) {
      message.error(errMsg(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="提交后由运营方在中心平台审批；审批通过后本页会出现部署脚本。"
      />
      <Form
        form={form}
        layout="vertical"
        onFinish={onFinish}
        initialValues={{ ...DEFAULT_NODE }}
      >
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item name="name" label="连接器名称" rules={[{ required: true }]}>
              <Input placeholder="如：alice 数据连接器" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="org_name" label="所属机构（选填）">
              <Input placeholder="如：某某数据服务有限公司" />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item
              name="kuscia_domain_id"
              label="节点域名 (kuscia_domain_id)"
              rules={[
                { required: true },
                {
                  pattern: /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/,
                  message: '需为小写 RFC1123 标签（小写字母/数字/连字符，不以连字符开头结尾）',
                },
              ]}
              extra="Kuscia 节点域标识，小写 RFC1123，如 alice"
            >
              <Input placeholder="alice" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="lite_api_endpoint"
              label="节点物理地址 (lite_api_endpoint)"
              rules={[{ required: true }]}
              extra="连接器主机可达地址，如 https://10.0.0.8"
            >
              <Input placeholder="https://10.0.0.8" />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col span={8}>
            <Form.Item name="lite_api_port" label="Lite API 端口" rules={[{ required: true }]}>
              <InputNumber style={{ width: '100%' }} min={1} max={65535} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="auth_port" label="网关端口 (auth_port)" rules={[{ required: true }]}>
              <InputNumber style={{ width: '100%' }} min={1} max={65535} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="grpc_port" label="gRPC 端口" rules={[{ required: true }]}>
              <InputNumber style={{ width: '100%' }} min={1} max={65535} />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col span={8}>
            <Form.Item name="app_port" label="应用端口 (app_port)" rules={[{ required: true }]}>
              <InputNumber style={{ width: '100%' }} min={1} max={65535} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="data_port" label="数据端口 (data_port)" rules={[{ required: true }]}>
              <InputNumber style={{ width: '100%' }} min={1} max={65535} />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={loading}>
            提交注册
          </Button>
        </Form.Item>
      </Form>
    </>
  )
}

// —— 第 3 步：部署 Lite ——
function StepDeploy({ connectorId, onDone }: { connectorId: string; onDone: () => void }) {
  const scriptQ = useQuery({
    queryKey: ['onboarding-deploy-script', connectorId],
    queryFn: () => getDeployScript(connectorId),
    enabled: !!connectorId,
    // 待审批(pending)每 5s 轮询一次；拿到脚本(ready)后停止。
    refetchInterval: (q) => (q.state.data?.status === 'ready' ? false : 5000),
  })

  if (scriptQ.isLoading) {
    return <Spin tip="加载中…"><div style={{ height: 80 }} /></Spin>
  }
  if (scriptQ.isError) {
    return (
      <Alert
        type="error"
        showIcon
        message="拉取部署脚本失败"
        description={errMsg(scriptQ.error)}
        action={<Button size="small" onClick={() => scriptQ.refetch()}>重试</Button>}
      />
    )
  }
  if (scriptQ.data?.status !== 'ready') {
    return (
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Alert
          type="warning"
          showIcon
          message="待运营方审批…"
          description="已提交注册，正在等待运营方在中心平台审批。审批通过后将自动出现部署脚本（每 5 秒自动刷新）。"
        />
        <Spin />
      </Space>
    )
  }

  const s = scriptQ.data.script
  const scriptText = Array.isArray(s.commands) ? s.commands.join('\n') : s.commands

  const copyScript = async () => {
    try {
      await navigator.clipboard.writeText(scriptText)
      message.success('已复制脚本')
    } catch {
      message.error('复制失败，请手动选择复制')
    }
  }

  const downloadScript = () => {
    const blob = new Blob([scriptText], { type: 'text/x-shellscript' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `deploy-${connectorId}.sh`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Alert
        type="success"
        showIcon
        message="审批通过，请在连接器主机执行下方脚本部署 Kuscia Lite。"
      />
      <div>
        <Text strong>部署令牌 (deploy_token)：</Text>{' '}
        <Text code copyable={{ text: s.deploy_token }}>{s.deploy_token}</Text>
      </div>
      <Row gutter={16}>
        <Col span={12}>
          <Text type="secondary">master_endpoint：</Text> <Text code>{s.master_endpoint}</Text>
        </Col>
        <Col span={12}>
          <Text type="secondary">kuscia_image：</Text> <Text code>{s.kuscia_image}</Text>
        </Col>
      </Row>
      <div>
        <Space style={{ marginBottom: 8 }}>
          <Text strong>一键部署脚本</Text>
          <Button size="small" icon={<CopyOutlined />} onClick={copyScript}>复制</Button>
          <Button size="small" icon={<DownloadOutlined />} onClick={downloadScript}>下载 .sh</Button>
        </Space>
        <SyntaxHighlighter
          language="bash"
          style={oneDark}
          showLineNumbers
          wrapLongLines={false}
          customStyle={{
            margin: 0,
            maxHeight: 420,
            borderRadius: 8,
            fontSize: 13,
            lineHeight: 1.6,
          }}
          codeTagProps={{ style: { fontFamily: 'SFMono-Regular, Consolas, Liberation Mono, monospace' } }}
        >
          {scriptText}
        </SyntaxHighlighter>
        <Paragraph type="secondary" style={{ marginTop: 8 }}>
          在连接器主机执行该脚本部署 Kuscia Lite；Lite 加入 master 后点击下方按钮继续。
        </Paragraph>
      </div>
      <Button type="primary" onClick={onDone}>我已完成部署</Button>
    </Space>
  )
}

// —— 第 4 步：完成接入 finalize ——
function StepFinalize({
  connectorId, onDone,
}: {
  connectorId: string
  onDone: () => void
}) {
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [fileList, setFileList] = useState<UploadFile[]>([])

  const onFinish = async () => {
    if (fileList.length === 0) {
      message.warning('请先上传 Lite 证书（ca.crt / kusciaapi-server.crt / kusciaapi-server.key / token）')
      return
    }
    setLoading(true)
    try {
      // 读取上传的证书为 base64，交门户写入其数据根
      const files: Record<string, string> = {}
      for (const f of fileList) {
        const raw = (f.originFileObj as File) ?? (f as unknown as File)
        files[f.name] = await fileToBase64(raw)
      }
      await uploadCerts(connectorId, files)
      // 证书就位后完成接入：门户探活本地 Lite、落本地状态（端口/地址注册时已存中心）
      await finalize({ connector_id: connectorId })
      onDone()
    } catch (e) {
      message.error(errMsg(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="按部署脚本把 Lite 证书取出，在此上传 ca.crt / kusciaapi-server.crt / kusciaapi-server.key / token 四个文件。点击“完成接入”后，门户会把证书存入自身数据根、探活本地 Lite、回传节点信息并落本地状态（端口按注册值推导，无需手填路径）。"
      />
      <Form form={form} layout="vertical" onFinish={onFinish}>
        <Form.Item label="上传 Lite 证书" required>
          <Upload
            multiple
            beforeUpload={() => false}
            fileList={fileList}
            onChange={({ fileList: fl }) => setFileList(fl)}
          >
            <Button icon={<UploadOutlined />}>选择证书文件</Button>
          </Upload>
        </Form.Item>
        <Text type="secondary">
          节点地址与端口在第 2 步注册时已提交中心，此处无需重复填写；门户按注册端口定位本地 Lite。
        </Text>
        <Form.Item style={{ marginTop: 16 }}>
          <Button type="primary" htmlType="submit" loading={loading}>
            完成接入
          </Button>
        </Form.Item>
      </Form>
    </>
  )
}

// —— 已注册连接器：绕过注册/部署，直接绑定已有连接器 ——
function StepBindExisting({ onDone }: { onDone: () => void }) {
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [fileList, setFileList] = useState<UploadFile[]>([])
  const [discovery, setDiscovery] = useState<{ detected: boolean; message?: string; file_service_configured?: boolean } | null>(null)
  const connsQ = useQuery({ queryKey: ['portal-connectors'], queryFn: listConnectors })
  const conns = (connsQ.data ?? []).filter((c) =>
    ['approved', 'online', 'offline'].includes(c.status),
  )
  const selected = Form.useWatch('connector_id', form)
  const domain = conns.find((c) => c.id === selected)?.kuscia_domain_id || '<domain-id>'
  const certCommand = `mkdir -p ./${domain}-certs && docker cp "$(docker ps -qf name=${domain} | head -n1)":/home/kuscia/var/certs/. ./${domain}-certs/ && ls -1 ./${domain}-certs`

  const onSelect = async (id: string) => {
    setDiscovery(null)
    const c = conns.find((x) => x.id === id)
    if (c?.lite_api_endpoint) {
      form.setFieldValue(
        'lite_endpoint',
        `${c.lite_api_endpoint.replace(/\/+$/, '')}:${c.lite_api_port ?? 28081}`,
      )
    }
    try {
      const found = await discoverConnector(id)
      setDiscovery(found)
      if (found.detected && found.lite_endpoint) form.setFieldValue('lite_endpoint', found.lite_endpoint)
    } catch (e) {
      setDiscovery({ detected: false, message: errMsg(e) })
    }
  }

  const onFinish = async (v: { connector_id: string; lite_endpoint: string }) => {
    if (!discovery?.detected && fileList.length === 0) {
      message.warning('请上传 Lite 证书（ca.crt / kusciaapi-server.crt / kusciaapi-server.key / token）')
      return
    }
    setLoading(true)
    try {
      if (!discovery?.detected) {
        const files: Record<string, string> = {}
        for (const f of fileList) {
          const raw = (f.originFileObj as File) ?? (f as unknown as File)
          files[f.name] = await fileToBase64(raw)
        }
        await uploadCerts(v.connector_id, files)
      }
      await finalize({ connector_id: v.connector_id, lite_kuscia_endpoint: v.lite_endpoint })
      onDone()
    } catch (e) {
      message.error(errMsg(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="选择连接器后，门户会先从 PORTAL_HOME 自动发现 connector.yaml 和证书并校验目标域；未发现时再回退到手动上传。"
      />
      <Form form={form} layout="vertical" onFinish={onFinish}>
        <Form.Item name="connector_id" label="选择连接器" rules={[{ required: true }]}>
          <Select
            loading={connsQ.isLoading}
            placeholder="选择一个已注册连接器"
            onChange={onSelect}
            options={conns.map((c) => ({
              value: c.id,
              label: `${c.name}（${c.kuscia_domain_id} · ${c.status}）`,
            }))}
            notFoundContent="暂无可绑定的已注册连接器"
          />
        </Form.Item>
        {discovery && <Alert style={{ marginBottom: 16 }} showIcon type={discovery.detected ? 'success' : 'warning'} message={discovery.detected ? '已发现并验证本地连接器证书，无需上传' : '未能自动发现证书，请手动上传'} description={discovery.detected && !discovery.file_service_configured ? '证书可用；节点文件服务尚未配置，接入后“数据文件”功能将保持禁用。' : discovery.message} />}
        <Form.Item
          name="lite_endpoint"
          label="本地 Lite KusciaAPI 地址"
          rules={[{ required: true }]}
          extra="门户连接本机 Lite 的地址，如 https://127.0.0.1:28081"
        >
          <Input placeholder="https://127.0.0.1:28081" />
        </Form.Item>
        {!discovery?.detected && <Form.Item label={<Space size={4}>上传 Lite 证书<Tooltip overlayInnerStyle={{ background: '#fff', color: '#222', opacity: 1, boxShadow: '0 4px 16px rgba(0,0,0,.18)' }} title={<Space direction="vertical" style={{ color: '#222', maxWidth: 560 }}><Typography.Text style={{ color: '#222' }}>在运行 Kuscia Lite 的连接器主机执行：</Typography.Text><Typography.Text code style={{ color: '#222', whiteSpace: 'normal', wordBreak: 'break-all' }}>{certCommand}</Typography.Text><Typography.Text style={{ color: '#555' }}>将生成的证书文件上传到此处。</Typography.Text></Space>}><QuestionCircleOutlined style={{ color: '#1677ff', cursor: 'help' }} /></Tooltip></Space>} required>
          <Upload
            multiple
            beforeUpload={() => false}
            fileList={fileList}
            onChange={({ fileList: fl }) => setFileList(fl)}
          >
            <Button icon={<UploadOutlined />}>选择证书文件</Button>
          </Upload>
        </Form.Item>}
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={loading}>
            完成接入
          </Button>
        </Form.Item>
      </Form>
    </>
  )
}

export default function Onboarding() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { token } = useAuth()

  const stateQ = useQuery({ queryKey: ['onboarding-state'], queryFn: getOnboardingState })

  const [current, setCurrent] = useState(0)
  const [connectorId, setConnectorId] = useState('')
  // 接入方式：new=注册新连接器(登录→注册→部署→完成)；existing=已注册连接器(登录→绑定)。
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const [hydrated, setHydrated] = useState(false)

  // 首次进入：已登录跳过登录步；若中心已有待审批记录则直接到部署步。
  useEffect(() => {
    if (hydrated || stateQ.isLoading) return
    const pending = stateQ.data?.pending
    if (pending?.connector_id) {
      setConnectorId(pending.connector_id)
      setCurrent(token ? 2 : 0)
    } else if (token) {
      setCurrent(1)
    }
    setHydrated(true)
  }, [hydrated, stateQ.isLoading, stateQ.data, token])

  const finishOnboarding = async () => {
    message.success('接入完成，欢迎使用连接器门户')
    await qc.invalidateQueries({ queryKey: ['onboarding-state'] })
    navigate('/status', { replace: true })
  }

  const items =
    mode === 'new'
      ? [{ title: '登录' }, { title: '注册连接器' }, { title: '部署 Lite' }, { title: '完成接入' }]
      : [{ title: '登录' }, { title: '绑定已有连接器' }]

  if (stateQ.isLoading || !hydrated) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" />
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f4f6f8', padding: '32px 16px' }}>
      <div style={{ maxWidth: 920, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <Title level={3} style={{ marginBottom: 4 }}>🔥 连接器接入向导</Title>
          <Text type="secondary">首次使用需完成接入：登录 → 注册 → 部署 → 完成</Text>
          {stateQ.data?.access_denied && (
            <Alert
              style={{ marginTop: 16, textAlign: 'left' }}
              type="warning"
              showIcon
              message="当前账号不是本机已保存连接器的属主"
              description="请选择并绑定当前账号自己的连接器，或注册新的连接器。"
            />
          )}
          {stateQ.data?.onboarded && <div style={{ marginTop: 8 }}><Button onClick={() => navigate('/status')}>返回当前连接器</Button></div>}
        </div>
        <Card>
          <div style={{ textAlign: 'center', marginBottom: 20 }}>
            <Segmented
              value={mode}
              onChange={(v) => { setMode(v as 'new' | 'existing'); setCurrent(token ? 1 : 0) }}
              options={[
                { label: '注册新连接器', value: 'new' },
                { label: '已注册连接器', value: 'existing' },
              ]}
            />
          </div>
          <Steps
            current={current}
            items={items}
            onChange={setCurrent}
            style={{ marginBottom: 32, cursor: 'pointer' }}
          />

          {current === 0 && (
            <StepLogin onDone={() => setCurrent(1)} />
          )}

          {mode === 'new' && current === 1 && (
            <StepRegister
              onDone={(c) => {
                setConnectorId(c.connector_id)
                setCurrent(2)
              }}
            />
          )}
          {mode === 'new' && current === 2 && (
            connectorId
              ? <StepDeploy connectorId={connectorId} onDone={() => setCurrent(3)} />
              : <Result status="warning" title="缺少连接器信息，请返回重新注册" />
          )}
          {mode === 'new' && current === 3 && (
            connectorId
              ? <StepFinalize connectorId={connectorId} onDone={finishOnboarding} />
              : <Result status="warning" title="缺少连接器信息，请返回重新注册" />
          )}

          {mode === 'existing' && current === 1 && (
            <StepBindExisting onDone={finishOnboarding} />
          )}

        </Card>
      </div>
    </div>
  )
}
