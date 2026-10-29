import { Alert, Form } from 'antd'
import { BrowseCapability } from '../../api/portal'
import FilePicker from './FilePicker'

export default function BinaryFileSourceInput({ datasourceId, capability, files, onFiles }: {
  datasourceId?: string
  capability?: BrowseCapability
  files: string[]
  onFiles: (files: string[]) => void
}) {
  return <>
    <Form.Item label="需要原样搬运的文件" required>
      <FilePicker datasourceId={datasourceId} capability={capability} value={files}
        onChange={onFiles} multiple />
    </Form.Item>
    <Alert type="info" showIcon message="文件将按二进制原样搬运"
      description="不会解析内容、探测字段、执行筛选或改变文件格式和文件名。" />
  </>
}
