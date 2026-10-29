/**
 * 「数据传输」合并入口。
 *
 * 用户只回答：从哪来、哪些文件、到哪去。执行通道由**后端返回的 `via`** 决定
 * （输出 = Kuscia 节点 FTP → /extractions，其余 → /transfers），前端不按输出类型推断。
 * 两类任务的语义不合并：列表用 Tag 区分「计算输入 / 仅搬运」，成功文案分别是
 * 「可用于计算」和「已落盘」，清理只对接入任务开放。手动 FTP 上传保留为独立创建方式。
 */
import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Card, Col, Descriptions, Drawer, Form, Input, message, Modal, Popconfirm, Radio, Row, Segmented, Select, Space, Table, Tag, Tooltip, Typography } from 'antd'
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import BinaryFileSourceInput from './data-movement/BinaryFileSourceInput'
import DatabaseSourceInput from './data-movement/DatabaseSourceInput'
import StructuredFileSourceInput from './data-movement/StructuredFileSourceInput'
import StructuredTransformFields from './data-movement/StructuredTransformFields'
import {
  BinaryFileTransferPlan, cancelExtraction, cleanupExtraction, completeExtraction,
  createBinaryFileTransfer, createDatabaseTransfer, createStructuredFileTransfer,
  DatabaseTransferPlan, getExtraction, getTransfer,
  IngestionFile, IngestionTask, isIngestion, listMovements, Movement, prepareExtraction,
  prepareDatabaseExtraction, prepareStructuredFileExtraction,
  previewBinaryFileTransfer, previewDatabaseTransfer, previewStructuredFileTransfer,
  receivedFiles, runExtraction, runTransfer, SeaTunnelJobConfig, TransferPlan, TransferTask, transferForm,
  StructuredFileTransferPlan, TypedTransferPlan,
  uploadCredentials, UploadCredentials,
  ContentKind, FilterCondition, ScannedSchema, BrowseCapability,
  datasourceCapability, inspectDatabaseRelation, scanDatasourceFile,
} from '../api/portal'
const { Text, Paragraph } = Typography

// 接入任务状态：ready 才是「可用于计算」。
const INGEST_STATES: Record<string, string> = { queued: '待开始', 'creating-session': '准备上传', 'awaiting-upload': '等待上传', extracting: '抽取中', uploading: '上传中', validating: '校验中', committing: '提交中', staged: '已暂存', registering: '登记中', ready: '可用于计算', 'waiting-retry': '等待恢复', failed: '失败', cancelled: '已撤销', cleaned: '已清理' }
// 搬运任务状态：succeeded 只代表「已落盘」，绝不写成「可用于计算」。
const TRANSFER_STATES: Record<string, string> = { queued: '待开始', submitting: '提交中', running: '搬运中', succeeded: '已落盘', failed: '失败' }
const stateText = (task: Movement) => (isIngestion(task) ? INGEST_STATES : TRANSFER_STATES)[task.state] || task.state
const stateColor = (task: Movement) => task.state === 'ready' ? 'green' : task.state === 'succeeded' ? 'cyan'
  : ['failed', 'waiting-retry'].includes(task.state) ? 'red' : ['cancelled', 'cleaned'].includes(task.state) ? 'default' : 'blue'
