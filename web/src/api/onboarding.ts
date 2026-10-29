import { api } from './client'

export interface OnboardingState {
  onboarded: boolean
  connector_id?: string
  identity_status?: string
  pending?: { connector_id: string; identity_dir?: string }
  connectors?: Array<{ connector_id: string }>
  access_denied?: boolean
}
export interface LocalIdentity { csr_pem: string; csr_fingerprint: string; public_key_fingerprint: string }
export interface RegisterBody { name: string; org_name?: string; csr_pem?: string }
export async function getOnboardingState() { return api.get<unknown, OnboardingState>('/portal/onboarding/state') }
export async function generateIdentity() { return api.post<unknown, LocalIdentity>('/portal/onboarding/identity') }
export async function register(body: RegisterBody) { return api.post<unknown, { id: string; status: string }>('/portal/onboarding/register', body) }
export async function finalize(connector_id: string) { return api.post<unknown, OnboardingState>('/portal/onboarding/finalize', { connector_id }) }
