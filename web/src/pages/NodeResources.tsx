import { Button, Card, Table, Tag, Typography } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { listResources } from '../api/portal'

const { Text } = Typography

export default function NodeResources() {
  const resources = useQuery({ queryKey: ['node-resources'], queryFn: listResources })
  return <Card title="本节点数据资源" extra={<Button icon={<ReloadOutlined />} onClick={() => resources.refetch()}>刷新</Button>}>
    <Table rowKey="id" loading={resources.isLoading} dataSource={resources.data ?? []} columns={[
      { title: '资源名称', dataIndex: 'name' },
      { title: 'TDS 标识码', dataIndex: 'tds_code', render: (v) => v ? <Text code>{v}</Text> : '—' },
      { title: 'DomainData ID', dataIndex: 'kuscia_domaindata_id', render: (v) => v ? <Text code>{v}</Text> : '—' },
      { title: '数据类型', dataIndex: 'data_type', render: (v) => <Tag>{v}</Tag> },
      { title: '安全等级', dataIndex: 'security_level', render: (v) => <Tag>{v}级</Tag> },
      { title: '相对路径', dataIndex: 'relative_uri', render: (v) => v || '—' },
      { title: '数据源', dataIndex: 'datasource_name', render: (v) => v || '默认数据源' },
      { title: '状态', dataIndex: 'status', render: (v) => <Tag color={v === 'registered' ? 'blue' : 'default'}>{v}</Tag> },
    ]} />
  </Card>
}
