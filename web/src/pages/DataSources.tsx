import { Fragment } from 'react'
import {
  Card, Table, Tag, Button, Space, Modal, Form, Input, Select, message,
  Popconfirm, Row, Col, Switch, Alert, Typography,
} from 'antd'
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  DataSourceItem, listDatasources, createDatasource, deleteDatasource,
} from '../api/portal'

const { Text } = Typography

const TYPE_LABEL: Record<string, string> = { localfs: '本地文件系统', oss: '对象存储(s3)' }
const TYPE_COLOR: Record<string, string> = { localfs: 'blue', oss: 'geekblue' }

export default function DataSources() {
  const qc = useQueryClient()
  const [form] = Form.useForm()
  const [open, setOpen] = useState(false)
  const dsType = Form.useWatch('type', form)

  const list = useQuery({ queryKey: ['portal-datasources'], queryFn: listDatasources })

  const createMut = useMutation({
    mutationFn: createDatasource,
    onSuccess: () => {
      message.success('数据源创建成功（已在本地 Lite 创建 DomainDataSource，非密元数据已上报中心）')
      setOpen(false)
      form.resetFields()
      qc.invalidateQueries({ queryKey: ['portal-datasources'] })
    },
    onError: (e: any) => message.error(e.response?.data?.message ?? e.response?.data?.detail ?? '创建失败'),
  })

  const delMut = useMutation({
    mutationFn: (r: DataSourceItem) => deleteDatasource(r.id, r.kuscia_datasource_id),
    onSuccess: () => {
      message.success('已删除')
      qc.invalidateQueries({ queryKey: ['portal-datasources'] })
    },
    onError: (e: any) => message.error(e.response?.data?.message ?? e.response?.data?.detail ?? '删除失败'),
  })

  const onFinish = (v: any) => {
    const body =
      v.type === 'localfs'
        ? { name: v.name, type: 'localfs' as const, uri: v.path, info: { path: v.path } }
        : {
            name: v.name,
            type: 'oss' as const,
            access_directly: !!v.access_directly,
            info: {
              endpoint: v.endpoint,
              bucket: v.bucket,
              prefix: v.prefix || '',
              access_key_id: v.access_key_id,
              access_key_secret: v.access_key_secret,
              storage_type: v.storage_type || '',
              virtualhost: !!v.virtualhost,
            },
          }
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
      title: 'Kuscia 数据源 ID',
      dataIndex: 'kuscia_datasource_id',
      render: (v: string) => <Text code style={{ fontSize: 12 }}>{v}</Text>,
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
        <Popconfirm
          title="删除该数据源？将同步删除本地 Lite 的 DomainDataSource 并注销中心记录。"
          onConfirm={() => delMut.mutate(r)}
        >
          <Button type="link" size="small" danger>删除</Button>
        </Popconfirm>
      ),
    },
  ]

  return (
    <Card
      title="数据源配置"
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => list.refetch()}>刷新</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
            新建数据源
          </Button>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="数据源在本连接器本地 Lite 创建，密钥仅存本地，仅非密元数据上报中心供目录/产品引用。"
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
                <Select
                  options={[
                    { value: 'localfs', label: '本地文件系统 (localfs)' },
                    { value: 'oss', label: '对象存储 (oss / s3)' },
                  ]}
                />
              </Form.Item>
            </Col>
          </Row>

          {dsType === 'localfs' && (
            <Form.Item
              name="path"
              label="节点内路径"
              rules={[{ required: true }]}
              extra="连接器(Lite)节点本地路径，数据不出域。"
            >
              <Input placeholder="/home/kuscia/var/storage/data" />
            </Form.Item>
          )}

          {dsType === 'oss' && (
            <Fragment>
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message="s3/数据库类数据源计算时经 DataProxy 读取，需该连接器已启用 DataProxy。"
              />
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item name="endpoint" label="Endpoint" rules={[{ required: true }]}>
                    <Input placeholder="https://oss-cn-x.example.com" />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item name="bucket" label="Bucket" rules={[{ required: true }]}>
                    <Input />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item name="prefix" label="Prefix">
                    <Input placeholder="data/" />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={12}>
                <Col span={8}>
                  <Form.Item name="access_key_id" label="AccessKeyId" rules={[{ required: true }]}>
                    <Input placeholder="密钥仅存本地" />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="access_key_secret" label="AccessKeySecret" rules={[{ required: true }]}>
                    <Input.Password placeholder="密钥仅存本地" />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="storage_type" label="StorageType">
                    <Input placeholder="minio / oss / ..." />
                  </Form.Item>
                </Col>
              </Row>
              <Space size="large">
                <Form.Item name="virtualhost" label="Virtualhost" valuePropName="checked">
                  <Switch />
                </Form.Item>
                <Form.Item name="access_directly" label="直连(access_directly)" valuePropName="checked">
                  <Switch />
                </Form.Item>
              </Space>
            </Fragment>
          )}
        </Form>
      </Modal>
    </Card>
  )
}
