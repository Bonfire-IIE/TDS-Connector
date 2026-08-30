/**
 * 平台 API 客户端（HTTP，转发 Bearer）。
 *
 * 门户不独立验签：登录代理平台 /identity/login 取 JWT；后续把前端请求头的
 * Authorization 原样透传给平台（上报以连接器属主身份鉴权）。
 * 平台响应统一 {code, message, data}，此处取 data 返回。
 * 对齐原型 app/integrations/platform.py。
 */
import axios, { AxiosInstance, Method } from "axios";

import { config } from "./config";

export class PlatformError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 502) {
    super(message);
    this.name = "PlatformError";
    this.statusCode = statusCode;
  }
}

export class PlatformClient {
  readonly base: string;
  private readonly client: AxiosInstance;

  constructor(bearer?: string | null) {
    this.base = config.platformApiBase.replace(/\/+$/, "");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (bearer) {
      // 透传原始 Authorization 头（bearer 可含或不含 "Bearer " 前缀）
      headers["Authorization"] = bearer.toLowerCase().startsWith("bearer ")
        ? bearer
        : `Bearer ${bearer}`;
    }
    this.client = axios.create({
      baseURL: this.base,
      headers,
      timeout: 15000,
      proxy: false,
    });
  }

  private async request(
    method: Method,
    path: string,
    body?: Record<string, unknown> | null,
    params?: Record<string, unknown> | null
  ): Promise<any> {
    let data: any;
    try {
      const resp = await this.client.request({
        method,
        url: path,
        data: body ?? undefined,
        params: params ?? undefined,
      });
      data = resp.data;
    } catch (e: any) {
      if (e?.response) {
        // 尽量透出平台的错误信息与状态码
        const resp = e.response;
        let detail: string;
        const bodyData = resp.data;
        if (bodyData && typeof bodyData === "object") {
          detail =
            (bodyData.detail as string) ||
            (bodyData.message as string) ||
            (typeof bodyData === "string" ? bodyData : JSON.stringify(bodyData));
        } else {
          detail = typeof bodyData === "string" ? bodyData : String(bodyData);
        }
        throw new PlatformError(`平台 API 错误: ${detail}`, resp.status);
      }
      // 网络/连接错误
      throw new PlatformError(`平台不可达: ${e?.message ?? String(e)}`, 502);
    }

    // 平台统一 {code, message, data}
    if (data && typeof data === "object" && "data" in data) {
      if (data.code !== 0 && data.code !== undefined && data.code !== null) {
        throw new PlatformError(data.message ?? "平台返回错误", 400);
      }
      return data.data;
    }
    return data;
  }

  // ---- 身份 ----
  /** 代理平台 /identity/login（ROPC），返回 data（含 access_token）。 */
  async login(username: string, password: string): Promise<any> {
    return this.request("POST", "/identity/login", { username, password });
  }

  /** 由中心验签并返回当前 token 的真实主体；Portal 不信任前端提交的用户名。 */
  async me(): Promise<any> {
    return this.request("GET", "/identity/me");
  }

  // ---- 数据源目录（中心侧非密元数据）----
  async listDatasources(connectorId: string): Promise<any> {
    return this.request("GET", "/catalog/datasources", null, {
      connector_id: connectorId,
    });
  }

  async reportDatasource(payload: Record<string, unknown>): Promise<any> {
    return this.request("POST", "/catalog/datasources/report", payload);
  }

  async deregisterDatasource(datasourceId: string): Promise<any> {
    return this.request(
      "DELETE",
      `/catalog/datasources/${datasourceId}/deregister`
    );
  }

  async listResources(connectorId: string): Promise<any> {
    return this.request("GET", "/catalog/resources", null, { connector_id: connectorId });
  }

  async listOwnedConnectors(): Promise<any> { return this.request("GET", "/connectors"); }

  async listProjects(connectorId: string): Promise<any> {
    return this.request("GET", "/projects", null, { connector_id: connectorId });
  }
  async getProject(id: string): Promise<any> { return this.request("GET", `/projects/${id}`); }

  async syncAudit(connectorId: string, cursor?: string): Promise<any> {
    return this.request("GET", "/audit/sync", null, { connector_id: connectorId, cursor });
  }

  // ---- 连接器接入（onboarding；驱动中心 provision）----
  /** 在中心注册连接器（apply）；返回 connector（含 id / kuscia_domain_id）。 */
  async registerConnector(body: Record<string, unknown>): Promise<any> {
    return this.request("POST", "/connectors", body);
  }

  /** 查询连接器（用于 finalize 时回填 kuscia_domain_id 等）。 */
  async getConnector(id: string): Promise<any> {
    return this.request("GET", `/connectors/${id}`);
  }

  async listConnectors(): Promise<any> {
    return this.request("GET", `/connectors`);
  }

  /**
   * 取部署信息（审批后可用）：{kuscia_domain_id, deploy_token, master_endpoint,
   * kuscia_image, commands}。未审批时平台返回 409，PlatformError 透传状态码。
   */
  async getDeploy(id: string): Promise<any> {
    return this.request("GET", `/connectors/${id}/deploy`);
  }

  /** 回传节点物理信息（供中心 CDR/在线态派生）。 */
  async reportNodeInfo(
    id: string,
    body: Record<string, unknown>
  ): Promise<any> {
    return this.request("POST", `/connectors/${id}/node-info`, body);
  }
}
