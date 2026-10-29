import type { ReactNode } from 'react'
import { Card, Statistic, Typography } from 'antd'
import { ArrowUpOutlined } from '@ant-design/icons'

export function WorkspaceHeader({ kicker, title, description, action, icon }: { kicker: string; title: string; description: string; action?: ReactNode; icon?: ReactNode }) {
  return <div className="workspace-header"><div className="workspace-header-copy"><div className="workspace-kicker">{kicker}</div><Typography.Title level={2}>{title}</Typography.Title><Typography.Paragraph>{description}</Typography.Paragraph></div><div className="workspace-header-actions">{action}{icon && <div className="workspace-header-icon" aria-hidden="true">{icon}</div>}</div></div>
}

export function MetricStrip({ items }: { items: { label: string; value: ReactNode; hint?: string; tone?: 'default' | 'success' | 'warning' | 'danger' }[] }) {
  return <div className="workspace-metrics">{items.map(item => <Card className={`workspace-metric workspace-metric-${item.tone || 'default'}`} key={item.label}><Statistic title={item.label} value={item.value as any} /><div className="workspace-metric-hint"><ArrowUpOutlined /> {item.hint || '当前状态'}</div></Card>)}</div>
}

export function SectionCard({ title, description, action, children, className = '' }: { title: string; description?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <Card className={`workspace-section ${className}`} title={<div><div className="workspace-section-title">{title}</div>{description && <div className="workspace-section-description">{description}</div>}</div>} extra={action}>{children}</Card>
}
