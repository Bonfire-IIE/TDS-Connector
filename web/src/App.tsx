import { Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Spin, Alert, Button } from 'antd'
import MainLayout from './layouts/MainLayout'
import ConnectorStatus from './pages/ConnectorStatus'
import DataSources from './services/Sources'
import DataMovement from './services/Transfers'
import Login from './pages/Login'
import Onboarding from './pages/Onboarding'
import DataFiles from './pages/DataFiles'
import NodeResources from './services/Resources'
import Transit from './services/Transit'
import NodeLogs from './pages/NodeLogs'
import RoutesPage from './pages/Routes'
import ProjectRuns from './pages/ProjectRuns'
import PrivacyEngine from './pages/PrivacyEngine'
import ComputationDelegations from './pages/ComputationDelegations'
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

  // 登录页必须始终可见。把 /login 再重定向到自身会让 React Router
  // 只渲染空的 <Navigate>，最终页面只剩全局背景。
  if (!onboarded && location.pathname !== '/onboarding' && location.pathname !== '/login') {
    return <Navigate to={token ? '/onboarding' : '/login'} replace />
  }
  return <Outlet />
}

export default function App() {
  return (
    <Routes>
      <Route element={<OnboardingGate />}>
        <Route index element={<Navigate to="/login" replace />} />
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
          <Route path="/data-movement" element={<DataMovement />} />
          <Route path="/transit-storage" element={<Transit />} />
          <Route path="/files" element={<DataFiles />} />
          <Route path="/resources" element={<NodeResources />} />
          <Route path="/logs" element={<NodeLogs />} />
          <Route path="/project-runs" element={<ProjectRuns />} />
          <Route path="/integrations/privacy-compute" element={<PrivacyEngine />} />
          <Route path="/computation-delegations" element={<ComputationDelegations />} />
          <Route path="/computation-delegations/:delegationId" element={<ComputationDelegations />} />
          <Route path="*" element={<Navigate to="/status" replace />} />
        </Route>
      </Route>
    </Routes>
  )
}
