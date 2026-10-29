import {
  Table, Tag, Button, Space, Modal, Form, Input, Select, message,
  Popconfirm, Row, Col, Alert, Typography,
} from 'antd'
import { PlusOutlined, ReloadOutlined, ApiOutlined, InfoCircleOutlined } from '@ant-design/icons'
import { WorkspaceHeader, MetricStrip, SectionCard } from '../components/ResourceWorkspace'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  DataSourceItem, listDatasources, createDatasource, deleteDatasource, probeDatasource, getDatasourceDetails,
} from '../api/portal'

const { Text } = Typography

const TYPE_LABEL: Record<string, string> = { localfs: '本地文件系统', oss: '对象存储(s3)', jdbc: '数据库(JDBC)', sftp: 'SFTP 文件', ftp: 'FTP 文件' }
const TYPE_COLOR: Record<string, string> = { localfs: 'blue', oss: 'geekblue', jdbc: 'purple', sftp: 'cyan', ftp: 'green' }

export default function DataSources() {
  const qc = useQueryClient()
  const [form] = Form.useForm()
  const [open, setOpen] = useState(false)
  const [details, setDetails] = useState<Record<string, unknown> | null>(null)
  const datasourceType = Form.useWatch('type', form)

  const list = useQuery({ queryKey: ['portal-datasources'], queryFn: listDatasources })

  const createMut = useMutation({
    mutationFn: createDatasource,
    onSuccess: () => {
      message.success('数据源已登记，非密元数据已上报中心')
      setOpen(false)
      form.resetFields()
      qc.invalidateQueries({ queryKey: ['portal-datasources'] })
    },
    onError: (e: any) => message.error(e.response?.data?.message ?? e.response?.data?.detail ?? '创建失败'),
  })

  const delMut = useMutation({
    mutationFn: (r: DataSourceItem) => deleteDatasource(r.id),
    onSuccess: () => {
      message.success('已删除')
      qc.invalidateQueries({ queryKey: ['portal-datasources'] })
    },
    onError: (e: any) => message.error(e.response?.data?.message ?? e.response?.data?.detail ?? '删除失败'),
  })

  const probeMut = useMutation({
    mutationFn: (r: DataSourceItem) => probeDatasource(r.id),
    onSuccess: (result) => message[result.status === 'available' ? 'success' : 'warning'](result.message + (result.object_count_hint ? `；${result.object_count_hint}` : '')),
    onError: (e: any) => message.error(e.response?.data?.message ?? e.response?.data?.detail ?? '探活失败'),
  })

  const showDetails = async (r: DataSourceItem) => {
    try { setDetails(await getDatasourceDetails(r.id)) }
    catch (e: any) { message.error(e.response?.data?.message ?? e.response?.data?.detail ?? '获取详情失败') }
  }

  const onFinish = (v: any) => {
    const body = v.type === 'localfs'
      // LFS is bound to the Portal's configured STORAGE_ROOT. Do not send
      // the container's generic /data path here: the server derives the
      // controlled root and rejects arbitrary paths by design.
      ? { name: v.name, type: 'localfs' as const, info: {} }
      : v.type === 'sftp'
        ? { name: v.name, type: 'sftp' as const, info: { seatunnel_plugin: 'SftpFile', path: v.path, options: { host: v.host, port: Number(v.port || 22), user: v.user, password: v.password } } }
      : v.type === 'ftp'
        ? { name: v.name, type: 'ftp' as const, info: { seatunnel_plugin: 'FtpFile', path: v.path, options: { host: v.host, port: Number(v.port || 21), user: v.user, password: v.password } } }
      : v.type === 'jdbc'
        ? { name: v.name, type: 'jdbc' as const, uri: 'connector://jdbc', info: {
            seatunnel_plugin: 'Jdbc', options: { url: v.url, driver: v.driver, user: v.user, password: v.password },
          } }
        : { name: v.name, type: 'oss' as const, access_directly: !!v.access_directly, info: {
            endpoint: v.endpoint, bucket: v.bucket, prefix: v.prefix || '', access_key_id: v.access_key_id,
            access_key_secret: v.access_key_secret, storage_type: v.storage_type || '', virtualhost: !!v.virtualhost,
          } }
    createMut.mutate(body)
  }

  const columns = [
    { title: '名称', dataIndex: 'name' },
    {
      title: '类型',
      dataIndex: 'type',
      render: (v: string) => <Tag color={TYPE_COLOR[v]}>{TYPE_LABEL[v] ?? v}</Tag>,
    },
    {
      title: '连接器资源引用',
      dataIndex: 'external_source_ref',
      render: (v: string) => <Text code style={{ fontSize: 12 }}>{v || '—'}</Text>,
    },
    {
      title: 'URI',
      dataIndex: 'uri',
      render: (v: string | null) => <Text style={{ fontSize: 12 }}>{v || '—'}</Text>,
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, r: DataSourceItem) => (
        <Space size="small">
          <Button type="link" size="small" icon={<ApiOutlined />} disabled={['jdbc', 'sftp'].includes(r.type)} title={['jdbc', 'sftp'].includes(r.type) ? '请通过数据传输任务验证源文件或查询能否读取' : r.type === 'ftp' ? '只验证 FTP 控制通道登录；被动端口是否放行由实际搬运作业验证' : undefined} loading={probeMut.isPending && probeMut.variables?.id === r.id} onClick={() => probeMut.mutate(r)}>探活</Button>
          <Button type="link" size="small" icon={<InfoCircleOutlined />} onClick={() => showDetails(r)}>详情</Button>
          <Popconfirm title="删除该数据源并注销中心目录记录？" onConfirm={() => delMut.mutate(r)}><Button type="link" size="small" danger>删除</Button></Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div className="workspace-page resource-page-sources">
    <WorkspaceHeader kicker="数据目录 / SOURCES" title="数据源" description="管理连接器能够访问的本地文件、数据库和对象存储。凭据只保存在当前连接器。" icon={<ApiOutlined />} action={<Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>登记数据源</Button>} />
    <MetricStrip items={[{ label: '已登记数据源', value: list.data?.length ?? 0, hint: '本地目录' }, { label: '可用连接', value: list.data?.length ?? 0, hint: '等待探活', tone: 'success' }, { label: '支持浏览', value: list.data?.filter(x => x.type !== 'jdbc').length ?? 0, hint: '文件与对象', tone: 'warning' }]} />
    <SectionCard title="数据源目录" description="选择数据源浏览对象、探测结构或执行连接验证" action={<Space><Button icon={<ReloadOutlined />} onClick={() => list.refetch()}>刷新</Button></Space>}>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="数据源由连接器本地登记，访问凭据仅保留在连接器侧，仅非密元数据上报中心供目录与数据产品引用。"
      />

      <Table
        rowKey="id"
        loading={list.isLoading}
        dataSource={list.data ?? []}
        columns={columns}
        pagination={{ pageSize: 10 }}
      />

      <Modal
        title="新建数据源"
        open={open}
        width={720}
        onOk={() => form.submit()}
        onCancel={() => setOpen(false)}
        confirmLoading={createMut.isPending}
        destroyOnClose
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={onFinish}
          preserve={false}
          initialValues={{ type: 'localfs', access_directly: true, virtualhost: false }}
        >
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="name" label="数据源名称" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="type" label="类型" rules={[{ required: true }]}>
                <Select options={[
                  { value: 'localfs', label: '连接器本地文件 (LFS)' },
                  { value: 'oss', label: '对象存储 (OSS/S3)' },
                  { value: 'jdbc', label: '数据库 (JDBC)' },
                  { value: 'sftp', label: 'SFTP 文件' },
                  { value: 'ftp', label: 'FTP 文件' },
                ]} />
              </Form.Item>
            </Col>
          </Row>

          {datasourceType === 'ftp' ? <>
            <Row gutter={12}><Col span={16}><Form.Item name="host" label="FTP 主机" rules={[{ required: true }]}><Input placeholder="10.26.174.75" /></Form.Item></Col><Col span={8}><Form.Item name="port" label="控制端口" initialValue={21}><Input type="number" min={1} max={65535} /></Form.Item></Col></Row>
            <Form.Item name="path" label="源目录（FTP 服务端绝对路径）" rules={[{ required: true }]} extra="抽取按服务端根解析，不是登录后的相对目录。账号家目录为 /ftp/bonfire 时这里填 /ftp/bonfire。"><Input placeholder="/ftp/bonfire" /></Form.Item>
            <Row gutter={12}><Col span={12}><Form.Item name="user" label="用户名" rules={[{ required: true }]}><Input autoComplete="off" /></Form.Item></Col><Col span={12}><Form.Item name="password" label="密码" rules={[{ required: true }]}><Input.Password autoComplete="new-password" /></Form.Item></Col></Row>
            <Alert type="info" showIcon message="用户侧 FTP 服务（由用户自行部署），可作为搬运输入或输出。抽取使用被动模式，需放行其被动端口范围。Kuscia 节点内置 FTP 只接收、不提供下载，不能登记为此类型。" />
          </> : datasourceType === 'sftp' ? <>
            <Row gutter={12}><Col span={16}><Form.Item name="host" label="SFTP 主机" rules={[{ required: true }]}><Input /></Form.Item></Col><Col span={8}><Form.Item name="port" label="端口" initialValue={22}><Input type="number" min={1} max={65535} /></Form.Item></Col></Row>
            <Form.Item name="path" label="源目录" rules={[{ required: true }]}><Input placeholder="/data" /></Form.Item>
            <Row gutter={12}><Col span={12}><Form.Item name="user" label="用户名" rules={[{ required: true }]}><Input autoComplete="off" /></Form.Item></Col><Col span={12}><Form.Item name="password" label="密码" rules={[{ required: true }]}><Input.Password autoComplete="new-password" /></Form.Item></Col></Row>
            <Alert type="info" showIcon message="填写抽取服务可访问的 SFTP 源地址。保存后到“数据传输”选择文件并验证读取；此类型暂不支持单独探活。" />
          </> : datasourceType === 'jdbc' ? <>
            <Row gutter={12}><Col span={12}><Form.Item name="url" label="JDBC URL" rules={[{ required: true }]}><Input placeholder="jdbc:postgresql://host:5432/db" /></Form.Item></Col>
              <Col span={12}><Form.Item name="driver" label="驱动类" rules={[{ required: true }]}><Input placeholder="org.postgresql.Driver" /></Form.Item></Col></Row>
            <Row gutter={12}><Col span={12}><Form.Item name="user" label="用户名" rules={[{ required: true }]}><Input autoComplete="off" /></Form.Item></Col>
              <Col span={12}><Form.Item name="password" label="密码" rules={[{ required: true }]}><Input.Password autoComplete="new-password" /></Form.Item></Col></Row>
            <Alert type="info" showIcon message="保存后可在数据资源或数据传输中浏览数据库并选择表或视图。" />
          </> : datasourceType === 'oss' ? <>
            <Row gutter={12}>
              <Col span={12}>
                <Form.Item name="endpoint" label="服务端点" rules={[{ required: true, message: '请输入 OSS/S3 服务端点' }]}>
                  <Input placeholder="例如 http://minio.example.com:9000" />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="bucket" label="Bucket" rules={[{ required: true, message: '请输入 Bucket' }]}>
                  <Input placeholder="例如 business-data" />
                </Form.Item>
              </Col>
            </Row>
            <Row gutter={12}>
              <Col span={12}>
                <Form.Item name="prefix" label="对象前缀">
                  <Input placeholder="例如 incoming/psi（可留空）" />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="storage_type" label="存储实现">
                  <Select allowClear placeholder="请选择或留空" options={[
                    { value: 's3', label: 'Amazon S3 / S3 兼容' },
                    { value: 'minio', label: 'MinIO' },
                    { value: 'oss', label: '阿里云 OSS' },
                  ]} />
                </Form.Item>
              </Col>
            </Row>
            <Row gutter={12}>
              <Col span={12}>
                <Form.Item name="access_key_id" label="Access Key" rules={[{ required: true, message: '请输入 Access Key' }]}>
                  <Input autoComplete="off" />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="access_key_secret" label="Secret Key" rules={[{ required: true, message: '请输入 Secret Key' }]}>
                  <Input.Password autoComplete="new-password" />
                </Form.Item>
              </Col>
            </Row>
            <Form.Item name="virtualhost" label="访问寻址方式">
              <Select options={[
                { value: false, label: 'Path Style（端点/Bucket/对象）' },
                { value: true, label: 'Virtual Host Style（Bucket.端点/对象）' },
              ]} />
            </Form.Item>
            <Alert type="info" showIcon message="访问凭据仅保存在当前连接器。执行项目时，连接器会自动调用本实例的 SeaTunnel，将所选对象抽取到作业暂存区。" />
          </> : <Alert type="info" showIcon message="LFS 是连接器 Portal 的受控本地文件目录。数据资源登记后，隐私计算作业会自动由本连接器的 SeaTunnel 抽取到作业暂存区。" />}
        </Form>
      </Modal>
      <Modal title="数据源详细配置" open={!!details} footer={null} onCancel={() => setDetails(null)}>
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>{details ? JSON.stringify(details, null, 2) : ''}</pre>
      </Modal>
    </SectionCard></div>
  )
}
