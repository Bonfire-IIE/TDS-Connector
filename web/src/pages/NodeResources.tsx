import { Button, Card, Table, Tag, Typography, Modal, Form, Input, Select, message, Space, Divider, Tooltip, Popconfirm, Alert } from 'antd'
import { ReloadOutlined, PlusOutlined, UploadOutlined, DeleteOutlined, EditOutlined, MinusCircleOutlined } from '@ant-design/icons'
import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  CatalogInspection,
  CatalogObject,
  inspectDatasourceObject,
  listDatasourceObjects,
  listResources,
  registerResource,
  updateResource,
  publishResource,
  deleteResource,
  listDatasources,
  startDatasourceIndex,
} from '../api/portal'
import { useEffect, useState } from 'react'

const { Text } = Typography
const initial = { security_level: 'general_1', personal_information_level: '0', data_source_type: '01', update_frequency: '不更新', data_type: 'table', data_items: [] }
const UPDATE_FREQUENCY_OPTIONS = [
  { value: '1次/天', label: '每日' },
  { value: '1次/周', label: '每周' },
  { value: '1次/月', label: '每月' },
  { value: '1次/季度', label: '每季度' },
  { value: '1次/年', label: '每年' },
  { value: '不更新', label: '不更新' },
  { value: '其他', label: '其他' },
]
const industries = [
  ['A', '农、林、牧、渔业'], ['B', '采矿业'], ['C', '制造业'], ['D', '电力、热力、燃气及水生产和供应业'], ['E', '建筑业'],
  ['F', '批发和零售业'], ['G', '交通运输、仓储和邮政业'], ['H', '住宿和餐饮业'], ['I', '信息传输、软件和信息技术服务业'], ['J', '金融业'],
  ['K', '房地产业'], ['L', '租赁和商务服务业'], ['M', '科学研究和技术服务业'], ['N', '水利、环境和公共设施管理业'], ['O', '居民服务、修理和其他服务业'],
  ['P', '教育'], ['Q', '卫生和社会工作'], ['R', '文化、体育和娱乐业'], ['S', '公共管理、社会保障和社会组织'], ['T', '国际组织'],
].map(([value, label]) => ({ value, label: `${value} ${label}` }))
const themes = [
  ['ZA', '综合政务'], ['ZB', '经济管理'], ['ZC', '国土资源、能源'], ['ZD', '工业、交通'], ['ZE', '信息产业'], ['ZF', '城乡建设、环境保护'],
  ['ZG', '农业、水利'], ['ZH', '财政'], ['ZJ', '商业、贸易'], ['ZK', '旅游、服务业'], ['ZL', '气象、水文、测绘、地震'], ['ZM', '对外事务'],
  ['ZN', '政法、监察'], ['ZP', '科技、教育'], ['ZQ', '文化、卫生、体育'], ['ZR', '军事、国防'], ['ZS', '劳动、人事'], ['ZT', '民政、社区'],
  ['ZU', '文秘、行政'], ['ZV', '综合党团'], ['ZW', '综合类'],
].map(([value, label]) => ({ value, label: `${value} ${label}` }))
const RESOURCE_FORMAT_OPTIONS = ['CSV', 'TSV', 'JSON', 'JSONL', 'PARQUET', 'ORC', 'TABLE', 'XLSX', 'BINARY'].map(value => ({ value, label: value }))
const COLUMN_TYPE_OPTIONS = [
  'string', 'boolean', 'tinyint', 'smallint', 'int', 'bigint',
  'float', 'double', 'decimal(18,2)', 'date', 'time', 'timestamp', 'bytes',
].map(value => ({ value, label: value }))

const SECURITY_LABELS: Record<string, string> = { general_1: '一般一级', general1: '一般一级', general_2: '一般二级', general2: '一般二级', important: '重要数据' }
const RESOURCE_STATES: Record<string, { label: string; color: string }> = {
  registered: { label: '仅自己可见', color: 'default' },
  pending_review: { label: '待中心审核', color: 'gold' },
  published: { label: '已上架', color: 'blue' },
  rejected: { label: '审核驳回', color: 'red' },
  delisted: { label: '已下架', color: 'default' },
}
const resourceDate = (value?: string) => {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('zh-CN')
}

