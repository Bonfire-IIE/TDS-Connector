/** Portal 文件状态仓库：支持多连接器、按平台用户隔离选择与接入进度。 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

function dataDir(): string {
  return process.env.PORTAL_DATA_DIR || path.join(os.homedir(), ".bonfire-connector");
}

function stateFile(): string {
  return process.env.PORTAL_STATE_FILE || path.join(dataDir(), "portal-state.json");
}

export interface OnboardingPending {
  connector_id: string;
  kuscia_domain_id: string;
  lite_api_endpoint?: string;
  lite_api_port?: number;
  owner_username: string;
}

export interface ConnectorProfile {
  connector_id: string;
  domain_id: string;
  owner_username?: string;
  lite_kuscia_endpoint?: string;
  lite_cert_dir?: string;
}

export interface PortalState {
  version: 2;
  connectors: Record<string, ConnectorProfile>;
  pending_by_user: Record<string, OnboardingPending>;
  selected_by_user: Record<string, string>;
}

interface LegacyState {
  onboarded?: boolean;
  domain_id?: string;
  connector_id?: string;
  lite_kuscia_endpoint?: string;
  lite_cert_dir?: string;
  pending?: Omit<OnboardingPending, "owner_username"> & { owner_username?: string };
}

function emptyState(): PortalState {
  return { version: 2, connectors: {}, pending_by_user: {}, selected_by_user: {} };
}

function migrate(parsed: LegacyState | PortalState): PortalState {
  if ((parsed as PortalState).version === 2) return parsed as PortalState;
  const old = parsed as LegacyState;
  const next = emptyState();
  if (old.onboarded && old.connector_id && old.domain_id) {
    next.connectors[old.connector_id] = {
      connector_id: old.connector_id,
      domain_id: old.domain_id,
      lite_kuscia_endpoint: old.lite_kuscia_endpoint,
      lite_cert_dir: old.lite_cert_dir,
    };
  }
  if (old.pending?.owner_username) {
    next.pending_by_user[old.pending.owner_username] = old.pending as OnboardingPending;
  }
  return next;
}

let cache: PortalState | null = null;

export function loadState(): PortalState {
  if (cache) return cache;
  try {
    cache = migrate(JSON.parse(fs.readFileSync(stateFile(), "utf-8")));
  } catch {
    cache = emptyState();
  }
  return cache;
}

function persist(next: PortalState): PortalState {
  cache = next;
  const file = stateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
  return next;
}

export function getPending(username: string): OnboardingPending | undefined {
  return loadState().pending_by_user[username];
}

export function savePending(username: string, pending: OnboardingPending): PortalState {
  const st = loadState();
  return persist({ ...st, pending_by_user: { ...st.pending_by_user, [username]: pending } });
}

export function clearPending(username: string): PortalState {
  const st = loadState();
  const pending = { ...st.pending_by_user };
  delete pending[username];
  return persist({ ...st, pending_by_user: pending });
}

export function saveProfile(username: string, profile: ConnectorProfile): PortalState {
  const st = loadState();
  // Re-registering a connector with the same Kuscia domain creates a new
  // platform connector ID.  The old local profile must not remain selectable:
  // it points at a deleted control-plane object and, more subtly, at the same
  // endpoint/certificate directory as the replacement deployment.
  const connectors = { ...st.connectors };
  for (const [connectorId, existing] of Object.entries(connectors)) {
    if (
      connectorId !== profile.connector_id &&
      existing.owner_username === username &&
      existing.domain_id === profile.domain_id
    ) {
      delete connectors[connectorId];
    }
  }
  return persist({
    ...st,
    connectors: { ...connectors, [profile.connector_id]: { ...profile, owner_username: username } },
    selected_by_user: { ...st.selected_by_user, [username]: profile.connector_id },
  });
}

export function profilesForUser(username: string): ConnectorProfile[] {
  return Object.values(loadState().connectors).filter((p) => p.owner_username === username);
}

export function selectedProfile(username: string): ConnectorProfile | undefined {
  const st = loadState();
  const selected = st.selected_by_user[username];
  return (selected && st.connectors[selected]) || profilesForUser(username)[0];
}

export function claimLegacyProfile(username: string, connectorId: string): ConnectorProfile | undefined {
  const st = loadState();
  const profile = st.connectors[connectorId];
  if (!profile || profile.owner_username) return profile;
  persist({
    ...st,
    connectors: { ...st.connectors, [connectorId]: { ...profile, owner_username: username } },
    selected_by_user: { ...st.selected_by_user, [username]: connectorId },
  });
  return { ...profile, owner_username: username };
}

export function selectProfile(username: string, connectorId: string): ConnectorProfile | undefined {
  const st = loadState();
  const profile = st.connectors[connectorId];
  if (!profile || profile.owner_username !== username) return undefined;
  persist({ ...st, selected_by_user: { ...st.selected_by_user, [username]: connectorId } });
  return profile;
}

export function hasAnyProfile(): boolean {
  return Object.keys(loadState().connectors).length > 0;
}
