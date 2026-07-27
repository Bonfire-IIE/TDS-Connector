import { useQuery } from '@tanstack/react-query'
import { Card, Descriptions, Tag, Button, Alert, Typography } from 'antd'
import { ReloadOutlined, SwapOutlined } from '@ant-design/icons'
import { Space } from 'antd'
import { useNavigate } from 'react-router-dom'
import { getStatus } from '../api/portal'

const { Text } = Typography

export default function ConnectorStatus() {
  const navigate = useNavigate()
  const status = useQuery({
    queryKey: ['portal-status'],
    queryFn: getStatus,
    refetchInterval: 10000,
  })

  const d = status.data

  return (
    <Card
      title="连接器管理"
      extra={
        <Space>
          <Button icon={<SwapOutlined />} onClick={() => navigate('/onboarding')}>注册或绑定其他连接器</Button>
          <Button icon={<ReloadOutlined />} onClick={() => status.refetch()}>刷新</Button>
        </Space>
      }
      loading={status.isLoading}
    >
      {status.isError && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message="无法连接门户后端 /portal/status"
        />
      )}
      {d && (
        <Descriptions column={2} bordered size="small">
          <Descriptions.Item label="域 (domain_id)">
            <Text code>{d.domain_id}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="连接器 id">
            <Text code>{d.connector_id}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="Lite 可达">
            <Tag color={d.lite.reachable ? 'green' : 'red'}>
              {d.lite.reachable ? '可达' : '不可达'}
            </Tag>
          </Descriptions.Item>
          <Descriptions.Item label="节点在线">
            <Tag color={d.lite.node_online ? 'green' : 'red'}>
              {d.lite.node_online ? '在线' : '离线'}
            </Tag>
          </Descriptions.Item>
          <Descriptions.Item label="Lite endpoint">
            <Text code>{d.lite.endpoint}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="master endpoint">
            <Text code>{d.master.endpoint}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="存储根 (storage_root)" span={2}>
            <Text code>{d.storage_root}</Text>
          </Descriptions.Item>
        </Descriptions>
      )}
    </Card>
  )
}
