import { Form } from 'antd'
import DatabaseTablePicker from './DatabaseTablePicker'

export default function DatabaseSourceInput({ datasourceId, relation, onSelect }: {
  datasourceId: string
  relation?: string
  onSelect: (qualifiedName: string, objectRef: string) => void
}) {
  return <Form.Item label="需要搬运的数据库表或视图" required>
    <DatabaseTablePicker datasourceId={datasourceId} value={relation} onChange={onSelect} />
  </Form.Item>
}
