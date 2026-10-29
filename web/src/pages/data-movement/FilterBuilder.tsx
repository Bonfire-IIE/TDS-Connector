/**
 * 结构化数据的筛选器：扫描文件结构后，字段与取值条件都变成可选而非手填。
 *
 * 按列类型给不同控件：数值给范围/精确，布尔与枚举给候选值下拉，字符串给精确/多值。
 * 「前 N 行」只作用于扫描预览——SeaTunnel 2.3.8 不支持搬运时限制行数，页面必须说清楚，
 * 否则用户会以为搬运也只搬前 N 行。
 */
import { useState } from 'react'
import {
  Alert, Button, Card, Checkbox, Col, Empty, InputNumber, Row, Select, Space, Table, Tag, Typography,
} from 'antd'
import { MinusCircleOutlined, PlusOutlined, ScanOutlined } from '@ant-design/icons'
import { ColumnKind, FilterCondition, ScannedColumn, ScannedSchema } from '../../api/portal'
const { Text, Paragraph } = Typography

const KIND_LABEL: Record<ColumnKind, string> = {
  integer: '整数', double: '小数', boolean: '布尔', enum: '枚举', string: '文本', unknown: '未知',
}
const NUMERIC_OPS = [
  { value: 'between', label: '范围（含端点）' }, { value: 'eq', label: '等于' }, { value: 'ne', label: '不等于' },
  { value: 'gte', label: '大于等于' }, { value: 'lte', label: '小于等于' },
]
const TEXT_OPS = [{ value: 'eq', label: '等于' }, { value: 'ne', label: '不等于' }, { value: 'in', label: '属于其中之一' }]

const isNumeric = (kind: ColumnKind) => kind === 'integer' || kind === 'double'

/** 新增条件时按列类型给一个合法默认值，避免出现 op 与 kind 不匹配的中间态。 */
function defaultCondition(column: ScannedColumn): FilterCondition {
  if (isNumeric(column.kind)) {
    return { field: column.name, kind: column.kind as 'integer' | 'double', op: 'between',
      value: column.min ?? 0, value2: column.max ?? 0 }
  }
  if (column.kind === 'boolean') return { field: column.name, kind: 'boolean', op: 'eq', value: true }
  return { field: column.name, kind: column.kind === 'enum' ? 'enum' : 'string', op: 'eq',
    value: column.values?.[0] ?? '' }
}