const backendName = (v?: string) => v === 's3' ? '对象存储' : '节点目录'
const errorText = (e: any) => String(e.response?.data?.detail || e.message || '操作失败')
const bytes = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(2)} MiB` : `${n} B`
const outputKey = (o: { target: string; datasource_id?: string }) => o.datasource_id ? `datasource:${o.datasource_id}` : o.target
const planInputName = (plan: TransferPlan | TypedTransferPlan) => 'relation' in plan.input
  ? plan.input.relation : plan.input.files.join('、')

function typeTag(task: Movement) {
  if (!isIngestion(task)) return <Tag color="default">仅搬运</Tag>
  return <Space size={4}><Tag color="blue">计算输入</Tag>{task.mode === 'manual' && <Tag>手动上传</Tag>}</Space>
}

export default function DataMovement() {
  const qc = useQueryClient(), [form] = Form.useForm()
  const [filter, setFilter] = useState<'all' | 'extractions' | 'transfers'>('all')
  const [creating, setCreating] = useState(false), [busy, setBusy] = useState(false)
  const [requestKey, setRequestKey] = useState(''), [selected, setSelected] = useState<Movement>()
  const [credentials, setCredentials] = useState<UploadCredentials>()
  const [received, setReceived] = useState<IngestionFile[]>()
  const [preview, setPreview] = useState<{ channel: string; registers: boolean; config: SeaTunnelJobConfig }>()
  // 自动化相关状态：数据形态、选中的文件、扫描结果与筛选条件。
  const [contentKind, setContentKind] = useState<ContentKind>('structured')
  const [inputFormat, setInputFormat] = useState('csv')
  const [outputFormat, setOutputFormat] = useState('csv')
  const [pickedFiles, setPickedFiles] = useState<string[]>([])
  const [databaseObjectRef, setDatabaseObjectRef] = useState<string>()
  const [capability, setCapability] = useState<BrowseCapability>()
  const [schema, setSchema] = useState<ScannedSchema>()
  const [scanning, setScanning] = useState(false)
  const [fields, setFields] = useState<string[]>([])
  const [conditions, setConditions] = useState<FilterCondition[]>([])
  const [previewRows, setPreviewRows] = useState(20)
  const method = Form.useWatch('method', form), chosenOutput = Form.useWatch('output', form)
  const chosenSource = Form.useWatch('datasource_id', form)

  // 选定数据源后立即问后端能否浏览/扫描：能就给选择器，不能就保留手填并说明原因。
  useEffect(() => {
    setPickedFiles([]); setDatabaseObjectRef(undefined); setSchema(undefined); setFields([]); setConditions([]); setCapability(undefined)
    setInputFormat('csv'); setOutputFormat('csv')
    if (!chosenSource) return
    let cancelled = false
    datasourceCapability(chosenSource)
      .then(result => { if (!cancelled) setCapability(result) })
      .catch(() => { if (!cancelled) setCapability({ datasource_id: chosenSource, type: '', listing: false, scanning: false,
        reason: '无法获取该数据源的浏览能力，请手填路径与列定义' }) })
    return () => { cancelled = true }
  }, [chosenSource])
  // 换文件后旧的字段结构不再适用，必须重扫，否则会用错列定义。
  useEffect(() => { setSchema(undefined); setFields([]); setConditions([]) }, [pickedFiles.join('|')])

  const meta = useQuery({ queryKey: ['movement-form'], queryFn: transferForm, retry: false })
  const sourceType = meta.data?.inputs.find(item => item.id === chosenSource)?.type
  const databaseTypes = meta.data?.input_modes?.database?.source_types || ['jdbc']
  const isDatabaseSource = !!sourceType && databaseTypes.some(type => type.toLowerCase() === sourceType.toLowerCase())
  useEffect(() => { if (isDatabaseSource) setContentKind('structured') }, [isDatabaseSource])
  const tasks = useQuery({ queryKey: ['movements', filter], queryFn: () => listMovements(filter), refetchInterval: 5000 })
  const detail = useQuery({
    queryKey: ['movement', selected?.id, selected?.channel],
    queryFn: (): Promise<Movement> => selected && isIngestion(selected) ? getExtraction(selected.id) : getTransfer(selected!.id),
    enabled: !!selected, refetchInterval: selected ? 3000 : false,
  })
  const task = (detail.data as Movement | undefined) ?? selected
  const outputs = meta.data?.outputs || []
  const excluded = meta.data?.excluded_outputs || []
  const output = useMemo(() => outputs.find(o => outputKey(o) === chosenOutput), [outputs, chosenOutput])
  useEffect(() => {
    if (!isDatabaseSource && contentKind === 'unstructured' && output?.via === 'extractions') form.setFieldValue('output', 'staging-dir')
  }, [isDatabaseSource, contentKind, output?.via])
  // 通道与产出完全来自后端的 via/registers_compute_input。
  const channel = method === 'manual' ? 'extractions' : output?.via
  const registers = method === 'manual' ? true : output?.registers_compute_input

  const refresh = () => { void qc.invalidateQueries({ queryKey: ['movements'] }); void qc.invalidateQueries({ queryKey: ['movement'] }) }
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true)
    try { await fn(); if (ok) message.success(ok); refresh() }
    catch (e) { message.error(errorText(e)) }
    finally { setBusy(false) }
  }
  const open = () => {
    form.resetFields()
    // 自动化状态不在 Form 里，需显式重置，否则上一次的文件/扫描结果会串到新任务
    setContentKind('structured'); setInputFormat('csv'); setOutputFormat('csv'); setPickedFiles([]); setDatabaseObjectRef(undefined); setCapability(undefined)
    setSchema(undefined); setFields([]); setConditions([]); setPreviewRows(20)
    form.setFieldsValue({ method: 'source', output: 'compute-input', staging_backend: meta.data?.compute_input.backend || 'directory',
      resource_version: '1', files: [{ path: '' }], columns: [{ name: 'id', type: 'string' }] })
    // LAN HTTP 源下 randomUUID 不可用。
    setRequestKey(Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join(''))
    setCreating(true)
  }
  const scan = async () => {
    if (!chosenSource || !pickedFiles.length) { message.warning(isDatabaseSource ? '请先选择数据库表或视图' : '请先选择数据源与文件'); return }
    setScanning(true)
    try {
      const result = isDatabaseSource
        ? await inspectDatabaseRelation(chosenSource, databaseObjectRef || '', previewRows)
        : await scanDatasourceFile(chosenSource, pickedFiles[0], previewRows)
      setSchema(result)
      if (result.format) {
        setInputFormat(result.format)
        if (channel !== 'extractions' && result.format !== 'table') setOutputFormat(result.format)
      }
      // 扫描出的字段直接回填列定义，用户不必再手敲
      form.setFieldValue('columns', result.columns.map(c => ({ name: c.name,
        type: c.kind === 'enum' || c.kind === 'unknown' ? 'string' : c.kind })))
      message.success(`已识别 ${result.columns.length} 个字段`)
    } catch (e) { message.error(errorText(e)) }
    finally { setScanning(false) }
  }
  const filePaths = (value: any): string[] => pickedFiles.length ? pickedFiles
    : (value.files || []).map((f: any) => String(f?.path || '').trim()).filter(Boolean)
  const outputPlan = (value: any, format: string) => ({
    target: (output?.target || 'staging-dir') as 'staging-dir' | 'datasource',
    datasource_id: output?.datasource_id, path: value.output_path || undefined, format: format as any,
  })
  const filterPlan = () => (fields.length || conditions.length)
    ? { fields: fields.length ? fields : undefined, conditions: conditions.length ? conditions : undefined }
    : undefined
  const databasePlan = (value: any): DatabaseTransferPlan => ({
    plan_kind: 'database', input: { datasource_id: value.datasource_id, relation: pickedFiles[0] },
    output: outputPlan(value, outputFormat), columns: value.columns,
    output_format: outputFormat as DatabaseTransferPlan['output_format'], filter: filterPlan(),
  })
  const structuredFilePlan = (value: any): StructuredFileTransferPlan => ({
    plan_kind: 'structured-file', input: { datasource_id: value.datasource_id, files: filePaths(value) },
    output: outputPlan(value, outputFormat), columns: value.columns,
    input_format: inputFormat as StructuredFileTransferPlan['input_format'],
    output_format: outputFormat as StructuredFileTransferPlan['output_format'], filter: filterPlan(),
  })
  const binaryFilePlan = (value: any): BinaryFileTransferPlan => ({
    plan_kind: 'binary-file', input: { datasource_id: value.datasource_id, files: filePaths(value) },
    output: outputPlan(value, 'binary'),
  })
  const showPreview = async () => {
    try {
      const value = await form.validateFields()
      if (channel !== 'transfers') {
        // 接入通道的配置由节点会话凭据决定，只能在任务执行时生成，不做预览。
        setPreview({ channel: 'extractions', registers: true, config: { env: {}, source: [], sink: [] } })
        return
      }
      const result = isDatabaseSource
        ? await previewDatabaseTransfer(databasePlan(value))
        : contentKind === 'structured'
          ? await previewStructuredFileTransfer(structuredFilePlan(value))
          : await previewBinaryFileTransfer(binaryFilePlan(value))
      setPreview({ channel: result.channel, registers: result.registers_compute_input, config: result.config })
    } catch (e: any) { if (!e?.errorFields) message.error(errorText(e)) }
  }
  const submit = (value: any) => act(async () => {
    if (value.method !== 'manual' && !filePaths(value).length) throw new Error(isDatabaseSource ? '请选择数据库表或视图' : '请选择需要搬运的文件')
    if (channel === 'extractions') {
      if (contentKind === 'unstructured' && value.method !== 'manual') throw new Error('非结构化文件不能进入当前 CSV 型计算输入入口')
      const common = { request_key: requestKey, resource_ref: value.resource_ref,
        resource_version: value.resource_version, staging_backend: value.staging_backend,
        columns: value.columns, filter: filterPlan() }
      const created = value.method === 'manual'
        ? await prepareExtraction({ ...common, mode: 'manual', input_format: 'csv', output_format: 'csv', format: 'csv' })
        : isDatabaseSource
          ? await prepareDatabaseExtraction({ ...common, input: { datasource_id: value.datasource_id, relation: pickedFiles[0] } })
          : await prepareStructuredFileExtraction({ ...common,
              input: { datasource_id: value.datasource_id, files: filePaths(value) },
              input_format: inputFormat as StructuredFileTransferPlan['input_format'] })
      setCreating(false); setReceived(undefined)
      setSelected({ ...(created as unknown as IngestionTask), channel: 'extractions', registers_compute_input: true })
      if (value.method === 'manual') setCredentials(await uploadCredentials(created.extraction_id))
      else await runExtraction(created.extraction_id)
      return
    }
    const created = isDatabaseSource
      ? await createDatabaseTransfer({ ...databasePlan(value), request_key: requestKey })
      : contentKind === 'structured'
        ? await createStructuredFileTransfer({ ...structuredFilePlan(value), request_key: requestKey })
        : await createBinaryFileTransfer({ ...binaryFilePlan(value), request_key: requestKey })
    setCreating(false); setSelected(created)
  }, method === 'manual' ? '上传任务已创建，请获取凭据后上传' : registers ? '接入任务已开始' : '搬运任务已提交')

  const ingest = task && isIngestion(task) ? task : undefined
  const transfer = task && !isIngestion(task) ? task as TransferTask : undefined
  const files = ingest ? (ingest.batch?.files ?? received ?? ingest.received_files ?? []) : []
  const canConfirm = ingest?.mode === 'manual' && ['queued', 'awaiting-upload'].includes(ingest.state)
  const fileColumns = [{ title: '文件', dataIndex: 'path' }, { title: '大小', dataIndex: 'size', render: bytes },
    { title: '行数', dataIndex: 'rows', render: (v?: number) => v ?? '待校验' },
    { title: 'SHA-256', dataIndex: 'sha256', render: (v: string) => <Text code copyable style={{ fontSize: 11 }}>{v}</Text> }]

  return <div className="resource-page resource-page-movement"><div className="resource-page-intro"><div><div className="resource-kicker">数据目录 · PIPELINES</div><Typography.Title level={2}>数据传输</Typography.Title><Typography.Paragraph>把数据送入计算节点，或在数据源之间安全搬运文件。</Typography.Paragraph></div><div className="resource-intro-mark"><ReloadOutlined /></div></div><Space direction="vertical" size={16} style={{ width: '100%' }}>
    <Alert type="info" showIcon message="数据传输：把数据送进计算节点，或在数据源之间搬运文件"
      description="只需选择输入数据源、需要搬运的文件和输出目标。输出为 Kuscia 节点 FTP 时会经受控入口校验并登记为计算输入；输出为 staging 目录或对象存储时只搬运文件，不产生计算资源。" />
    {meta.isError && <Alert type="error" showIcon message="无法读取传输配置项" description={errorText(meta.error)} action={<Button onClick={() => meta.refetch()}>重试</Button>} />}
    {tasks.isError && <Alert type="error" showIcon message="无法读取传输任务" description={errorText(tasks.error)} />}
    {meta.data && !meta.data.node_available && <Alert type="warning" showIcon message="目标节点接入能力暂不可用"
      description="当前只能创建“仅搬运”任务；输出为 Kuscia 节点 FTP 的接入任务需要节点恢复后再创建。" />}
    <Card title="数据传输任务" extra={<Space>
      <Segmented value={filter} onChange={v => setFilter(v as typeof filter)} options={[{ label: '全部', value: 'all' }, { label: '计算输入', value: 'extractions' }, { label: '仅搬运', value: 'transfers' }]} />
      <Button icon={<ReloadOutlined />} onClick={refresh}>刷新</Button>
      <Button type="primary" icon={<PlusOutlined />} disabled={!meta.data} onClick={open}>新建任务</Button></Space>}>
      {meta.data && <Paragraph type="secondary">目标节点：{meta.data.node} · 引擎受控入口：{meta.data.compute_input.host}:{meta.data.compute_input.port} · staging 目录：<Text code>{meta.data.staging_dir}</Text></Paragraph>}
      <Table rowKey="id" loading={tasks.isLoading} dataSource={tasks.data || []} scroll={{ x: 980 }} columns={[
        { title: '类型', render: (_: unknown, r: Movement) => typeTag(r) },
        { title: '输入', render: (_: unknown, r: Movement) => isIngestion(r) ? (r.mode === 'manual' ? 'FTP 客户端上传' : r.resource_ref)
          : meta.data?.inputs.find(x => x.id === r.plan.input.datasource_id)?.name || r.plan.input.datasource_id },
        { title: '数据对象', render: (_: unknown, r: Movement) => isIngestion(r) ? (r.received_files || []).map(f => f.path).join('、') || '—' : planInputName(r.plan) },
        { title: '输出', render: (_: unknown, r: Movement) => isIngestion(r) ? `Kuscia 节点 FTP（${backendName(r.backend)}）`
          : outputs.find(o => outputKey(o) === outputKey(r.plan.output))?.label || r.plan.output.target },
        { title: '状态', render: (_: unknown, r: Movement) => <Tag color={stateColor(r)}>{stateText(r)}</Tag> },
        { title: '创建时间', dataIndex: 'created_at', render: (v: string) => new Date(v).toLocaleString() },
        { title: '操作', render: (_: unknown, r: Movement) => <Button type="link" onClick={() => { setSelected(r); setReceived(undefined) }}>查看详情</Button> },
      ]} />
    </Card>

    <Modal title="新建数据传输" open={creating} width={780} onCancel={() => setCreating(false)} destroyOnClose
      footer={<Space><Button onClick={() => setCreating(false)}>取消</Button>
        <Button onClick={showPreview} disabled={channel !== 'transfers'}>预览生成的配置</Button>
        <Button type="primary" loading={busy} onClick={() => form.submit()}>提交</Button></Space>}>
      <Form form={form} layout="vertical" onFinish={submit} preserve={false}>
        <Form.Item name="method" label="创建方式" rules={[{ required: true }]}>
          <Radio.Group options={[{ value: 'source', label: '从数据源抽取' }, { value: 'manual', label: 'FTP 客户端上传' }]} optionType="button" />
        </Form.Item>
        {method === 'manual'
          ? <Alert style={{ marginBottom: 16 }} type="info" showIcon message="手动上传只写入 Kuscia 节点受控入口"
              description="创建后获取一次性 FTP 凭据，自行上传当前受控入口支持的 CSV 文件，再核对文件并确认完成；确认后才校验、提交并登记为计算输入。" />
          : <>
            <Form.Item name="datasource_id" label="输入数据源" rules={[{ required: true }]}>
              <Select placeholder="选择已登记的数据源" options={meta.data?.inputs.map(x => ({ value: x.id, label: `${x.name}（${x.type}）` }))} />
            </Form.Item>
            {chosenSource && !isDatabaseSource && <Form.Item label="文件内容形态" required>
              <Radio.Group value={contentKind} optionType="button" onChange={event => setContentKind(event.target.value)}
                options={[{ value: 'structured', label: '结构化文件' }, { value: 'unstructured', label: '非结构化文件' }]} />
            </Form.Item>}
            {chosenSource && isDatabaseSource && <DatabaseSourceInput datasourceId={chosenSource}
              relation={pickedFiles[0]} onSelect={(qualifiedName, objectRef) => {
                setPickedFiles([qualifiedName]); setDatabaseObjectRef(objectRef); setInputFormat('table')
              }} />}
            {chosenSource && !isDatabaseSource && contentKind === 'structured' &&
              <StructuredFileSourceInput datasourceId={chosenSource} capability={capability}
                files={pickedFiles} inputFormat={inputFormat} multiple={channel === 'transfers'}
                onFiles={files => { setPickedFiles(files); setDatabaseObjectRef(undefined) }}
                onInputFormat={format => { setInputFormat(format); if (channel !== 'extractions') setOutputFormat(format) }} />}
            {chosenSource && !isDatabaseSource && contentKind === 'unstructured' &&
              <BinaryFileSourceInput datasourceId={chosenSource} capability={capability}
                files={pickedFiles} onFiles={files => { setPickedFiles(files); setDatabaseObjectRef(undefined) }} />}
            <Form.Item name="output" label="输出数据源" rules={[{ required: true }]} style={{ marginTop: 16 }}>
              <Select options={[
                ...outputs.map(o => ({ value: outputKey(o), label: o.label,
                  disabled: o.via === 'extractions' && (meta.data?.node_available === false || contentKind === 'unstructured') })),
                ...excluded.map(o => ({ value: `excluded:${o.datasource_id}`, label: `${o.label} — ${o.reason}`, disabled: true })),
              ]} />
            </Form.Item>
          </>}
        {/* 选中输出后立即固定展示产出后果，避免把「已落盘」当成「可以算了」。 */}
        {!!channel && <Alert style={{ marginBottom: 16 }} type={registers ? 'success' : 'warning'} showIcon
          message={registers ? '将上传至受控入口并登记计算输入' : '仅搬运文件，不产生计算资源'}
          description={<Space direction="vertical" size={0}>
            <Text type="secondary">执行通道：{channel === 'extractions' ? 'extractions（数据接入）' : 'transfers（通用搬运）'}</Text>
            <Text type="secondary">产出：{registers ? '计算输入（可用于计算）' : '仅文件（不可直接计算）'}</Text>
          </Space>} />}
        {channel === 'extractions' && <Row gutter={16}>
          <Col span={10}><Form.Item name="resource_ref" label="资源名称或引用" rules={[{ required: true }]}><Input /></Form.Item></Col>
          <Col span={6}><Form.Item name="resource_version" label="资源版本" rules={[{ required: true }]}><Input /></Form.Item></Col>
          <Col span={8}><Form.Item name="staging_backend" label="节点存储位置" rules={[{ required: true }]}>
            <Select options={(meta.data?.compute_input.backends || ['directory', 's3']).map(value => ({ value, label: backendName(value) }))} /></Form.Item></Col>
        </Row>}
        {channel === 'transfers' && <Form.Item name="output_path" label="输出子目录 / 对象前缀" extra="留空写入输出数据源根目录"><Input placeholder="out/day1" /></Form.Item>}
        {contentKind === 'structured' && <StructuredTransformFields
          schema={schema} scanning={scanning}
          canScan={!!chosenSource && pickedFiles.length > 0 && (isDatabaseSource || capability?.scanning === true)}
          scanReason={!pickedFiles.length ? (isDatabaseSource ? '请先选择要探测的表或视图' : '请先选择要扫描的文件') : capability?.reason}
          onScan={scan} fields={fields} onFields={setFields} conditions={conditions}
          onConditions={setConditions} previewRows={previewRows} onPreviewRows={setPreviewRows}
          outputFormat={outputFormat} onOutputFormat={setOutputFormat}
          computeInput={channel === 'extractions'} inputFormat={inputFormat}
          showInspection={method !== 'manual'} />}
      </Form>
    </Modal>

    <Modal title="生成的 SeaTunnel 配置（凭据已脱敏）" open={!!preview} width={760} onCancel={() => setPreview(undefined)} footer={<Button onClick={() => setPreview(undefined)}>关闭</Button>}>
      {preview && <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Descriptions column={1} size="small" bordered items={[
          { key: 'channel', label: '执行通道', children: preview.channel === 'extractions' ? 'extractions（数据接入）' : 'transfers（通用搬运）' },
          { key: 'out', label: '产出', children: preview.registers ? '计算输入（可用于计算）' : '仅文件（不可直接计算）' }]} />
        {preview.channel === 'extractions'
          ? <Alert type="info" showIcon message="接入任务的作业配置含本次上传会话的一次性凭据，只在任务执行时生成，创建前不预览。" />
          : <pre style={{ maxHeight: 420, overflow: 'auto', background: 'rgba(0,0,0,0.04)', padding: 12, fontSize: 12 }}>{JSON.stringify(preview.config, null, 2)}</pre>}
      </Space>}
    </Modal>

    <Drawer title="传输任务详情" width={840} open={!!selected} onClose={() => { setSelected(undefined); setReceived(undefined) }}>
      {detail.isError && <Alert type="error" message={errorText(detail.error)} />}
      {task && <Space direction="vertical" size={18} style={{ width: '100%' }}>
        <Descriptions column={2} bordered size="small" items={[
          { key: 'type', label: '任务类型', children: typeTag(task) },
          { key: 'state', label: '状态', children: <Tag color={stateColor(task)}>{stateText(task)}</Tag> },
          { key: 'channel', label: '执行通道', children: task.channel === 'extractions' ? 'extractions（数据接入）' : 'transfers（通用搬运）' },
          { key: 'out', label: '产出', children: task.registers_compute_input ? '计算输入（可用于计算）' : '仅文件（不可直接计算）' },
          ...(ingest ? [
            { key: 'node', label: '目标节点', children: ingest.node },
            { key: 'backend', label: '节点存储位置', children: backendName(ingest.backend) },
            { key: 'phase', label: '当前阶段', children: INGEST_STATES[ingest.phase] || ingest.phase },
            { key: 'engine', label: '抽取状态', children: ingest.mode === 'manual' ? '客户端上传' : ingest.engine_status || '等待引擎结果' },
          ] : [
            { key: 'files', label: '输入对象', children: planInputName(transfer!.plan) },
            { key: 'dest', label: '输出落点', children: outputs.find(o => outputKey(o) === outputKey(transfer!.plan.output))?.label || transfer!.plan.output.target },
            { key: 'engine', label: '引擎状态', children: transfer!.engine_status || '等待引擎结果' },
            { key: 'job', label: '引擎 Job ID', children: transfer!.job_id || '—' },
          ]),
        ]} />
        {task.error && <Alert type="error" showIcon message={`${(isIngestion(task) ? INGEST_STATES : TRANSFER_STATES)[task.error.phase] || task.error.phase}阶段未完成`} description={task.error.message} />}
        <Space wrap>
          {canConfirm && <Button loading={busy} onClick={() => act(async () => setCredentials(await uploadCredentials(ingest!.id)))}>获取上传凭据</Button>}
          {canConfirm && <Button loading={busy} icon={<ReloadOutlined />} onClick={() => act(async () => setReceived((await receivedFiles(ingest!.id)).received_files || []))}>核对已接收文件</Button>}
          {canConfirm && <Popconfirm title={`确认这 ${files.length} 个文件已全部上传完成？`} description="确认后校验并冻结本批次，不能再修改文件。" onConfirm={() => act(() => completeExtraction(ingest!.id, files), '已开始校验和登记')}><Button type="primary" disabled={!files.length || busy}>确认完成</Button></Popconfirm>}
          {ingest?.state === 'queued' && ingest.mode !== 'manual' && <Button onClick={() => act(() => runExtraction(ingest.id), '任务已开始')}>开始接入</Button>}
          {/* 恢复按文案统一，实际按任务原通道调用原接口。 */}
          {((ingest?.state === 'waiting-retry' && ingest.error?.retryable) || (transfer?.error?.retryable)) &&
            <Button type="primary" loading={busy} onClick={() => act(() => ingest ? runExtraction(ingest.id) : runTransfer(transfer!.id), '正在按原任务恢复')}>恢复任务</Button>}
          {ingest && ['queued', 'awaiting-upload'].includes(ingest.state) && <Popconfirm title="撤销此上传任务？" onConfirm={() => act(() => cancelExtraction(ingest.id), '任务已撤销')}><Button danger disabled={busy}>撤销任务</Button></Popconfirm>}
          {ingest && ['ready', 'cancelled', 'failed', 'awaiting-upload'].includes(ingest.state) && <Popconfirm title="清理本任务的已过期数据？" description="节点会检查资源和作业引用；仍在使用的数据会被保留。" onConfirm={() => act(() => cleanupExtraction(ingest.id), '任务数据已清理')}><Button disabled={busy}>清理过期数据</Button></Popconfirm>}
          {/* 搬运产物落在输出数据源侧，没有引用保护也没有周期清扫器，不提供等价清理入口。 */}
          {transfer && <Tooltip title="搬运产物写入输出数据源，由该数据源自行管理，本页不支持自动清理"><Button disabled>不支持清理输出</Button></Tooltip>}
        </Space>
        {ingest && <>
          <Card title={`接收文件：${files.length} 个，共 ${bytes(files.reduce((n, f) => n + f.size, 0))}`} size="small">
            <Table size="small" rowKey="path" dataSource={files} columns={fileColumns} scroll={{ x: 680 }} /></Card>
          {!!ingest.resources?.length && <Alert type="success" showIcon message={`已登记 ${ingest.resources.length} 个计算输入，内容读取校验通过`} />}
          <Descriptions column={1} size="small" items={[
            { key: 'id', label: '任务 ID', children: <Text copyable>{ingest.id}</Text> },
            { key: 'job', label: '引擎 Job ID', children: ingest.job_id || '—' },
            { key: 'session', label: '上传会话', children: ingest.session_id || '—' }]} />
        </>}
        {transfer && <Card size="small" title="本次使用的 SeaTunnel 配置（凭据已脱敏）">
          <pre style={{ maxHeight: 360, overflow: 'auto', fontSize: 12 }}>{JSON.stringify(transfer.config, null, 2)}</pre></Card>}
      </Space>}
    </Drawer>

    <Modal title="FTP 上传凭据" open={!!credentials} footer={<Button onClick={() => setCredentials(undefined)}>关闭</Button>} onCancel={() => setCredentials(undefined)} destroyOnClose>
      {credentials && <Space direction="vertical" style={{ width: '100%' }}>
        <Alert type="info" showIcon message={meta.data?.compute_input.require_tls ? '受控入口使用显式 FTPS，并校验证书。' : '受控入口使用被动 FTP；此地址须能从上传客户端访问。'} />
        <Descriptions column={1} items={[{ key: 'host', label: '主机', children: credentials.host }, { key: 'port', label: '端口', children: credentials.port },
          { key: 'user', label: '用户名', children: <Text copyable>{credentials.username}</Text> },
          { key: 'root', label: '上传目录', children: credentials.directory },
          { key: 'expires', label: '有效期至', children: new Date(credentials.expires_at).toLocaleString() }]} />
        <Input.Password aria-label="FTP 密码" value={credentials.password} readOnly autoComplete="off" />
        <Paragraph>上传全部 CSV 文件后，关闭此窗口，核对已接收文件并点击“确认完成”。</Paragraph>
      </Space>}
    </Modal>
  </Space></div>
}
