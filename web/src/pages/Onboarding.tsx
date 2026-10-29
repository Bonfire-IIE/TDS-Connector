import { useEffect, useState } from 'react'
import { Alert, Button, Card, Descriptions, Form, Input, Result, Space, Spin, Typography, message } from 'antd'
import { KeyOutlined, LockOutlined, UserOutlined } from '@ant-design/icons'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { finalize, generateIdentity, getOnboardingState, LocalIdentity, register } from '../api/onboarding'

const errorText = (e: any) => e?.response?.data?.detail ?? e?.message ?? '操作失败'

function LoginStep({ onDone }: { onDone: () => void }) {
  const { login } = useAuth(); const [loading, setLoading] = useState(false)
  return <Form layout="vertical" onFinish={async v => { setLoading(true); try { await login(v.username, v.password); onDone() } catch (e) { message.error(errorText(e)) } finally { setLoading(false) } }} style={{ maxWidth: 420 }}><Form.Item name="username" rules={[{ required: true }]}><Input prefix={<UserOutlined />} placeholder="平台用户名" /></Form.Item><Form.Item name="password" rules={[{ required: true }]}><Input.Password prefix={<LockOutlined />} placeholder="密码" /></Form.Item><Button type="primary" htmlType="submit" loading={loading} block>登录平台</Button></Form>
}

export default function Onboarding() {
  const navigate = useNavigate(); const qc = useQueryClient(); const { token } = useAuth()
  const state = useQuery({ queryKey: ['onboarding-state'], queryFn: getOnboardingState })
  const [identity, setIdentity] = useState<LocalIdentity>(); const [connectorId, setConnectorId] = useState<string>(); const [loading, setLoading] = useState(false)
  useEffect(() => { if (token && !state.data?.onboarded && !identity) generateIdentity().then(setIdentity).catch(e => message.error(errorText(e))) }, [token, state.data?.onboarded, identity])
  if (state.isLoading) return <Spin style={{ display: 'block', margin: '120px auto' }} />
  if (!token) return <Card style={{ maxWidth: 680, margin: '80px auto' }}><Typography.Title level={3}>连接器身份接入</Typography.Title><Alert type="info" showIcon style={{ marginBottom: 24 }} message="先登录中心平台身份" /><LoginStep onDone={() => qc.invalidateQueries({ queryKey: ['onboarding-state'] })} /></Card>
  if (state.data?.onboarded) return <Result status="success" title="连接器身份已激活" subTitle="连接器已取得平台签发的机器身份证书。计算引擎可在隐私保护计算中配置。" extra={<Button type="primary" onClick={() => navigate('/status')}>进入连接器门户</Button>} />
  if (!connectorId) return <Card style={{ maxWidth: 760, margin: '48px auto' }}><Space align="start"><KeyOutlined style={{ fontSize: 28, color: '#1677ff' }} /><div><Typography.Title level={3} style={{ marginTop: 0 }}>注册连接器身份</Typography.Title><Typography.Text type="secondary">私钥已在本机生成并以 0600 权限保存，只有 CSR 会提交中心。</Typography.Text></div></Space><Alert type="warning" showIcon style={{ margin: '20px 0' }} message="私钥永远不会离开当前连接器" />{identity ? <><Descriptions bordered size="small" column={1} style={{ marginBottom: 20 }}><Descriptions.Item label="CSR 指纹"><Typography.Text code copyable>{identity.csr_fingerprint}</Typography.Text></Descriptions.Item><Descriptions.Item label="公钥指纹"><Typography.Text code copyable>{identity.public_key_fingerprint}</Typography.Text></Descriptions.Item></Descriptions><Form layout="vertical" onFinish={async v => { setLoading(true); try { const c = await register({ ...v, csr_pem: identity.csr_pem }); setConnectorId(c.id); message.success('身份申请已提交') } catch (e) { message.error(errorText(e)) } finally { setLoading(false) } }}><Form.Item name="name" label="连接器名称" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="org_name" label="所属机构"><Input /></Form.Item><Button type="primary" htmlType="submit" loading={loading}>提交 CSR 注册申请</Button></Form></> : <Spin />}</Card>
  return <Card style={{ maxWidth: 760, margin: '48px auto' }}><Result status="info" title="等待中心审批" subTitle="运营方审批后将签发证书。Portal 会下载证书、校验指纹并激活连接器身份。" extra={<Button type="primary" loading={loading} onClick={async () => { setLoading(true); try { await finalize(connectorId); await state.refetch(); message.success('证书已安装，连接器身份已激活') } catch (e) { message.error(errorText(e)) } finally { setLoading(false) } }}>获取证书并完成接入</Button>} /></Card>
}