export default function FilterBuilder({ schema, scanning, canScan, scanReason, onScan, fields, onFields,
                                        conditions, onConditions, previewRows, onPreviewRows }: {
  schema?: ScannedSchema
  scanning: boolean
  canScan: boolean
  scanReason?: string
  onScan: () => void
  fields: string[]
  onFields: (fields: string[]) => void
  conditions: FilterCondition[]
  onConditions: (conditions: FilterCondition[]) => void
  previewRows: number
  onPreviewRows: (rows: number) => void
}) {
  const [adding, setAdding] = useState<string>()
  const columns = schema?.columns || []
  const byName = (name: string) => columns.find(c => c.name === name)

  const update = (index: number, patch: Partial<FilterCondition>) => {
    onConditions(conditions.map((c, i) => i === index ? ({ ...c, ...patch } as FilterCondition) : c))
  }

  if (!schema) {
    return <Card size="small" title="字段与筛选">
      {canScan
        ? <Space direction="vertical">
            <Paragraph type="secondary" style={{ marginBottom: 0 }}>
              扫描所选文件的开头若干行，自动识别字段名与类型；随后可按字段、取值范围筛选。
            </Paragraph>
            <Button type="primary" icon={<ScanOutlined />} loading={scanning} onClick={onScan}>扫描文件结构</Button>
          </Space>
        : <Alert type="info" showIcon message={scanReason || '该数据源不支持扫描，请手填列定义'} />}
    </Card>
  }

  return <Space direction="vertical" size={12} style={{ width: '100%' }}>
    <Card size="small" title={`字段（共 ${columns.length} 个，已选 ${fields.length || columns.length} 个）`}
      extra={<Space>
        <Button size="small" onClick={() => onFields([])}>全选</Button>
        <Button size="small" icon={<ScanOutlined />} loading={scanning} onClick={onScan}>重新扫描</Button>
      </Space>}>
      {!schema.complete && <Alert style={{ marginBottom: 12 }} type="warning" showIcon
        message={`仅采样了前 ${schema.sampled_rows} 行`}
        description="文件大于采样窗口，下方的数值极值与候选取值只是样本，不代表全量数据的真实范围。" />}
      <Checkbox.Group value={fields.length ? fields : columns.map(c => c.name)}
        onChange={values => onFields(values.length === columns.length ? [] : (values as string[]))}
        style={{ width: '100%' }}>
        <Row gutter={[12, 8]}>
          {columns.map(column => <Col span={8} key={column.name}>
            <Checkbox value={column.name}>
              <Space size={4}>
                <Text>{column.name}</Text>
                <Tag color={isNumeric(column.kind) ? 'blue' : column.kind === 'boolean' ? 'purple' : column.kind === 'enum' ? 'cyan' : 'default'}>
                  {KIND_LABEL[column.kind]}
                </Tag>
              </Space>
            </Checkbox>
          </Col>)}
        </Row>
      </Checkbox.Group>
      <Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
        全选时不生成筛选步骤；输出列顺序与源文件一致。
      </Text>
    </Card>

    <Card size="small" title={`取值筛选（${conditions.length} 条，多条之间为“且”）`}
      extra={<Space>
        <Select size="small" style={{ width: 190 }} placeholder="选择字段以添加条件" value={adding}
          options={columns.filter(c => c.kind !== 'unknown').map(c => ({ value: c.name, label: `${c.name}（${KIND_LABEL[c.kind]}）` }))}
          onChange={value => setAdding(value)} />
        <Button size="small" icon={<PlusOutlined />} disabled={!adding} onClick={() => {
          const column = byName(adding!)
          if (column) onConditions([...conditions, defaultCondition(column)])
          setAdding(undefined)
        }}>添加条件</Button>
      </Space>}>
      {!conditions.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未设置条件，将搬运全部行" />}
      {conditions.map((condition, index) => {
        const column = byName(condition.field)
        const numeric = isNumeric(condition.kind)
        return <Row key={`${condition.field}-${index}`} gutter={8} align="middle" style={{ marginBottom: 8 }}>
          <Col span={5}><Text code>{condition.field}</Text></Col>
          <Col span={5}>
            <Select style={{ width: '100%' }} value={condition.op}
              options={condition.kind === 'boolean' ? [{ value: 'eq', label: '等于' }] : numeric ? NUMERIC_OPS : TEXT_OPS}
              onChange={op => update(index, { op } as Partial<FilterCondition>)} />
          </Col>
          <Col span={12}>
            {condition.kind === 'boolean'
              ? <Select style={{ width: '100%' }} value={condition.value ? 'true' : 'false'}
                  options={[{ value: 'true', label: '真 (true)' }, { value: 'false', label: '假 (false)' }]}
                  onChange={v => update(index, { value: v === 'true' } as Partial<FilterCondition>)} />
              : numeric
                ? condition.op === 'between'
                  ? <Space.Compact style={{ width: '100%' }}>
                      <InputNumber style={{ width: '50%' }} aria-label="下界" value={condition.value as number}
                        min={column?.min} max={column?.max}
                        onChange={v => update(index, { value: Number(v ?? 0) } as Partial<FilterCondition>)} />
                      <InputNumber style={{ width: '50%' }} aria-label="上界" value={condition.value2}
                        min={column?.min} max={column?.max}
                        onChange={v => update(index, { value2: Number(v ?? 0) } as Partial<FilterCondition>)} />
                    </Space.Compact>
                  : <InputNumber style={{ width: '100%' }} aria-label="取值" value={condition.value as number}
                      onChange={v => update(index, { value: Number(v ?? 0) } as Partial<FilterCondition>)} />
                : condition.op === 'in'
                  ? <Select mode={column?.values?.length ? 'multiple' : 'tags'} style={{ width: '100%' }}
                      placeholder="选择或输入候选值"
                      value={Array.isArray(condition.value) ? condition.value : [condition.value].filter(Boolean) as string[]}
                      options={(column?.values || []).map(v => ({ value: v, label: v }))}
                      onChange={v => update(index, { value: v as string[] } as Partial<FilterCondition>)} />
                  : column?.values?.length
                    ? <Select style={{ width: '100%' }} value={String(condition.value)}
                        options={column.values.map(v => ({ value: v, label: v }))}
                        onChange={v => update(index, { value: v } as Partial<FilterCondition>)} />
                    : <Select mode="tags" maxCount={1} style={{ width: '100%' }} placeholder="输入取值"
                        value={condition.value ? [String(condition.value)] : []}
                        onChange={v => update(index, { value: (v as string[])[0] ?? '' } as Partial<FilterCondition>)} />}
          </Col>
          <Col span={2}>
            <Button aria-label="删除条件" icon={<MinusCircleOutlined />}
              onClick={() => onConditions(conditions.filter((_, i) => i !== index))} />
          </Col>
        </Row>
      })}
      {conditions.some(c => c.kind === 'boolean') && <Alert style={{ marginTop: 8 }} type="info" showIcon
        message="布尔字段参与筛选时会按文本读取"
        description="引擎对布尔列的比较在该版本会静默返回 0 行，因此这类列自动按文本处理，筛选结果不受影响。" />}
    </Card>

    <Card size="small" title="采样预览">
      <Space align="center" wrap style={{ marginBottom: 12 }}>
        <Text>预览行数</Text>
        <InputNumber min={1} max={200} value={previewRows} onChange={v => onPreviewRows(Number(v ?? 20))} />
        <Button size="small" loading={scanning} onClick={onScan}>按此行数重新扫描</Button>
        <Tag color="orange">仅影响预览，不限制搬运行数</Tag>
      </Space>
      <Alert style={{ marginBottom: 12 }} type="warning" showIcon
        message="搬运不支持限制行数"
        description="当前引擎版本不支持在搬运时取前 N 行；此处行数只用于查看数据与识别字段。若需限制行数，请在数据库源的查询里自行处理。" />
      <Table size="small" pagination={false} scroll={{ x: true }}
        rowKey={(_, index) => String(index)}
        dataSource={schema.sample.map((row, index) => ({ key: index,
          ...Object.fromEntries(columns.map((c, i) => [c.name, row[i]])) }))}
        columns={columns.map(c => ({ title: c.name, dataIndex: c.name, ellipsis: true }))} />
    </Card>
  </Space>
}
