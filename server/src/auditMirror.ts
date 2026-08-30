import * as fs from "fs";
import * as path from "path";
import { config, resolveIdentity } from "./config";
import { PlatformClient } from "./platform";

function mirrorFile() { return path.join(config.portalDataDir, "audit-mirror.json"); }
function read() { try { return JSON.parse(fs.readFileSync(mirrorFile(), "utf-8")); } catch { return { cursor: undefined, events: [] }; } }

export async function syncAuditMirror(authorization: string): Promise<{ count: number; cursor?: string }> {
  const id = resolveIdentity();
  if (!id.connectorId) throw new Error("门户尚未绑定连接器");
  const current = read();
  const data = await new PlatformClient(authorization).syncAudit(id.connectorId, current.cursor);
  const events = [...(current.events ?? [])];
  for (const event of data?.events ?? []) {
    if (!events.some((x: any) => x.event_id === event.event_id)) events.push(event);
  }
  fs.mkdirSync(path.dirname(mirrorFile()), { recursive: true });
  fs.writeFileSync(mirrorFile(), JSON.stringify({ cursor: data?.next_cursor, events }, null, 2), { mode: 0o600 });
  return { count: data?.count ?? 0, cursor: data?.next_cursor };
}

export function readAuditMirror() { return read(); }
