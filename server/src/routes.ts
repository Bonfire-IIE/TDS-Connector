/**
 * 门户路由（/portal/*）。
 *
 * 统一响应 {code, message, data}。认证走转发 Bearer：门户不独立验签，
 * 从请求头取 Authorization 透传给平台（PlatformClient）。
 * 数据源：读走平台（只读集合），建/删走本机 Lite（AK/SK 不出域）+ 上报平台非密元数据。
 * 行为对齐原型 app/routers/portal.py。
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { Router, Request, Response } from "express";

import { config, resolveIdentity, deriveLiteCertDir } from "./config";
import { KusciaError, LiteClient, getLiteClient } from "./lite";
import { PlatformClient, PlatformError } from "./platform";
import { loadState, saveState } from "./state";
import { findConnectorManifest, requiredCertFiles } from "./connectorManifest";
import { getStorageBackend, StorageUnavailableError } from "./storage";

export const router = Router();

function wrap(data: unknown): Record<string, unknown> {
  return { code: 0, message: "ok", data };
}

/** 从请求头取 Authorization；缺失则 401（抛 HttpError）。 */
function requireBearer(authorization: string | undefined): string {
  if (!authorization) {
    throw new HttpError(401, "缺少 Authorization 头");
  }
  return authorization;
}

function platform(authorization: string | null | undefined): PlatformClient {
  return new PlatformClient(authorization ?? null);
}

/** 对齐 FastAPI HTTPException：响应体 {detail} + 指定 status。 */
class HttpError extends Error {
  readonly statusCode: number;
  readonly detail: unknown;
  constructor(statusCode: number, detail: unknown) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
    this.statusCode = statusCode;
    this.detail = detail;
  }
}

function getAuthHeader(req: Request): string | undefined {
  const h = req.headers["authorization"];
  if (Array.isArray(h)) return h[0];
  return h;
}

// ---- 请求体类型 ----
interface DataSourceCreate {
  name: string;
  type: "localfs" | "oss";
  uri?: string | null;
  info?: Record<string, any>;
  access_directly?: boolean;
}

/**
 * 构造 (下发 Lite 的 info, 上报 uri, 上报非密 info, access_directly)。
 * AK/SK 只进本机 Lite，绝不上报平台。uri 推导对齐平台 kuscia/catalog 约定。
 */
function buildKusciaInfo(body: DataSourceCreate): {
  kusciaInfo: Record<string, unknown>;
  uri: string;
  stored: Record<string, unknown>;
  accessDirectly: boolean;
} {
  if (body.type === "localfs") {
    const info = body.info || {};
    const path = info.path || body.uri || config.storageRoot;
    const kusciaInfo = { localfs: { path } };
    // localfs 数据不出域 -> access_directly 强制 True
    return { kusciaInfo, uri: path, stored: { path }, accessDirectly: true };
  }
  // oss
  const i = body.info || {};
  const oss = {
    endpoint: i.endpoint ?? "",
    bucket: i.bucket ?? "",
    prefix: i.prefix ?? "",
    access_key_id: i.access_key_id ?? "",
    access_key_secret: i.access_key_secret ?? "",
    storage_type: i.storage_type ?? "",
    virtualhost: Boolean(i.virtualhost ?? false),
    version: i.version ?? "",
  };
  const kusciaInfo = { oss };
  const uri =
    body.uri ||
    `${String(oss.endpoint).replace(/\/+$/, "")}/${oss.bucket}/${oss.prefix}`.replace(
      /\/+$/,
      ""
    );
  // 上报仅保留非密字段（剔除 access_key_id / access_key_secret）
  const stored: Record<string, unknown> = {
    endpoint: oss.endpoint,
    bucket: oss.bucket,
    prefix: oss.prefix,
    storage_type: oss.storage_type,
    virtualhost: oss.virtualhost,
    version: oss.version,
  };
  return {
    kusciaInfo,
    uri,
    stored,
    accessDirectly: body.access_directly ?? true,
  };
}

function sendError(res: Response, e: unknown): void {
  if (e instanceof HttpError) {
    res.status(e.statusCode).json({ detail: e.detail });
    return;
  }
  if (e instanceof PlatformError) {
    res.status(e.statusCode).json({ detail: e.message });
    return;
  }
  res.status(500).json({ detail: (e as Error)?.message ?? String(e) });
}

