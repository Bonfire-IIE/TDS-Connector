import { api } from './client'

export interface DelegationParticipant {
  connector_id: string
  connector_name?: string
  org_name?: string
  domain_id?: string
  roles?: string[]
}
export interface DelegationDecision {
  connector_id: string
  kind?: string
  decision: string
  decided_by?: string
  decided_at?: string
}
export interface ComputationDelegation {
  id: string
  project_id: string
  project_name?: string
  version: number
  status: string
  expires_at: string
  created_at?: string
  scope_hash?: string
  contract_hash?: string
  scope: {
    instances?: Array<{ id?: string; version_id?: string; name?: string; roles?: Record<string, string> }>
    participants?: DelegationParticipant[]
    applications?: Array<{ id?: string; version_id?: string; name?: string; roles?: Record<string, string> }>
    roles?: Record<string, string>
    connector_ids?: string[]
    [key: string]: unknown
  }
  decisions?: DelegationDecision[]
  participant?: DelegationParticipant
}
export interface DelegationInbox {
  connector_id: string
  connector_name?: string
  org_name?: string
  domain_id?: string
  items: ComputationDelegation[]
}
export async function listComputationDelegations(): Promise<DelegationInbox> {
  const result = await api.get<unknown, DelegationInbox | ComputationDelegation[]>('/portal/computation-delegations')
  return Array.isArray(result) ? { connector_id: '', items: result } : result
}
export async function decideComputationDelegation(id: string, decision: 'accepted' | 'rejected') {
  return api.post<unknown, ComputationDelegation>(`/portal/computation-delegations/${encodeURIComponent(id)}/decision`, { decision })
}
