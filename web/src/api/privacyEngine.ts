import { api } from './client'

export interface EngineState {
  configured: boolean; status: 'not_configured' | 'available' | 'unavailable'; portal_browser_url?: string
  engine_type?: 'kuscia'; connector_id?: string; implementation_ref?: string; control_endpoint?: string; gateway_endpoint?: string; capabilities?: string[]; engine_datasource_ref?: string; peer_connector_id?: string; peer_domain_id?: string; peer_gateway_endpoint?: string; reason?: string
}
export interface ProvisionInfo {
  adapter_type: string; implementation_ref: string; mode: 'master-lite'; node_type: 'lite'; master_endpoint: string; deploy_token: string
  engine_image: string
  engine_datasource_ref: string
}
export async function getEngineState() { return api.get<unknown, EngineState>('/portal/integrations/privacy-compute/state') }
export async function provisionEngine(implementation_ref?: string) { return api.post<unknown, ProvisionInfo>('/portal/integrations/privacy-compute/provision', { implementation_ref }) }
export async function deploymentScript(body: Record<string, unknown>) { return api.post<unknown, { commands: string }>('/portal/integrations/privacy-compute/deploy-script', body) }
export async function activateEngine(body: Record<string, unknown>) { return api.post<unknown, EngineState>('/portal/integrations/privacy-compute/activate', body) }
export async function listExecutionRequests() { return api.get<unknown, Array<Record<string, unknown>>>('/portal/integrations/privacy-compute/execution-requests') }
export async function registerAppImage(body: Record<string, unknown>) {
  return api.post<unknown, { name: string; registered: boolean; published: boolean }>('/portal/integrations/privacy-compute/appimages/register', body)
}
export async function executeRequest(runId: string) { return api.post<unknown, Record<string, unknown>>(`/portal/integrations/privacy-compute/execution-requests/${encodeURIComponent(runId)}/execute`, {}) }
export async function syncRequest(runId: string) { return api.post<unknown, Record<string, unknown>>(`/portal/integrations/privacy-compute/execution-requests/${encodeURIComponent(runId)}/sync`, {}) }