// ---- 登录（代理平台）----
router.post("/login", async (req: Request, res: Response) => {
  const body = (req.body || {}) as { username?: string; password?: string };
  try {
    const data = await platform(null).login(
      body.username ?? "",
      body.password ?? ""
    );
    res.json(wrap({ access_token: data?.access_token }));
  } catch (e) {
    sendError(res, e);
  }
});

// ---- 连接器/Lite 状态（MVP 可不校验 Bearer）----
router.get("/status", async (_req: Request, res: Response) => {
  const id = resolveIdentity();
  let reachable = false;
  let nodeOnline = false;
  try {
    nodeOnline = await getLiteClient().nodeOnline(id.domainId);
    reachable = true;
  } catch (e) {
    if (e instanceof KusciaError) {
      reachable = false;
    } else {
      // 证书缺失等其它异常同样视为不可达，避免整体崩溃
      reachable = false;
    }
  }
  res.json(
    wrap({
      domain_id: id.domainId,
      connector_id: id.connectorId,
      lite: {
        reachable,
        node_online: nodeOnline,
        endpoint: id.liteKusciaEndpoint,
      },
      master: { endpoint: config.masterEndpoint },
      storage_root: config.storageRoot,
    })
  );
});

// ---- 数据源：只读集合来自平台 ----
router.get("/datasources", async (req: Request, res: Response) => {
  try {
    const auth = requireBearer(getAuthHeader(req));
    const items = await platform(auth).listDatasources(
      resolveIdentity().connectorId
    );
    res.json(wrap(items));
  } catch (e) {
    sendError(res, e);
  }
});

router.get("/resources", async (req: Request, res: Response) => {
  try {
    const auth = requireBearer(getAuthHeader(req));
    res.json(wrap(await platform(auth).listResources(resolveIdentity().connectorId)));
  } catch (e) { sendError(res, e); }
});

router.get("/files/status", async (_req: Request, res: Response) => {
  try { res.json(wrap(await getStorageBackend().status())); }
  catch (e) {
    if (e instanceof StorageUnavailableError) {
      res.json(wrap({ available: false, backend: "remote", message: e.message }));
    } else sendError(res, e);
  }
});

router.get("/files", async (req: Request, res: Response) => {
  try {
    requireBearer(getAuthHeader(req));
    const relativePath = typeof req.query.path === "string" ? req.query.path : "";
    res.json(wrap(await getStorageBackend().list(relativePath)));
  } catch (e) { sendError(res, e); }
});

router.put("/files", async (req: Request, res: Response) => {
  try {
    requireBearer(getAuthHeader(req));
    const directory = typeof req.query.path === "string" ? req.query.path : "";
    const filename = typeof req.query.filename === "string" ? path.basename(req.query.filename) : "";
    if (!filename || filename === "." || filename === "..") throw new HttpError(422, "缺少合法文件名");
    const length = Number(req.headers["content-length"]) || undefined;
    await getStorageBackend().upload(directory, filename, req, length);
    res.json(wrap({ path: path.posix.join(directory, filename) }));
  } catch (e) { sendError(res, e); }
});

