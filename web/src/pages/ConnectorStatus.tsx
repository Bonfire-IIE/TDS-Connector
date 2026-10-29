import { useQuery } from '@tanstack/react-query'
import { Card, Descriptions, Tag, Button, Alert, Typography, Statistic, Row, Col, Progress, Divider, Space } from 'antd'
import { ReloadOutlined, SwapOutlined, DatabaseOutlined, ApartmentOutlined, FileOutlined, SafetyCertificateOutlined, CloudServerOutlined, ApiOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { getOverview } from '../api/portal'

const { Text } = Typography

export default function ConnectorStatus() {
  const navigate = useNavigate()
  const status = useQuery({ queryKey: ['portal-status'], queryFn: getOverview, refetchInterval: 10000 })
  const d = status.data
  const uptime = Math.floor((d?.uptime_seconds || 0) / 3600)
  const uptimeMin = Math.floor((d?.uptime_seconds || 0) / 60) % 60
  const metricCards = [
    ['数据源', d?.datasource_count ?? '不可用', <DatabaseOutlined />],
    ['数据资源', d?.resource_count ?? '不可用', <ApartmentOutlined />],
    ['中转对象', d?.services?.ts?.value ?? '不可用', <FileOutlined />],
    ['运行时间', `${uptime}h ${uptimeMin}m`, <SafetyCertificateOutlined />],
  ] as const

  return <div>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
      <div><Typography.Title level={3} style={{ margin: 0 }}>连接器概览</Typography.Title><Typography.Text type="secondary">查看当前节点的运行状态、资源概况与连接信息</Typography.Text></div>
      <Space><Button icon={<SwapOutlined />} onClick={() => navigate('/onboarding')}>切换连接器</Button><Button icon={<ReloadOutlined />} onClick={() => status.refetch()}>刷新</Button></Space>
    </div>
    {status.isError && <Alert type="error" showIcon style={{ marginBottom: 16 }} message="无法获取连接器概览" description="请确认 Portal 后端和 Lite 节点正常运行。" />}
    {d && <>
      <Card style={{ marginBottom: 16, background: '#fff' }}>
        <Row align="middle" gutter={24}><Col flex="auto"><Space size={14}><div style={{ width: 48, height: 48, borderRadius: 12, background: '#eff6ff', color: '#2563eb', display: 'grid', placeItems: 'center', fontSize: 25 }}><CloudServerOutlined /></div><div><Typography.Title level={4} style={{ margin: 0 }}>本地连接器</Typography.Title><Typography.Text type="secondary">{d.connector_id}</Typography.Text></div></Space></Col><Col><Tag color="blue" style={{ padding: '5px 12px', fontSize: 14 }}>门户在线</Tag></Col></Row>
      </Card>
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>{metricCards.map(([title, value, icon]) => <Col xs={24} sm={12} lg={6} key={title}><Card hoverable><Space align="start"><span style={{ color: '#2563eb', fontSize: 22 }}>{icon}</span><div><Statistic title={title} value={value as any} valueStyle={{ fontSize: 22 }} /></div></Space></Card></Col>)}</Row>
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}><Card title="资源与能力" extra={<Button type="link" onClick={() => navigate('/resources')}>查看资源</Button>}>
          <Row gutter={16}><Col span={12}><div style={{ display: 'flex', justifyContent: 'space-between' }}><Text>数据源</Text><Text strong>{d.datasource_count ?? "不可用"}</Text></div><Progress percent={Math.min(100, d.datasource_count * 10)} showInfo={false} strokeColor="#2563eb" /></Col><Col span={12}><div style={{ display: 'flex', justifyContent: 'space-between' }}><Text>数据资源</Text><Text strong>{d.resource_count ?? "不可用"}</Text></div><Progress percent={Math.min(100, d.resource_count * 10)} showInfo={false} strokeColor="#2563eb" /></Col></Row>
          <Divider style={{ margin: '20px 0' }} /><Space wrap><Tag icon={<DatabaseOutlined />} color="blue">本地数据源</Tag><Tag icon={<ApartmentOutlined />}>数据资源目录</Tag><Tag icon={<FileOutlined />}>节点文件</Tag><Tag icon={<ApiOutlined />} color={d.privacy_compute_configured ? (d.online ? 'blue' : 'gold') : 'default'}>{d.privacy_compute_configured ? (d.online ? '隐私计算能力可用' : '隐私计算能力不可用') : '隐私计算能力未配置'}</Tag></Space>
        </Card></Col>
        <Col xs={24} lg={10}><Card title="连接器信息"><Descriptions column={1} size="small"><Descriptions.Item label="隐私计算能力"><Tag color={d.privacy_compute_configured ? (d.online ? 'blue' : 'gold') : 'default'}>{d.privacy_compute_configured ? (d.online ? '可用' : '不可用') : '未配置'}</Tag></Descriptions.Item><Descriptions.Item label="执行系统 endpoint"><Text code>{d.privacy_compute_endpoint || '—'}</Text></Descriptions.Item><Descriptions.Item label="连接器 ID"><Text code copyable>{d.connector_id}</Text></Descriptions.Item></Descriptions></Card></Col>
      </Row>
    </>}
  </div>
}
