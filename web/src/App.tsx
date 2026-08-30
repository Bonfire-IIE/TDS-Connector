import { Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Spin, Alert, Button } from 'antd'
import MainLayout from './layouts/MainLayout'
import ConnectorStatus from './pages/ConnectorStatus'
import DataSources from './pages/DataSources'
import Login from './pages/Login'
import Onboarding from './pages/Onboarding'
import DataFiles from './pages/DataFiles'
import NodeResources from './pages/NodeResources'
import Projects from './pages/Projects'
import NodeLogs from './pages/NodeLogs'
import RoutesPage from './pages/Routes'
import RemoteExec from './pages/RemoteExec'
import { useAuth } from './auth/AuthContext'
import { getOnboardingState } from './api/onboarding'

function RequireAuth({ children }: { children: JSX.Element }) {
  const { token } = useAuth()
  if (!token) return <Navigate to="/login" replace />
  return children
}

// 接入门禁：应用加载时查询接入态。
// 未接入 -> 一律跳 /onboarding；已接入仍允许主动进入向导以切换连接器。
function OnboardingGate() {
  const location = useLocation()
  const { token } = useAuth()
  const stateQ = useQuery({ queryKey: ['onboarding-state'], queryFn: getOnboardingState })

  if (stateQ.isLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" />
      </div>
    )
  }

  if (stateQ.isError) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Alert
          type="error"
          showIcon
          message="无法获取接入状态"
          description="无法连接门户后端 /portal/onboarding/state，请确认门户后端已启动。"
          action={<Button size="small" onClick={() => stateQ.refetch()}>重试</Button>}
        />
      </div>
    )
  }

  const onboarded = stateQ.data?.onboarded === true

  if (!onboarded && location.pathname !== '/onboarding') {
    return <Navigate to={token ? '/onboarding' : '/login'} replace />
  }
  return <Outlet />
}

export default function App() {
  return (
    <Routes>
      <Route element={<OnboardingGate />}>
        <Route path="/login" element={<Login />} />
        <Route path="/onboarding" element={<Onboarding />} />
        <Route
          element={
            <RequireAuth>
              <MainLayout />
            </RequireAuth>
          }
        >
          <Route path="/status" element={<ConnectorStatus />} />
          <Route path="/routes" element={<RoutesPage />} />
          <Route path="/datasources" element={<DataSources />} />
          <Route path="/files" element={<DataFiles />} />
          <Route path="/resources" element={<NodeResources />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/logs" element={<NodeLogs />} />
          <Route path="/remote-exec" element={<RemoteExec />} />
          <Route path="*" element={<Navigate to="/status" replace />} />
        </Route>
      </Route>
    </Routes>
  )
}
