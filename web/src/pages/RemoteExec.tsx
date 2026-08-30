import { Card, Alert, Typography } from 'antd'
const { Paragraph } = Typography
export default function RemoteExec() { return <Card title="远程执行"><Alert type="error" showIcon message="功能暂不可用" description="该功能仍在开发中，当前未开放任何远程执行入口。" /><Paragraph style={{ marginTop: 16 }}>后续远程执行将通过受控的 Kuscia 任务接口执行白名单操作，不直接开放主机 Shell。</Paragraph></Card> }
