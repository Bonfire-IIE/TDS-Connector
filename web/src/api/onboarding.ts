import axios from 'axios'
import { api } from './client'

// 接入向导（onboarding）相关接口。契约见 design/connector-portal.md §8。
// 注：client 的响应拦截已把 {code,message,data} 解包为 data，
// 故这里用 axios 的第二个泛型参数 R 声明「实际返回值」类型。

// 节点物理信息（注册时填写，finalize 时回传中心）。
export interface NodeInfo {
  lite_api_endpoint: string
  lite_api_port: number
  auth_port: number
  grpc_port: number
  app_port: number
  data_port: number
}

// 接入状态。未接入 -> 进向导；已接入 -> 进主应用。
export interface OnboardingState {
  onboarded: boolean
  domain_id?: string
  connector_id?: string
  // 已提交注册、等待运营方审批时返回。
  pending?: { connector_id: string; kuscia_domain_id: string }
  connectors?: Array<{ connector_id: string; domain_id: string }>
  access_denied?: boolean
}

export interface RegisterBody extends NodeInfo {
  name: string
  org_name?: string
  kuscia_domain_id: string
}

// 注册返回的连接器（applying 态）。
export interface RegisteredConnector {
  connector_id: string
  kuscia_domain_id: string
  status?: string
  name?: string
}

// 一键部署脚本。commands 可能是整段字符串或分行数组。
export interface DeployScript {
  commands: string | string[]
  deploy_token: string
  master_endpoint: string
  kuscia_image: string
}

// getDeployScript 的辨析结果：ready=已审批拿到脚本；pending=待审批(409)。
export type DeployScriptResult =
  | { status: 'ready'; script: DeployScript }
  | { status: 'pending' }

export interface FinalizeBody {
  connector_id: string
  lite_cert_dir?: string
  // 已注册连接器路径：显式指定本地 Lite 地址（IP:端口）；新注册路径留空，由门户按注册端口推导。
  lite_kuscia_endpoint?: string
  // 端口/地址在注册时已存中心，finalize 不再重复收集，此处可选。
  node?: NodeInfo
}

// 门户可绑定的已注册连接器（供“已注册连接器”绕过路径选择）。
export interface PortalConnector {
  id: string
  name: string
  kuscia_domain_id: string
  status: string
  lite_api_endpoint?: string | null
  lite_api_port?: number | null
}

export interface ConnectorDiscovery {
  detected: boolean
  domain_id: string
  lite_endpoint?: string
  file_service_configured?: boolean
  message?: string
}

// 列出当前用户的连接器（“已注册连接器”路径用于选择要绑定的连接器）。
export async function listConnectors() {
  return api.get<unknown, PortalConnector[]>('/portal/onboarding/connectors')
}

export async function discoverConnector(connectorId: string) {
  return api.get<unknown, ConnectorDiscovery>('/portal/onboarding/discover', {
    params: { connector_id: connectorId },
  })
}

// 接入状态查询（此接口无需 Bearer；带上也无害）。
export async function getOnboardingState() {
  return api.get<unknown, OnboardingState>('/portal/onboarding/state')
}

// 注册连接器：驱动中心 provision，返回 applying 态连接器。
export async function register(body: RegisterBody) {
  return api.post<unknown, RegisteredConnector>('/portal/onboarding/register', body)
}

// 拉取一键部署脚本；未审批时后端返回 409 -> 归一化为 { status: 'pending' }。
export async function getDeployScript(connectorId: string): Promise<DeployScriptResult> {
  try {
    const script = await api.get<unknown, DeployScript>('/portal/onboarding/deploy-script', {
      params: { connector_id: connectorId },
    })
    return { status: 'ready', script }
  } catch (e) {
    if (axios.isAxiosError(e) && e.response?.status === 409) {
      return { status: 'pending' }
    }
    throw e
  }
}

// 上传 Lite 证书：门户写入自身数据根。files: { 文件名 -> base64 内容 }。
export async function uploadCerts(connectorId: string, files: Record<string, string>) {
  return api.post<unknown, { cert_dir: string; saved: string[] }>(
    '/portal/onboarding/upload-certs',
    { connector_id: connectorId, files },
  )
}

// 完成接入：读证书 + 回传节点信息 + 中心落本地状态。
export async function finalize(body: FinalizeBody) {
  return api.post<unknown, OnboardingState>('/portal/onboarding/finalize', body)
}
