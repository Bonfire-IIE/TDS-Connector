import { Form, Select } from 'antd'
import { BrowseCapability } from '../../api/portal'
import FilePicker from './FilePicker'

const FORMATS = ['csv', 'tsv', 'json', 'jsonl', 'parquet', 'orc']

export default function StructuredFileSourceInput({ datasourceId, capability, files, inputFormat,
  multiple, onFiles, onInputFormat }: {
  datasourceId?: string
  capability?: BrowseCapability
  files: string[]
  inputFormat: string
  multiple: boolean
  onFiles: (files: string[]) => void
  onInputFormat: (format: string) => void
}) {
  const formats = (capability?.structured_formats || FORMATS).filter(value => FORMATS.includes(value))
  return <>
    <Form.Item label={`需要搬运的结构化文件${multiple ? '（多个文件须在同一目录且格式一致）' : ''}`} required>
      <FilePicker datasourceId={datasourceId} capability={capability} value={files} onChange={onFiles}
        onFormatChange={format => onInputFormat(format)} multiple={multiple} />
    </Form.Item>
    <Form.Item label="输入文件格式" required extra="从目录选择文件时自动识别；手填路径时请确认格式。">
      <Select value={inputFormat} onChange={onInputFormat}
        options={formats.map(value => ({ value, label: value.toUpperCase() }))} />
    </Form.Item>
  </>
}
