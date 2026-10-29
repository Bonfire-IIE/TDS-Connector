import { Alert, Button, Select, Space, Table, Tag, Typography } from 'antd'
import { useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import {
  DatabaseRelation,
  listDatabaseRelations,
  listDatabaseSchemas,
} from '../../api/portal'

const { Text } = Typography
const errorText = (e: any) => String(e?.response?.data?.detail || e?.message || '读取失败')

export default function DatabaseTablePicker({ datasourceId, value, onChange }: {
  datasourceId: string
  value?: string
  onChange: (qualifiedName: string, objectRef: string) => void
}) {
  const [schemaSelection, setSchemaSelection] = useState<{ datasourceId: string; schemaRef: string }>()
  const schemas = useInfiniteQuery({
    queryKey: ['database-schemas', datasourceId],
    queryFn: ({ pageParam }) => listDatabaseSchemas(datasourceId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.next_cursor || undefined,
    enabled: Boolean(datasourceId), retry: false,
  })
  const schemaItems = schemas.data?.pages.flatMap(page => page.items) || []
  // Do not wait for an effect-driven state update before loading relations. Once
  // the first schema page arrives, its first item immediately drives the query.
  const selectedSchemaRef = schemaSelection?.datasourceId === datasourceId
    ? schemaSelection.schemaRef
    : undefined
  const activeSchemaRef = selectedSchemaRef || schemaItems[0]?.object_ref
  const activeSchema = schemaItems.find(item => item.object_ref === activeSchemaRef)
  const relations = useInfiniteQuery({
    queryKey: ['database-relations', datasourceId, activeSchemaRef],
    queryFn: ({ pageParam }) => listDatabaseRelations(datasourceId, activeSchemaRef!, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.next_cursor || undefined,
    enabled: Boolean(datasourceId && activeSchemaRef), retry: false,
  })
  const relationItems = relations.data?.pages.flatMap(page => page.items) || []

  const choose = (relation: DatabaseRelation) => {
    if (relation.transferable) onChange(relation.qualified_name, relation.object_ref)
  }

  return <Space direction="vertical" size={8} style={{ width: '100%' }}>
    <Space wrap>
      <Text strong>Schema</Text>
      <Select
        aria-label="数据库 Schema"
        loading={schemas.isLoading}
        placeholder="正在读取 Schema"
        value={activeSchemaRef}
        onChange={schemaRef => setSchemaSelection({ datasourceId, schemaRef })}
        options={schemaItems.map(item => ({ value: item.object_ref, label: item.name }))}
        style={{ width: 320 }}
      />
      {activeSchema && <Text type="secondary">当前：{activeSchema.name}</Text>}
    </Space>
    {schemas.isError && <Alert type="error" showIcon message="无法读取 Schema" description={errorText(schemas.error)} />}
    {!schemas.isLoading && !schemas.isError && schemaItems.length === 0 &&
      <Alert type="warning" showIcon message="数据库中没有可浏览的 Schema" />}
    {relations.isError && <Alert type="error" showIcon message="无法读取表和视图" description={errorText(relations.error)} />}
    {schemas.hasNextPage && <Button size="small" onClick={() => schemas.fetchNextPage()} loading={schemas.isFetchingNextPage}>加载更多 Schema</Button>}
    <Text strong>表和视图</Text>
    <Table<DatabaseRelation>
      size="small"
      rowKey="object_ref"
      loading={relations.isLoading || relations.isFetchingNextPage}
      dataSource={relationItems}
      pagination={{ pageSize: 8, size: 'small' }}
      locale={{ emptyText: activeSchemaRef ? '该 Schema 下没有可用的表或视图' : '数据库中没有可选择的 Schema' }}
      rowClassName={row => row.qualified_name === value ? 'ant-table-row-selected' : ''}
      onRow={row => ({ onClick: () => choose(row) })}
      columns={[
        { title: '表或视图', dataIndex: 'name', render: (name, row) => <Space>
          <a onClick={() => choose(row)}>{name}</a>
          {row.qualified_name === value && <Tag color="blue">已选</Tag>}
        </Space> },
        { title: '类型', dataIndex: 'relation_type', width: 100,
          render: type => type === 'view' ? '视图' : '表' },
        { title: '完整名称', dataIndex: 'qualified_name', render: name => <Text code>{name}</Text> },
        { title: '状态', width: 110, render: (_, row) => row.transferable ? '可搬运' : '不可搬运' },
      ]}
    />
    {relations.hasNextPage && <Button block onClick={() => relations.fetchNextPage()} loading={relations.isFetchingNextPage}>加载更多表和视图</Button>}
  </Space>
}
