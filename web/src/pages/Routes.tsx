import { Button, Card, Table, Tag, Typography, Popconfirm, Empty } from 'antd'
import { ReloadOutlined, DeleteOutlined } from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { deleteRoute, listRoutes } from '../api/portal'
const { Text } = Typography
export default function RoutesPage() {
  const qc = useQueryClient(); const q = useQuery({ queryKey: ['portal-routes'], queryFn: listRoutes })
  const del = useMutation({ mutationFn: deleteRoute, onSuccess: () => qc.invalidateQueries({ queryKey: ['portal-routes'] }) })
  return <Card title="路由管理" extra={<Button icon={<ReloadOutlined />} onClick={() => q.refetch()}>刷新</Button>}>
    <Table rowKey="destination" loading={q.isLoading} locale={{ emptyText: <Empty description="暂无跨连接器路由" /> }} dataSource={q.data ?? []} columns={[
      { title: '源域', dataIndex: 'source', render: (v) => <Text code>{v}</Text> }, { title: '目标域', dataIndex: 'destination', render: (v) => <Text code>{v}</Text> },
      { title: '连接器', dataIndex: 'connector_name' }, { title: '状态', dataIndex: 'status', render: (v) => <Tag color={String(v).toLowerCase().includes('success') ? 'blue' : 'gold'}>{v}</Tag> },
      { title: '操作', render: (_: any, r: any) => <Popconfirm title="删除此路由？" onConfirm={() => del.mutate(r.destination)}><Button danger type="link" icon={<DeleteOutlined />}>删除</Button></Popconfirm> },
    ]} />
  </Card>
}