router.get("/files/download", async (req: Request, res: Response) => {
  try {
    requireBearer(getAuthHeader(req));
    const relativePath = typeof req.query.path === "string" ? req.query.path : "";
    if (!relativePath) throw new HttpError(422, "缺少文件路径");
    const file = await getStorageBackend().download(relativePath);
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(path.posix.basename(relativePath))}`);
    if (file.contentType) res.setHeader("Content-Type", file.contentType);
    if (file.contentLength) res.setHeader("Content-Length", file.contentLength);
    file.stream.pipe(res);
  } catch (e) { sendError(res, e); }
});

// ---- 数据源：创建（本机 Lite 建源 + 上报平台非密元数据）----
router.post("/datasources", async (req: Request, res: Response) => {
  try {
    const auth = requireBearer(getAuthHeader(req));
    const id = resolveIdentity();
    const body = (req.body || {}) as DataSourceCreate;
    const kusciaDsId = "ds-" + crypto.randomBytes(6).toString("hex"); // 12 位 hex
    const { kusciaInfo, uri, stored, accessDirectly } = buildKusciaInfo(body);

    // ① 本机 Lite 建 DomainDataSource（用密钥，不落库；失败 -> 502）
    try {
      await getLiteClient().createDomainDataSource({
        domainId: id.domainId,
        datasourceId: kusciaDsId,
        type: body.type,
        name: body.name,
        info: kusciaInfo,
        accessDirectly,
      });
    } catch (e) {
      if (e instanceof KusciaError) {
        throw new HttpError(502, `创建本地 Lite DomainDataSource 失败: ${e.message}`);
      }
      throw e;
    }

    // ② 上报平台非密元数据
    const payload = {
      name: body.name,
      type: body.type,
      connector_id: id.connectorId,
      kuscia_datasource_id: kusciaDsId,
      uri,
      info: stored,
    };
    const result = await platform(auth).reportDatasource(payload);
    res.json(wrap(result));
  } catch (e) {
    sendError(res, e);
  }
});

// ---- 数据源：删除（本机 Lite 删源 + 平台注销）----
router.delete("/datasources/:platformId", async (req: Request, res: Response) => {
  try {
    const auth = requireBearer(getAuthHeader(req));
    const platformId = req.params.platformId;
    const kusciaDatasourceId = req.query.kuscia_datasource_id;
    if (typeof kusciaDatasourceId !== "string" || kusciaDatasourceId === "") {
      // 对齐 FastAPI Query(...) 必填缺失 -> 422
      throw new HttpError(422, "缺少 kuscia_datasource_id 查询参数");
    }

    // ① 本机 Lite 删 DomainDataSource（失败 -> 502）
    try {
      await getLiteClient().deleteDomainDataSource(
        resolveIdentity().domainId,
        kusciaDatasourceId
      );
    } catch (e) {
      if (e instanceof KusciaError) {
        throw new HttpError(502, `删除本地 Lite DomainDataSource 失败: ${e.message}`);
      }
      throw e;
    }

    // ② 平台注销记录
    const result = await platform(auth).deregisterDatasource(platformId);
    res.json(wrap(result));
  } catch (e) {
    sendError(res, e);
  }
});

// =====================================================================
// 接入流程（onboarding，设计见 design/connector-portal.md §8）
// 门户"代驱动"中心 provision：register(apply) → deploy-script → finalize。
// Domain/令牌只能由中心出；门户生成一键脚本给用户执行，部署后回传节点信息。
// =====================================================================

interface OnboardingRegister {
  name: string;
  org_name?: string | null;
  kuscia_domain_id: string;
  lite_api_endpoint: string;
  lite_api_port: number;
  auth_port: number;
  grpc_port: number;
  app_port: number;
  data_port: number;
}

interface OnboardingFinalize {
  connector_id: string;
  lite_cert_dir?: string | null;
  lite_kuscia_endpoint?: string | null;
  node?: {
    lite_api_endpoint?: string;
    lite_api_port?: number;
    auth_port?: number;
    grpc_port?: number;
    app_port?: number;
    data_port?: number;
  } | null;
}

// ---- 接入态（可不校验 Bearer）----
// 有 state 时按 state；无 state 但 env 已配连接器身份，视为 onboarded（兼容 alice env 实例）。
router.get("/onboarding/state", (_req: Request, res: Response) => {
  const st = loadState();
  if (st.onboarded) {
    res.json(
      wrap({
        onboarded: true,
        domain_id: st.domain_id,
        connector_id: st.connector_id,
        pending: st.pending,
      })
    );
    return;
  }
  // 无接入 state：若 env 已配置连接器身份（如 alice），兼容视为已接入
  const envConfigured = Boolean(config.portalDomainId && config.portalConnectorId);
  res.json(
    wrap({
      onboarded: envConfigured,
      domain_id: envConfigured ? config.portalDomainId : undefined,
      connector_id: envConfigured ? config.portalConnectorId : undefined,
      pending: st.pending,
    })
  );
});

// ---- 注册（驱动中心 provision：apply）----
// 列出当前用户的连接器（“已注册连接器”绕过路径用于选择要绑定的连接器）。
router.get("/onboarding/connectors", async (req: Request, res: Response) => {
  try {
    const auth = requireBearer(getAuthHeader(req));
    const list = await platform(auth).listConnectors();
    res.json(wrap(list));
  } catch (e) {
    sendError(res, e);
  }
});

router.get("/onboarding/discover", async (req: Request, res: Response) => {
  try {
    const auth = requireBearer(getAuthHeader(req));
    const connectorId = typeof req.query.connector_id === "string" ? req.query.connector_id : "";
    if (!connectorId) throw new HttpError(422, "缺少 connector_id");
    const connector = await platform(auth).getConnector(connectorId);
    const domain = String(connector?.kuscia_domain_id ?? "");
    const manifest = findConnectorManifest(domain);
    if (!manifest) return void res.json(wrap({ detected: false, domain_id: domain, message: "未发现 connector.yaml" }));
    const certs = requiredCertFiles(manifest.certDir);
    if (!certs.complete) return void res.json(wrap({ detected: false, domain_id: domain, message: `证书不完整: ${certs.missing.join(", ")}` }));
    const endpoint = manifest.liteEndpoint || `${String(connector.lite_api_endpoint).replace(/\/+$/, "")}:${connector.lite_api_port ?? 28081}`;
    try {
      await new LiteClient(endpoint, manifest.certDir).queryDomain(domain);
    } catch (e) {
      return void res.json(wrap({ detected: false, domain_id: domain, message: `证书或 Lite 校验失败: ${(e as Error).message}` }));
    }
    res.json(wrap({ detected: true, domain_id: domain, lite_endpoint: endpoint, file_service_configured: Boolean(manifest.fileService) }));
  } catch (e) { sendError(res, e); }
});

router.post("/onboarding/register", async (req: Request, res: Response) => {
  try {
    const auth = requireBearer(getAuthHeader(req));
    const body = (req.body || {}) as OnboardingRegister;
    const connector = await platform(auth).registerConnector({
      name: body.name,
      org_name: body.org_name ?? null,
      kuscia_domain_id: body.kuscia_domain_id,
      lite_api_endpoint: body.lite_api_endpoint,
      lite_api_port: body.lite_api_port,
      auth_port: body.auth_port,
      grpc_port: body.grpc_port,
      app_port: body.app_port,
      data_port: body.data_port,
    });
    // 记住待接入连接器（onboarded 仍 false，待 finalize 收尾）；
    // 存 lite_api_port 供 finalize 推导本地 Lite endpoint。
    saveState({
      pending: {
        connector_id: connector?.id,
        kuscia_domain_id: connector?.kuscia_domain_id ?? body.kuscia_domain_id,
        lite_api_port: body.lite_api_port,
      },
    });
    res.json(wrap(connector));
  } catch (e) {
    sendError(res, e);
  }
});

// ---- 一键部署脚本（取中心 provision 产物；未审批时平台 409 透传）----
router.get("/onboarding/deploy-script", async (req: Request, res: Response) => {
  try {
    const auth = requireBearer(getAuthHeader(req));
    const connectorId = req.query.connector_id;
    if (typeof connectorId !== "string" || connectorId === "") {
      throw new HttpError(422, "缺少 connector_id 查询参数");
    }
    const info = await platform(auth).getDeploy(connectorId);
    const domain = String(info?.kuscia_domain_id ?? "");
    // 门户接入附加步骤：把 Lite 证书**取出到本地目录**，供用户在门户“上传证书”框上传。
    // 门户随后把上传的证书写入自身数据根（门户可写），用户无需操心目标路径/权限。
    const exportCerts = domain
      ? [
          "",
          "# —— 取出 Lite 证书（随后回门户“上传证书”）——",
          `# 把本连接器 Lite 的证书导出到当前目录的 ${domain}-certs/，然后回到门户接入向导，`,
          `# 上传其中的 ca.crt / kusciaapi-server.crt / kusciaapi-server.key / token 四个文件。`,
          `docker cp "$(docker ps -qf name=${domain} | head -n1)":/home/kuscia/var/certs ./${domain}-certs`,
          `ls -1 ./${domain}-certs`,
        ].join("\n")
      : "";
    // 脚本正文 = 平台已生成的 commands + 证书导出，前置 shebang + 严格模式
    const commands =
      "#!/bin/bash\nset -euo pipefail\n" +
      String(info?.commands ?? "") +
      exportCerts +
      "\n";
    res.json(
      wrap({
        commands,
        deploy_token: info?.deploy_token,
        master_endpoint: info?.master_endpoint,
        kuscia_image: info?.kuscia_image,
      })
    );
  } catch (e) {
    sendError(res, e);
  }
});

