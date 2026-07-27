/**
 * 门户本地状态持久化（设计见 design/connector-portal.md §8.5 / §9.3）。
 *
 * 门户接入(onboarding)后需跨重启记住"自身身份/接入态"，落**本地 JSON 文件**
 * （不上 DB，能用文件就不上库）。仅存路径引用，不拷贝 Lite 私钥/证书，
 * 不落数据源 AK/SK、不落平台会话 token。文件权限 0600（属门户运行用户）。
 *
 * 路径取 env PORTAL_STATE_FILE，dev 默认
 *   /home/bonfire-tds/src/connector_portal/.portal-state.json
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** 门户数据根：优先 PORTAL_DATA_DIR，否则用户主目录下 ~/.bonfire-connector（无需 /home 或 root 权限）。 */
function dataDir(): string {
  const v = process.env.PORTAL_DATA_DIR;
  return v !== undefined && v !== ""
    ? v
    : path.join(os.homedir(), ".bonfire-connector");
}

/** 接入进行中（已在中心注册、尚未 finalize）的临时记录。 */
export interface OnboardingPending {
  connector_id: string;
  kuscia_domain_id: string;
  // 注册时用户选定的 Lite KusciaAPI 端口；finalize 据此推导本地 Lite endpoint
  lite_api_port?: number;
}

/** 门户持久化状态。未接入时仅 {onboarded:false}。 */
export interface PortalState {
  onboarded: boolean;
  domain_id?: string;
  connector_id?: string;
  lite_kuscia_endpoint?: string;
  lite_cert_dir?: string;
  pending?: OnboardingPending;
}

function stateFile(): string {
  const v = process.env.PORTAL_STATE_FILE;
  return v !== undefined && v !== ""
    ? v
    : path.join(dataDir(), "portal-state.json");
}

let cache: PortalState | null = null;

/** 读取本地状态；文件缺失/损坏时回退为未接入。进程内缓存一次。 */
export function loadState(): PortalState {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(stateFile(), "utf-8");
    const parsed = JSON.parse(raw) as PortalState;
    cache = parsed && typeof parsed === "object" ? parsed : { onboarded: false };
  } catch {
    cache = { onboarded: false };
  }
  return cache;
}

/**
 * 合并写入本地状态（浅合并 + 原子落盘，0600）。
 * 传 `pending: undefined` 可清除 pending（JSON.stringify 会丢弃 undefined 键）。
 */
export function saveState(patch: Partial<PortalState>): PortalState {
  const next: PortalState = { ...loadState(), ...patch };
  cache = next;
  const file = stateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}
