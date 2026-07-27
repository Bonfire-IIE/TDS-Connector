/**
 * 本地 Lite KusciaAPI 客户端（HTTP + mTLS + Token）。
 *
 * 严格照搬原型 app/integrations/lite.py 的证书加载与 TLS 配置：
 * 用 Kuscia CA 校验服务端 + 挂载客户端证书(mTLS)，并关闭 hostname 校验
 * （经 IP 访问，服务端证书 CN 与 IP 不一致；服务端证书仍由 CA 强校验）。
 * 对应 Python 的 ssl.check_hostname=False -> https.Agent.checkServerIdentity 返回 undefined。
 *
 * 证书目录（config.liteCertDir）文件名约定同平台：
 *   kusciaapi-server.crt / kusciaapi-server.key / ca.crt / token
 */
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import axios, { AxiosInstance } from "axios";

import { config, resolveIdentity } from "./config";

export class KusciaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KusciaError";
  }
}

export interface DomainQueryData {
  node_statuses?: unknown[] | null;
  [k: string]: unknown;
}

export interface CreateDomainDataSourceArgs {
  domainId: string;
  datasourceId: string;
  type: string;
  name: string;
  info: Record<string, unknown>;
  accessDirectly?: boolean;
}

export class LiteClient {
  readonly endpoint: string;
  private readonly client: AxiosInstance;

  constructor(endpoint?: string, certDir?: string) {
    this.endpoint = (endpoint ?? config.liteKusciaEndpoint).replace(/\/+$/, "");
    const dir = certDir ?? config.liteCertDir;
    const crt = fs.readFileSync(path.join(dir, "kusciaapi-server.crt"));
    const key = fs.readFileSync(path.join(dir, "kusciaapi-server.key"));
    const ca = fs.readFileSync(path.join(dir, "ca.crt"));
    const token = fs.readFileSync(path.join(dir, "token"), "utf-8").trim();

    // 显式 https.Agent：CA 校验服务端 + 客户端证书(mTLS)，关闭 hostname 校验。
    const agent = new https.Agent({
      ca,
      cert: crt,
      key,
      checkServerIdentity: () => undefined,
    });

    this.client = axios.create({
      baseURL: this.endpoint,
      httpsAgent: agent,
      timeout: 10000,
      headers: { Token: token, "Content-Type": "application/json" },
      // 只走显式 Agent，不吃环境代理（对应 httpx trust_env=False）
      proxy: false,
    });
  }

  private async post(
    apiPath: string,
    payload: Record<string, unknown>
  ): Promise<Record<string, any>> {
    let data: any;
    try {
      const resp = await this.client.post(apiPath, payload);
      data = resp.data;
    } catch (e: any) {
      // 网络/TLS/HTTP 错误
      const msg =
        e?.response?.data && typeof e.response.data === "object"
          ? JSON.stringify(e.response.data)
          : e?.message ?? String(e);
      throw new KusciaError(msg);
    }
    const status = (data && data.status) || {};
    if (status.code !== 0 && status.code !== undefined && status.code !== null) {
      throw new KusciaError(status.message ?? "kuscia api error");
    }
    return data;
  }

  // ---- Domain（本域在线态）----
  async queryDomain(domainId: string): Promise<Record<string, any>> {
    return this.post("/api/v1/domain/query", { domain_id: domainId });
  }

  /** 有就绪工作节点即视为 online。 */
  async nodeOnline(domainId: string): Promise<boolean> {
    const resp = await this.queryDomain(domainId);
    const d: DomainQueryData = (resp && resp.data) || {};
    const statuses = d.node_statuses || [];
    return Array.isArray(statuses) && statuses.length > 0;
  }

  // ---- DomainDataSource（数据源，只能由本域 Lite 处理）----
  async createDomainDataSource(args: CreateDomainDataSourceArgs): Promise<void> {
    await this.post("/api/v1/domaindatasource/create", {
      domain_id: args.domainId,
      datasource_id: args.datasourceId,
      type: args.type,
      name: args.name,
      info: args.info,
      access_directly: args.accessDirectly ?? true,
    });
  }

  async deleteDomainDataSource(
    domainId: string,
    datasourceId: string
  ): Promise<void> {
    await this.post("/api/v1/domaindatasource/delete", {
      domain_id: domainId,
      datasource_id: datasourceId,
    });
  }
}

// 按 (endpoint|certDir) 缓存客户端：接入 finalize 后身份变化即命中新实例。
const clientCache = new Map<string, LiteClient>();

/**
 * 本机 Lite KusciaAPI 客户端（门户绑定单域）。身份经 resolveIdentity 解析
 * （onboarded 取 state，否则回退 env），据此缓存/复用实例。
 */
export function getLiteClient(): LiteClient {
  const id = resolveIdentity();
  const key = `${id.liteKusciaEndpoint}|${id.liteCertDir}`;
  let c = clientCache.get(key);
  if (!c) {
    c = new LiteClient(id.liteKusciaEndpoint, id.liteCertDir);
    clientCache.set(key, c);
  }
  return c;
}
