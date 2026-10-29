import { Layout, Menu, Dropdown, Avatar, Space } from 'antd'
import type { MenuProps } from 'antd'
import {
  UserOutlined,
  LogoutOutlined,
  FireOutlined,
} from '@ant-design/icons'
import { useLocation, useNavigate, Outlet } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'

const { Header, Sider, Content } = Layout

const menuItems: MenuProps['items'] = [
  { key: 'connector', label: '连接器管理', children: [
    { key: '/status', label: '概览' },
  ]},
  { key: 'data', label: '数据资源', children: [
    { key: '/datasources', label: '数据源' }, { key: '/data-movement', label: '数据传输' }, { key: '/resources', label: '数据资源' }, { key: '/transit-storage', label: '数据中转仓' },
  ]},
  { key: 'integration', label: '隐私保护计算', children: [
    { key: '/integrations/privacy-compute', label: '引擎状态' },
    { key: '/project-runs', label: '项目运行' },
    { key: '/computation-delegations', label: '计算委托' },
    { key: '/files', label: '文件管理' },
    { key: '/logs', label: '节点日志' },
  ]},
]

const routeItems = (menuItems ?? []).flatMap((group: any) => group?.children ?? [])

const pageTitles: Record<string, string> = {
  '/transit-storage': '数据中转仓', '/status': '概览', '/routes': '路由管理', '/datasources': '数据源',
  '/data-movement': '数据传输', '/resources': '数据资源', '/files': '文件管理', '/logs': '节点日志',
  '/project-runs': '项目运行', '/integrations/privacy-compute': '引擎状态', '/computation-delegations': '计算委托',
}

function selectedMenuKey(pathname: string): string {
  // Only leaf items are navigable. The previous lookup inspected top-level
  // group keys (connector/data/ops), so every child page fell back to /status.
  // Match an exact route or one of its nested detail paths, preferring the
  // longest key in case routes ever share a prefix.
  return routeItems
    .filter((item: any) => pathname === item.key || pathname.startsWith(`${item.key}/`))
    .sort((a: any, b: any) => String(b.key).length - String(a.key).length)[0]?.key ?? '/status'
}

export default function MainLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const { logout } = useAuth()
  const selectedKey = selectedMenuKey(location.pathname)
  const pageTitle = pageTitles[selectedKey] ?? '连接器控制台'

  return (
    <Layout className="app-shell" style={{ minHeight: '100vh' }}>
      <Sider className="app-sider" theme="light" width={248} collapsedWidth={76} breakpoint="lg" collapsible>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><FireOutlined /></span>
          <span className="brand-copy">连接器门户<small>Bonfire Connector</small></span>
        </div>
        <Menu
          className="app-menu"
          theme="light"
          mode="inline"
          selectedKeys={[selectedKey]}
          defaultOpenKeys={['connector', 'data', 'integration']}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <Layout>
        <Header className="app-header">
          <div>
            <div className="header-eyebrow">Bonfire-TDS 连接器本地控制台</div>
            <div className="header-title">{pageTitle}</div>
          </div>
          <Dropdown
            menu={{
              items: [{ key: 'logout', icon: <LogoutOutlined />, label: '退出登录', onClick: logout }],
            }}
          >
            <Space className="header-user" style={{ fontSize: 14, fontWeight: 400 }}>
              <Avatar size={30} icon={<UserOutlined />} style={{ background: '#283654' }} />
              连接器管理员
            </Space>
          </Dropdown>
        </Header>
        <Content className="content-canvas">
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