// ---- 收尾（探活本地 Lite + 回传节点信息 + 落本地状态）----
// 上传 Lite 证书：门户把上传的证书写入自身数据根 <PORTAL_DATA_DIR>/lite/<域>/certs（门户可写）。
// files: { 文件名 -> base64 内容 }，通常为 ca.crt / kusciaapi-server.crt / kusciaapi-server.key / token。
router.post("/onboarding/upload-certs", async (req: Request, res: Response) => {
  try {
    const auth = requireBearer(getAuthHeader(req));
    const body = (req.body || {}) as {
      connector_id?: string;
      files?: Record<string, string>;
    };
    const connectorId = body.connector_id;
    if (!connectorId) throw new HttpError(422, "缺少 connector_id");
    const files = body.files || {};
    const names = Object.keys(files);
    if (names.length === 0) throw new HttpError(422, "未提供证书文件");

    // 解析目标域：pending 优先，否则回中心查询
    const st = loadState();
    let domain =
      st.pending && st.pending.connector_id === connectorId
        ? st.pending.kuscia_domain_id
        : undefined;
    if (!domain) {
      const conn = await platform(auth).getConnector(connectorId);
      domain = conn?.kuscia_domain_id;
    }
    if (!domain) throw new HttpError(422, "无法确定连接器域");

    const manifest = findConnectorManifest(domain);
    const discoveredCerts = manifest ? requiredCertFiles(manifest.certDir) : null;
    const certDir = discoveredCerts?.complete ? manifest!.certDir : deriveLiteCertDir(domain);
    fs.mkdirSync(certDir, { recursive: true });
    const saved: string[] = [];
    for (const name of names) {
      const safe = path.basename(name); // 防目录穿越
      if (!safe || safe === "." || safe === "..") continue;
      const buf = Buffer.from(files[name] ?? "", "base64");
      const mode = safe.endsWith(".key") || safe === "token" ? 0o600 : 0o644;
      fs.writeFileSync(path.join(certDir, safe), buf, { mode });
      saved.push(safe);
    }
    res.json(wrap({ cert_dir: certDir, saved }));
  } catch (e) {
    sendError(res, e);
  }
});

