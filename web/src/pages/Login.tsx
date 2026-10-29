import { useState } from 'react'
import { Card, Form, Input, Button, message, Typography } from 'antd'
import { UserOutlined, LockOutlined, FireOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../auth/AuthContext'

const { Title, Text } = Typography

export default function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [loading, setLoading] = useState(false)

  const onFinish = async (v: { username: string; password: string }) => {
    setLoading(true)
    try {
      const { switched } = await login(v.username, v.password)
      if (switched) queryClient.clear()
      message.success('登录成功')
      navigate(switched ? '/onboarding' : '/status')
    } catch (e: any) {
      message.error(e.response?.data?.message ?? e.response?.data?.detail ?? '登录失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-page">
      <Card className="auth-card">
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div className="auth-brand" aria-hidden="true"><FireOutlined /></div>
          <Title level={3} style={{ marginBottom: 4 }}>
            连接器门户
          </Title>
          <Text type="secondary">Bonfire-TDS 连接器本地控制台</Text>
        </div>
        <Form onFinish={onFinish} size="large">
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
        <Text type="secondary" style={{ fontSize: 12 }}>
          门户复用平台身份，登录由门户后端代理平台校验。
        </Text>
      </Card>
    </div>
  )
}
