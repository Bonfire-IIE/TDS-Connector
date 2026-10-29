import { Alert, Button, Col, Form, Input, Row, Select, Typography } from 'antd'
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons'
import { FilterCondition, ScannedSchema } from '../../api/portal'
import FilterBuilder from './FilterBuilder'

const { Text } = Typography
const OUTPUT_FORMATS = ['csv', 'tsv', 'json', 'jsonl', 'parquet', 'orc']

export default function StructuredTransformFields({ schema, scanning, canScan, scanReason,
  onScan, fields, onFields, conditions, onConditions, previewRows, onPreviewRows,
  outputFormat, onOutputFormat, computeInput, inputFormat, showInspection = true }: {
  schema?: ScannedSchema
  scanning: boolean
  canScan: boolean
  scanReason?: string
  onScan: () => void
  fields: string[]
  onFields: (value: string[]) => void
  conditions: FilterCondition[]
  onConditions: (value: FilterCondition[]) => void
  previewRows: number
  onPreviewRows: (value: number) => void
  outputFormat: string
  onOutputFormat: (value: string) => void
  computeInput: boolean
  inputFormat: string
  showInspection?: boolean
}) {
  return <>
    <Form.Item label="输出文件格式" required
      extra={computeInput ? '当前 Kuscia 受控输入入口执行 CSV 校验。' : '可与输入格式不同，由 SeaTunnel 完成转换。'}>
      <Select value={computeInput ? 'csv' : outputFormat} disabled={computeInput}
        onChange={onOutputFormat} options={OUTPUT_FORMATS.map(value => ({ value, label: value.toUpperCase() }))} />
    </Form.Item>
    {showInspection && <FilterBuilder schema={schema} scanning={scanning} canScan={canScan} scanReason={scanReason}
      onScan={onScan} fields={fields} onFields={onFields} conditions={conditions}
      onConditions={onConditions} previewRows={previewRows} onPreviewRows={onPreviewRows} />}
    <div style={{ marginTop: 12 }}>
      <Text>列定义{schema ? '（已由结构探测填入，可微调）' : ''}</Text>
      <Form.List name="columns" rules={[{ validator: async (_, value) => {
        if (!value?.length) throw new Error('结构化数据至少需要一列')
      } }]}>{(columnFields, { add, remove }, { errors }) => <>
        {columnFields.map(field => <Row key={field.key} gutter={12} align="middle">
          <Col span={13}><Form.Item name={[field.name, 'name']} rules={[{ required: true, message: '请输入列名' }]}>
            <Input aria-label="列名" placeholder="列名" />
          </Form.Item></Col>
          <Col span={9}><Form.Item name={[field.name, 'type']} rules={[{ required: true }]}>
            <Select aria-label="列类型" options={['string', 'integer', 'double', 'boolean'].map(value => ({ value, label: value }))} />
          </Form.Item></Col>
          <Col span={2}><Button aria-label="删除列" icon={<MinusCircleOutlined />} onClick={() => remove(field.name)} /></Col>
        </Row>)}
        <Form.ErrorList errors={errors} />
        <Button onClick={() => add({ name: '', type: 'string' })} icon={<PlusOutlined />}>添加列</Button>
      </>}</Form.List>
    </div>
    <Alert style={{ marginTop: 16 }} type="info" showIcon
      message={`格式转换：${inputFormat.toUpperCase()} → ${(computeInput ? 'csv' : outputFormat).toUpperCase()}。CSV/TSV 输出使用 UTF-8 并包含表头。`} />
  </>
}
