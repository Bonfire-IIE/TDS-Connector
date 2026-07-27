import * as fs from "fs";
import * as path from "path";

import { config } from "./config";

export interface ConnectorManifest {
  domainId: string;
  connectorId?: string;
  liteEndpoint?: string;
  certDir: string;
  fileService?: {
    endpoint: string;
    token?: string;
  };
  manifestPath: string;
}

function unquote(value: string): string {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

// Parse the deliberately small connector.yaml schema without accepting arbitrary YAML features.
function parseManifest(file: string): ConnectorManifest {
  const values = new Map<string, string>();
  let section = "";
  for (const raw of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const match = line.trim().match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/);
    if (!match) throw new Error(`不支持的 connector.yaml 行: ${raw}`);
    const key = match[1];
    const value = match[2] ?? "";
    if (indent === 0) {
      section = value === "" ? key : "";
      if (value !== "") values.set(key, unquote(value));
    } else if (section && value !== "") {
      values.set(`${section}.${key}`, unquote(value));
    }
  }

  const domainId = values.get("domainId") ?? "";
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(domainId)) {
    throw new Error("connector.yaml 缺少合法的 domainId");
  }
  const base = path.dirname(file);
  const certValue = values.get("certDir") || "./certs";
  const endpoint = values.get("fileService.endpoint");
  return {
    domainId,
    connectorId: values.get("connectorId") || undefined,
    liteEndpoint: values.get("liteEndpoint") || undefined,
    certDir: path.resolve(base, certValue),
    fileService: endpoint
      ? { endpoint: endpoint.replace(/\/+$/, ""), token: values.get("fileService.token") || undefined }
      : undefined,
    manifestPath: file,
  };
}

export function findConnectorManifest(domainId: string): ConnectorManifest | null {
  const root = path.resolve(config.portalHome, "connectors");
  const candidate = path.resolve(root, domainId, "connector.yaml");
  if (!candidate.startsWith(root + path.sep) || !fs.existsSync(candidate)) return null;
  const manifest = parseManifest(candidate);
  if (manifest.domainId !== domainId) throw new Error("connector.yaml 的 domainId 与目录不一致");
  return manifest;
}

export function requiredCertFiles(certDir: string): { complete: boolean; missing: string[] } {
  const required = ["ca.crt", "kusciaapi-server.crt", "kusciaapi-server.key", "token"];
  const missing = required.filter((name) => !fs.existsSync(path.join(certDir, name)));
  return { complete: missing.length === 0, missing };
}