router.post("/onboarding/finalize", async (req: Request, res: Response) => {
  try {
    const auth = requireBearer(getAuthHeader(req));
    const body = (req.body || {}) as OnboardingFinalize;
    const connectorId = body.connector_id;
    if (!connectorId) {
      throw new HttpError(422, "缺少 connector_id");
    }

    // 解析目标域：优先取 pending，否则回中心查询
    const st = loadState();
    let domain =
      st.pending && st.pending.connector_id === connectorId
        ? st.pending.kuscia_domain_id
        : undefined;
    if (!domain) {
      const conn = await platform(auth).getConnector(connectorId);
      domain = conn?.kuscia_domain_id;
    }
    if (!domain) {
      throw new HttpError(422, "无法确定连接器域，请确认 connector_id 正确");
    }

    // 按约定推导 Lite 位置，用户无需手填：
    //   证书目录 = <PORTAL_DATA_DIR>/lite/<域>/certs（部署脚本已把 Lite 证书导出到此）
    //   endpoint = https://127.0.0.1:<注册时选定的 KusciaAPI 端口>
    const manifest = findConnectorManifest(domain);
    const discoveredCerts = manifest ? requiredCertFiles(manifest.certDir) : null;
    const certDir = discoveredCerts?.complete ? manifest!.certDir : deriveLiteCertDir(domain);
    // endpoint：已注册连接器路径显式指定（body.lite_kuscia_endpoint）；
    // 新注册路径按注册时选定的 KusciaAPI 端口推导 https://127.0.0.1:<port>。
    let liteEndpoint = body.lite_kuscia_endpoint || manifest?.liteEndpoint;
    if (!liteEndpoint) {
      let apiPort: number | undefined =
        st.pending && st.pending.connector_id === connectorId
          ? st.pending.lite_api_port
          : undefined;
      if (!apiPort) {
        const conn2 = await platform(auth).getConnector(connectorId);
        apiPort = conn2?.lite_api_port;
      }
      liteEndpoint = `https://127.0.0.1:${apiPort ?? 28081}`;
    }

    // ① 用本机 Lite 证书构 LiteClient 探活（读证书失败/不可达 -> 502）
    try {
      const client = new LiteClient(liteEndpoint, certDir);
      await client.queryDomain(domain);
    } catch (e) {
      throw new HttpError(
        502,
        `Lite 不可达，请确认已部署并起动: ${(e as Error)?.message ?? String(e)}`
      );
    }

    // ② 回传节点物理信息给中心（供 CDR / 在线态派生）
    if (body.node) {
      await platform(auth).reportNodeInfo(connectorId, body.node);
    }

    // ③ 落本地状态：标记 onboarded，清除 pending
    saveState({
      onboarded: true,
      domain_id: domain,
      connector_id: connectorId,
      lite_kuscia_endpoint: liteEndpoint,
      lite_cert_dir: certDir,
      pending: undefined,
    });

    res.json(wrap({ onboarded: true, connector_id: connectorId, domain_id: domain }));
  } catch (e) {
    sendError(res, e);
  }
});
