import { Layout, Menu, Dropdown, Avatar, Space } from 'antd'
import type { MenuProps } from 'antd'
import {
  ApiOutlined,
  DatabaseOutlined,
  UserOutlined,
  LogoutOutlined,
  FolderOpenOutlined,
  ProfileOutlined,
} from '@ant-design/icons'
import { useLocation, useNavigate, Outlet } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'

const { Header, Sider, Content } = Layout

const menuItems: MenuProps['items'] = [
  { key: '/status', icon: <ApiOutlined />, label: '连接器管理' },
  { key: '/datasources', icon: <DatabaseOutlined />, label: '数据源配置' },
  { key: '/files', icon: <FolderOpenOutlined />, label: '数据文件' },
  { key: '/resources', icon: <ProfileOutlined />, label: '本节点数据资源' },
]

export default function MainLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const { logout } = useAuth()
  const selectedKey = menuItems?.find((item: any) => location.pathname.startsWith(item.key))?.key as string || '/status'

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider theme="dark" breakpoint="lg" collapsible>
        <div
          style={{
            height: 48,
            margin: 16,
            color: '#fff',
            fontWeight: 600,
            fontSize: 15,
            display: 'flex',
            alignItems: 'center',
          }}
        >
          🔥 连接器门户
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            padding: '0 24px',
            fontSize: 18,
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span>Bonfire-TDS 连接器本地控制台</span>
          <Dropdown
            menu={{
              items: [{ key: 'logout', icon: <LogoutOutlined />, label: '退出登录', onClick: logout }],
            }}
          >
            <Space style={{ cursor: 'pointer', fontSize: 14, fontWeight: 400 }}>
              <Avatar size="small" icon={<UserOutlined />} />
              连接器管理员
            </Space>
          </Dropdown>
        </Header>
        <Content style={{ margin: 24 }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