type CatalogLevel = { ref?: string; name: string }

function CatalogPicker({ open, datasourceId, onClose, onSelect }: {
  open: boolean
  datasourceId?: string
  onClose: () => void
  onSelect: (item: CatalogObject, inspection?: CatalogInspection) => void
}) {
  const [levels, setLevels] = useState<CatalogLevel[]>([{ name: '根目录' }])
  const [query, setQuery] = useState('')
  const [selecting, setSelecting] = useState<string>()
  useEffect(() => {
    if (open) {
      setLevels([{ name: '根目录' }])
      setQuery('')
      setSelecting(undefined)
    }
  }, [open, datasourceId])
  const parentRef = query ? undefined : levels[levels.length - 1]?.ref
  const objects = useInfiniteQuery({
    queryKey: ['catalog-objects', datasourceId, parentRef, query],
    queryFn: ({ pageParam }) => listDatasourceObjects(datasourceId!, parentRef, query, pageParam as string | undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.next_cursor || undefined,
    enabled: open && Boolean(datasourceId),
  })
  const rows = objects.data?.pages.flatMap(page => page.items) ?? []
  const index = useMutation({
    mutationFn: () => startDatasourceIndex(datasourceId!),
    onSuccess: () => message.success('目录索引已开始更新，完成后可搜索全部对象'),
    onError: (e: any) => message.error(e.response?.data?.detail ?? e.message ?? '索引启动失败'),
  })

  const enter = (item: CatalogObject) => {
    setQuery('')
    setLevels(previous => previous.concat({ ref: item.object_ref, name: item.name }))
  }
  const choose = async (item: CatalogObject) => {
    if (!datasourceId || !item.selectable) return
    setSelecting(item.object_ref)
    try {
      const inspection = item.inspectable
        ? await inspectDatasourceObject(datasourceId, item.object_ref)
        : undefined
      onSelect(item, inspection)
      onClose()
    } catch (e: any) {
      message.error(e.response?.data?.detail ?? e.message ?? '对象结构探测失败')
    } finally {
      setSelecting(undefined)
    }
  }

  return <Modal title="选择数据对象" open={open} width={820} footer={null} onCancel={onClose} destroyOnClose>
    <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
      <Space wrap>
        {levels.map((level, indexValue) => <Button key={`${level.ref || 'root'}-${indexValue}`} type="link" onClick={() => { setQuery(''); setLevels(levels.slice(0, indexValue + 1)) }}>{level.name}</Button>)}
      </Space>
      <Space>
        <Input.Search allowClear placeholder="搜索文件、表或工作表" style={{ width: 260 }} onSearch={setQuery} onChange={event => { if (!event.target.value) setQuery('') }} />
        <Button loading={index.isPending} onClick={() => index.mutate()}>更新索引</Button>
      </Space>
    </Space>
    <Divider style={{ margin: '12px 0' }} />
    <Table<CatalogObject>
      rowKey="object_ref"
      size="small"
      loading={objects.isLoading || objects.isFetchingNextPage}
      dataSource={rows}
      pagination={false}
      locale={{ emptyText: query ? '没有匹配的数据对象，请先更新索引' : '当前目录为空' }}
      columns={[
        { title: '名称', dataIndex: 'name' },
        { title: '类型', dataIndex: 'kind', width: 110, render: value => ({ directory: '目录', schema: 'Schema', table: '表', view: '视图', workbook: '工作簿', sheet: '工作表', file: '文件', catalog: 'Catalog' }[value as string] || value) },
        { title: '格式', dataIndex: 'format', width: 100, render: value => value || '—' },
        { title: '操作', width: 150, render: (_, item) => <Space>{item.expandable && <Button type="link" onClick={() => enter(item)}>打开</Button>}{item.selectable && <Button type="link" loading={selecting === item.object_ref} onClick={() => choose(item)}>选择</Button>}</Space> },
      ]}
    />
    {objects.hasNextPage && <Button block style={{ marginTop: 12 }} onClick={() => objects.fetchNextPage()} loading={objects.isFetchingNextPage}>加载更多</Button>}
  </Modal>
}

export default function NodeResources() {
  const qc = useQueryClient(); const [open, setOpen] = useState(false); const [catalogOpen, setCatalogOpen] = useState(false); const [editing, setEditing] = useState<string | undefined>(); const [form] = Form.useForm()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>()
  const datasourceId = Form.useWatch('datasource_id', form)
  const dataType = Form.useWatch('data_type', form)
  const resources = useQuery({ queryKey: ['node-resources'], queryFn: listResources }); const datasources = useQuery({ queryKey: ['portal-datasources'], queryFn: listDatasources })
  const close = () => { setOpen(false); setEditing(undefined); form.resetFields() }
  const mutation = useMutation<any, any, any>({ mutationFn: (v: any) => editing ? updateResource(editing, v) : registerResource(v), onSuccess: () => { message.success(editing ? '资源已修改' : '资源已登记'); close(); qc.invalidateQueries({ queryKey: ['node-resources'] }) }, onError: (e: any) => message.error(e.response?.data?.detail ?? e.message ?? '保存失败') })
  const publish = useMutation({ mutationFn: publishResource, onSuccess: () => { message.success('已提交中心审核'); qc.invalidateQueries({ queryKey: ['node-resources'] }) }, onError: (e: any) => message.error(e.response?.data?.detail ?? '上架申请失败') })
  const remove = useMutation({ mutationFn: deleteResource, onSuccess: () => { message.success('资源已删除'); qc.invalidateQueries({ queryKey: ['node-resources'] }) }, onError: (e: any) => message.error(e.response?.data?.detail ?? '删除失败') })
  const edit = (r: any) => { setEditing(r.id); form.setFieldsValue({ ...r, data_items: r.data_items || [], data_modalities: (r.data_modalities || []).join(',') }); setOpen(true) }
  const sourceName = (id: string) => datasources.data?.find(x => x.external_source_ref === id || x.id === id)?.name || id || '—'
  const rows = (resources.data ?? []).filter(r => {
    const keyword = search.trim().toLowerCase()
    return (!statusFilter || r.status === statusFilter) && (!keyword || [r.resource_name, r.resource_code, r.resource_abstract, r.resource_owner_name, sourceName(r.datasource_id)].some(v => String(v || '').toLowerCase().includes(keyword)))
  })
  return <Card className="resource-catalog" title={<div className="resource-catalog-heading">数据资源<span>管理已登记资源，查看数据来源与上架状态</span></div>} extra={<Space><Button icon={<ReloadOutlined />} loading={resources.isFetching} onClick={() => resources.refetch()}>刷新</Button><Button type="primary" icon={<PlusOutlined />} onClick={() => { form.setFieldsValue(initial); setOpen(true) }}>登记资源</Button></Space>}>
    <div className="resource-catalog-toolbar">
      <Space wrap>
        <Input.Search allowClear placeholder="搜索资源名称、标识、摘要或持有方" value={search} onChange={e => setSearch(e.target.value)} style={{ width: 320, maxWidth: '100%' }} />
        <Select allowClear placeholder="全部状态" aria-label="按资源状态筛选" value={statusFilter} onChange={setStatusFilter} style={{ width: 150 }} options={Object.entries(RESOURCE_STATES).map(([value, state]) => ({ value, label: state.label }))} />
      </Space>
      <Text type="secondary">共 {resources.data?.length ?? 0} 项资源{(search || statusFilter) && ` · 筛选结果 ${rows.length} 项`}</Text>
    </div>
    {resources.isError && <Alert type="error" showIcon message="资源加载失败，请刷新重试" style={{ marginBottom: 16 }} />}
    <Table className="resource-catalog-table" rowKey="id" loading={resources.isLoading} dataSource={rows} scroll={{ x: 1220 }} pagination={{ defaultPageSize: 10, showSizeChanger: true, showTotal: total => `共 ${total} 项` }} locale={{ emptyText: search || statusFilter ? '没有符合条件的资源' : '暂无数据资源，点击「登记资源」开始添加' }} columns={[
      { title: '资源信息', key: 'resource', width: 350, render: (_: any, r: any) => <div className="resource-cell">
        <div className="resource-cell-title"><span className="resource-format-badge">{r.resource_format || 'DATA'}</span><Tooltip title={r.resource_name}><strong>{r.resource_name}</strong></Tooltip></div>
        <Tooltip title={r.resource_abstract}><div className="resource-cell-description">{r.resource_abstract || '暂无资源摘要'}</div></Tooltip>
        <Text className="resource-code" type="secondary" copyable={r.resource_code ? { text: r.resource_code } : false}>{r.resource_code || '尚无资源标识码'}</Text>
      </div> },
      { title: '来源与结构', key: 'source', width: 230, render: (_: any, r: any) => <div className="resource-cell">
        <Tooltip title={sourceName(r.datasource_id)}><div className="resource-cell-primary">{sourceName(r.datasource_id)}</div></Tooltip>
        <Tooltip title={r.relative_uri}><div className="resource-cell-description">{r.relative_uri || '—'}</div></Tooltip>
        <div className="resource-cell-meta">{{ table: '表格', file: '文件', text: '文本', image: '图片', other: '其他' }[r.data_type as string] || r.data_type || '—'}{r.data_type === 'table' && ` · ${r.data_items?.length ?? 0} 个信息项`}</div>
      </div> },
      { title: '归属与安全', key: 'owner', width: 190, render: (_: any, r: any) => <div className="resource-cell">
        <Tooltip title={r.resource_owner_name}><div className="resource-cell-primary">{r.resource_owner_name || '—'}</div></Tooltip>
        <div className="resource-cell-description">{industries.find(x => x.value === r.industry_code)?.label.slice(2) || r.industry_code || '—'}</div>
        <Tag color={r.security_level === 'important' ? 'red' : 'default'}>{SECURITY_LABELS[r.security_level] || r.security_level || '未分级'}</Tag>
      </div> },
      { title: '更新信息', key: 'update', width: 150, sorter: (a: any, b: any) => (Date.parse(a.updated_at) || 0) - (Date.parse(b.updated_at) || 0), render: (_: any, r: any) => <div className="resource-cell">
        <div className="resource-cell-primary">{r.update_frequency || '—'}</div>
        <div className="resource-cell-description">{r.update_method || '未指定更新方式'}{r.version_no && ` · ${r.version_no}`}</div>
        <span className="resource-cell-meta">更新于 {resourceDate(r.updated_at)}</span>
      </div> },
      { title: '上架状态', key: 'status', width: 160, render: (_: any, r: any) => <div className="resource-cell">
        <Tag color={RESOURCE_STATES[r.status]?.color || 'default'}>{RESOURCE_STATES[r.status]?.label || r.status || '未知状态'}</Tag>
        {r.review_comment && <Tooltip title={r.review_comment}><div className="resource-review-comment">审核意见：{r.review_comment}</div></Tooltip>}
      </div> },
      { title: '操作', key: 'actions', width: 140, fixed: 'right' as const, render: (_: any, r: any) => <div className="resource-row-actions">
        {['registered', 'rejected'].includes(r.status) && <><Button size="small" type="link" icon={<EditOutlined />} onClick={() => edit(r)}>编辑</Button><Button size="small" type="link" icon={<UploadOutlined />} loading={publish.isPending && publish.variables === r.id} onClick={() => publish.mutate(r.id)}>申请上架</Button></>}
        <Popconfirm title="确认删除此资源？" description="删除后，该资源将从列表中移除。" onConfirm={() => remove.mutateAsync(r.id)} okText="删除" cancelText="取消"><Button size="small" danger type="text" icon={<DeleteOutlined />} loading={remove.isPending && remove.variables === r.id}>删除</Button></Popconfirm>
      </div> },
    ]} />
    <Modal className="resource-registration" title={<div className="resource-registration-title"><span>{editing ? '编辑数据资源' : '登记数据资源'}</span><p>完善资源信息，建立可发现、可使用的数据资源目录。</p></div>} open={open} width={1240} style={{ top: 28 }} onCancel={close} onOk={() => form.submit()} okText={editing ? '保存修改' : '登记资源'} cancelText="取消" confirmLoading={mutation.isPending} destroyOnClose>
      <div className="resource-registration-layout">
        <aside className="resource-registration-nav" aria-label="登记信息目录">
          <div className="resource-nav-label">登记信息</div>
          {[['basic', '基本信息'], ['source', '数据来源与结构'], ['owner', '资源持有方'], ['security', '安全与更新']].map(([id, title]) => <button type="button" key={id} onClick={() => document.getElementById(`resource-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{title}</button>)}
          <div className="resource-nav-note">标有 <span>*</span> 的为必填项<br />登记后仅自己可见，可在资源列表申请上架。</div>
        </aside>
      <Form className="resource-registration-form" form={form} layout="vertical" scrollToFirstError initialValues={initial} onFinish={(v) => mutation.mutate({ ...v, data_items: v.data_type === 'table' ? (v.data_items || []) : [], data_modalities: String(v.data_modalities || '').split(',').map((x: string) => x.trim()).filter(Boolean) })}>
        <section id="resource-basic" className="resource-form-section" aria-labelledby="resource-basic-title">
          <div className="resource-section-heading"><h3 id="resource-basic-title">基本信息</h3><p>清晰描述资源内容，便于识别与检索。</p></div>
        <Form.Item name="resource_name" label="资源名称" rules={[{ required: true }]}><Input placeholder="请输入易于识别的资源名称" /></Form.Item><Form.Item name="resource_abstract" label="资源摘要" rules={[{ required: true }]}><Input.TextArea rows={3} placeholder="描述资源的主要内容、覆盖范围和使用价值" /></Form.Item>
        <div className="resource-field-grid"><Form.Item name="industry_code" label="行业分类" rules={[{ required: true }]}><Select showSearch options={industries} /></Form.Item><Form.Item name="theme_code" label="政务主题分类"><Select allowClear showSearch options={themes} /></Form.Item><Form.Item name="resource_format" label="资源格式" rules={[{ required: true }]}><Select showSearch options={RESOURCE_FORMAT_OPTIONS} /></Form.Item><Form.Item name="data_type" label="资源形态" rules={[{ required: true }]}><Select options={[{ value: 'table', label: '表格' }, { value: 'file', label: '文件' }, { value: 'text', label: '文本' }, { value: 'image', label: '图片' }, { value: 'other', label: '其他' }]} /></Form.Item></div>
        </section>
        <section id="resource-source" className="resource-form-section" aria-labelledby="resource-source-title">
          <div className="resource-section-heading"><h3 id="resource-source-title">数据来源与结构</h3><p>关联已接入的数据源，选择数据对象并确认信息项。</p></div>
        <Form.Item name="object_ref" hidden><Input /></Form.Item>
        <div className="resource-field-grid">
          <Form.Item name="datasource_id" label="所属数据源" rules={[{ required: true }]}><Select options={(datasources.data || []).map((x: any) => ({ value: x.id, label: `${x.name} (${x.type})` }))} onChange={() => form.setFieldsValue({ object_ref: undefined, relative_uri: undefined, resource_format: undefined, data_items: [] })} /></Form.Item>
          <Form.Item label="数据对象"><Button disabled={!datasourceId} onClick={() => setCatalogOpen(true)}>浏览数据源</Button></Form.Item>
          <Form.Item name="relative_uri" label="数据源内 URI" rules={[{ required: true }]}><Input placeholder="选择对象或手动填写路径/表名" /></Form.Item>
        </div>
        <Form.Item name="data_modalities" label="数据模态（逗号分隔）"><Input /></Form.Item>
        {dataType === 'table' && <Form.Item label="信息项" required>
          <Form.List name="data_items" rules={[{ validator: async (_, rows) => { if (!rows?.length) throw new Error('表格类数据资源必须提供列定义') } }]}> 
            {(fields, { add, remove }, { errors }) => <Space direction="vertical" style={{ width: '100%' }}>
              {fields.map(field => <div key={field.key} className="resource-column-row">
                <Form.Item {...field} name={[field.name, 'name']} rules={[{ required: true, message: '请输入列名' }]}><Input placeholder="列名" /></Form.Item>
                <Form.Item {...field} name={[field.name, 'type']} rules={[{ required: true, message: '请选择类型' }]}><Select showSearch options={COLUMN_TYPE_OPTIONS} /></Form.Item>
                <Form.Item {...field} name={[field.name, 'comment']}><Input placeholder="说明" /></Form.Item>
                <Button type="text" danger icon={<MinusCircleOutlined />} aria-label="删除列" onClick={() => remove(field.name)} />
              </div>)}
              <Button type="dashed" icon={<PlusOutlined />} onClick={() => add({ type: 'string', comment: '' })}>添加列</Button>
              <Form.ErrorList errors={errors} />
            </Space>}
          </Form.List>
        </Form.Item>}
        </section>
        <section id="resource-owner" className="resource-form-section" aria-labelledby="resource-owner-title">
          <div className="resource-section-heading"><h3 id="resource-owner-title">资源持有方</h3><p>填写持有方及联系人信息，方便业务对接。</p></div>
        <div className="resource-field-grid"><Form.Item name="resource_owner_name" label="资源持有方" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="resource_owner_id" label="持有方标识码" rules={[{ required: true }]}><Input /></Form.Item></div><div className="resource-field-grid"><Form.Item name="contact_name" label="联系人" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="contact_information" label="联系方式" rules={[{ required: true }]}><Input /></Form.Item></div>
        </section>
        <section id="resource-security" className="resource-form-section" aria-labelledby="resource-security-title">
          <div className="resource-section-heading"><h3 id="resource-security-title">安全与更新</h3><p>说明数据分级、取得方式与更新规则。</p></div>
        <div className="resource-field-grid"><Form.Item name="security_level" label="数据安全级别" rules={[{ required: true }]}><Select options={[{ value: 'general_1', label: '一般数据一级' }, { value: 'general_2', label: '一般数据二级' }, { value: 'important', label: '重要数据' }]} /></Form.Item><Form.Item name="personal_information_level" label="个人信息" rules={[{ required: true }]}><Select options={[{ value: '0', label: '0 不涉及' }, { value: '1', label: '1 一般个人信息' }, { value: '2', label: '2 敏感个人信息' }]} /></Form.Item><Form.Item name="data_source_type" label="数据来源" rules={[{ required: true }]}><Select options={[{ value: '01', label: '01 原始取得' }, { value: '02', label: '02 收集取得' }, { value: '03', label: '03 交易取得' }, { value: '04', label: '04 共享取得' }, { value: '05', label: '05 其他' }]} /></Form.Item></div>
        <div className="resource-field-grid"><Form.Item name="update_frequency" label="更新频率" rules={[{ required: true }]}><Select options={UPDATE_FREQUENCY_OPTIONS} /></Form.Item><Form.Item name="update_method" label="更新方式"><Select allowClear options={[{ value: '全量', label: '全量' }, { value: '增量', label: '增量' }]} /></Form.Item><Form.Item name="version_no" label="版本号"><Input placeholder="V1.0" /></Form.Item></div>
        </section>
      </Form>
      </div>
    </Modal>
    <CatalogPicker open={catalogOpen} datasourceId={datasourceId} onClose={() => setCatalogOpen(false)} onSelect={(item, inspection) => form.setFieldsValue({
      object_ref: item.object_ref,
      relative_uri: item.path,
      resource_format: String(inspection?.format || item.format || 'binary').toUpperCase(),
      data_items: inspection?.columns.map(column => ({ name: column.name, type: column.type, comment: '' })) || [],
      data_type: (inspection?.data_kind || item.data_kind) === 'structured' ? 'table' : 'file',
      data_modalities: (inspection?.data_kind || item.data_kind) === 'structured' ? '结构化' : '非结构化',
    })} />
  </Card>
}
