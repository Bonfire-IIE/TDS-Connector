"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
/**
 * 门户路由（/portal/*）。
 *
 * 统一响应 {code, message, data}。认证走转发 Bearer：门户不独立验签，
 * 从请求头取 Authorization 透传给平台（PlatformClient）。
 * 数据源：读走平台（只读集合），建/删走本机 Lite（AK/SK 不出域）+ 上报平台非密元数据。
 * 行为对齐原型 app/routers/portal.py。
 */
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const express_1 = require("express");
const config_1 = require("./config");
const lite_1 = require("./lite");
const platform_1 = require("./platform");
const state_1 = require("./state");
const connectorManifest_1 = require("./connectorManifest");
const storage_1 = require("./storage");
const auditMirror_1 = require("./auditMirror");
const nodeLogs_1 = require("./nodeLogs");
const authorization_1 = require("./authorization");
const onboardingState_1 = require("./onboardingState");
const requestIdentity_1 = require("./requestIdentity");
const portalStartedAt = Date.now();
exports.router = (0, express_1.Router)();
const downloadTickets = new Map();
const DOWNLOAD_TICKET_TTL_MS = 30000;
function wrap(data) {
    return { code: 0, message: "ok", data };
}
/** 从请求头取 Authorization；缺失则 401（抛 HttpError）。 */
function requireBearer(authorization) {
    if (!authorization) {
        throw new HttpError(401, "缺少 Authorization 头");
    }
    return authorization;
}
function platform(authorization) {
    return new platform_1.PlatformClient(authorization ?? null);
}
/** 对齐 FastAPI HTTPException：响应体 {detail} + 指定 status。 */
class HttpError extends Error {
    constructor(statusCode, detail) {
        super(typeof detail === "string" ? detail : JSON.stringify(detail));
        this.statusCode = statusCode;
        this.detail = detail;
    }
}
function getAuthHeader(req) {
    const h = req.headers["authorization"];
    if (Array.isArray(h))
        return h[0];
    return h;
}
/**
 * 构造 (下发 Lite 的 info, 上报 uri, 上报非密 info, access_directly)。
 * AK/SK 只进本机 Lite，绝不上报平台。uri 推导对齐平台 kuscia/catalog 约定。
 */
function buildKusciaInfo(body) {
    if (body.type === "localfs") {
        const info = body.info || {};
        const path = info.path || body.uri || config_1.config.storageRoot;
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
    const uri = body.uri ||
        `${String(oss.endpoint).replace(/\/+$/, "")}/${oss.bucket}/${oss.prefix}`.replace(/\/+$/, "");
    // 上报仅保留非密字段（剔除 access_key_id / access_key_secret）
    const stored = {
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
function sendError(res, e) {
    if (e instanceof HttpError) {
        res.status(e.statusCode).json({ detail: e.detail });
        return;
    }
    if (e instanceof platform_1.PlatformError) {
        res.status(e.statusCode).json({ detail: e.message });
        return;
    }
    res.status(500).json({ detail: e?.message ?? String(e) });
}
/**
 * 文件类接口的错误映射。
 *
 * 两种情况值得与 500 区分开，否则前端只能显示"服务器错误"：
 *  - 未配置 / 文件服务不可达 → 503，属于部署没做完或服务没起来，不是请求错。
 *  - 文件服务自己返回的 4xx（403 越权、404 不存在、409 冲突）→ **原样透出**，
 *    前端据此给出具体提示，而不是把"目录非空"也说成服务器错误。
 */
function sendFileError(res, e) {
    if (e instanceof storage_1.StorageUnavailableError) {
        res.status(503).json({ detail: e.message });
        return;
    }
    if (e instanceof storage_1.StorageRequestError) {
        const status = e.statusCode >= 400 && e.statusCode <= 599 ? e.statusCode : 502;
        res.status(status).json({ detail: e.message });
        return;
    }
    sendError(res, e);
}
// ---- 登录（代理平台）----
exports.router.post("/login", async (req, res) => {
    const body = (req.body || {});
    try {
        const data = await platform(null).login(body.username ?? "", body.password ?? "");
        res.json(wrap({ access_token: data?.access_token, switched: false }));
    }
    catch (e) {
        sendError(res, e);
    }
});
/**
 * 校验当前 token 是否属于 Portal 已绑定连接器的属主。
 * 管理员在中心侧可查看连接器，但不能据此操作边缘节点的 Lite、文件、日志或证书。
 */
async function requireBoundOwner(req) {
    const auth = requireBearer(getAuthHeader(req));
    const client = platform(auth);
    const user = await client.me();
    const username = String(user?.username ?? "");
    let profile = (0, state_1.selectedProfile)(username);
    if (profile && !profile.owner_username) {
        const legacyConnector = await client.getConnector(profile.connector_id);
        profile = (0, authorization_1.isConnectorOwner)(user, legacyConnector)
            ? (0, state_1.claimLegacyProfile)(username, profile.connector_id)
            : undefined;
    }
    // 旧单连接器文件没有 owner；仅在中心确认该用户确为属主后认领一次。
    if (!profile) {
        for (const candidate of Object.values((0, state_1.loadState)().connectors).filter((p) => !p.owner_username)) {
            const connector = await client.getConnector(candidate.connector_id);
            if ((0, authorization_1.isConnectorOwner)(user, connector)) {
                profile = (0, state_1.claimLegacyProfile)(username, candidate.connector_id);
                break;
            }
        }
    }
    if (!profile && config_1.config.portalConnectorId && config_1.config.portalDomainId) {
        const legacyConnector = await client.getConnector(config_1.config.portalConnectorId);
        if ((0, authorization_1.isConnectorOwner)(user, legacyConnector) && legacyConnector?.kuscia_domain_id === config_1.config.portalDomainId) {
            (0, state_1.saveProfile)(username, {
                connector_id: config_1.config.portalConnectorId,
                domain_id: config_1.config.portalDomainId,
                lite_kuscia_endpoint: config_1.config.liteKusciaEndpoint,
                lite_cert_dir: config_1.config.liteCertDir,
            });
            profile = (0, state_1.selectedProfile)(username);
        }
    }
    if (!profile)
        throw new HttpError(403, "当前账号没有可管理的本地连接器，请先完成接入");
    const id = (0, config_1.identityFromProfile)(profile);
    const connector = await client.getConnector(id.connectorId);
    const decision = (0, authorization_1.authorizeBoundOwner)(id, user, connector);
    if (!decision.ok)
        throw new HttpError(decision.statusCode, decision.message);
    return { auth, user, connector, identity: id };
}
async function requireConnectorOwner(auth, connectorId) {
    const client = platform(auth);
    const [user, connector] = await Promise.all([client.me(), client.getConnector(connectorId)]);
    if (!(0, authorization_1.isConnectorOwner)(user, connector)) {
        throw new HttpError(403, "当前账号不是该连接器属主，不能执行接入操作");
    }
    return { user, connector };
}
// 非 onboarding 的本地能力一律先执行租户守卫。登录和健康检查不经过该 Router 中间件。
exports.router.use(async (req, res, next) => {
    if (req.path.startsWith("/onboarding/"))
        return next();
    // 浏览器直接导航到下载 URL 时无法附带 Authorization；权限已在签发票据时校验，
    // 兑换时再核对票据绑定的本机 connector 身份。
    if (req.path === "/files/download")
        return next();
    try {
        const { identity } = await requireBoundOwner(req);
        (0, requestIdentity_1.withRequestIdentity)(identity, () => next());
    }
    catch (e) {
        sendError(res, e);
    }
});
// ---- 连接器/Lite 状态（MVP 可不校验 Bearer）----
exports.router.get("/status", async (_req, res) => {
    const id = (0, config_1.resolveIdentity)();
    let reachable = false;
    let nodeOnline = false;
    try {
        nodeOnline = await (0, lite_1.getLiteClient)().nodeOnline(id.domainId);
        reachable = true;
    }
    catch (e) {
        if (e instanceof lite_1.KusciaError) {
            reachable = false;
        }
        else {
            // 证书缺失等其它异常同样视为不可达，避免整体崩溃
            reachable = false;
        }
    }
    res.json(wrap({
        domain_id: id.domainId,
        connector_id: id.connectorId,
        lite: {
            reachable,
            node_online: nodeOnline,
            endpoint: id.liteKusciaEndpoint,
        },
        master: { endpoint: config_1.config.masterEndpoint },
        storage_root: config_1.config.storageRoot,
    }));
});
exports.router.get("/overview", async (req, res) => {
    try {
        const auth = requireBearer(getAuthHeader(req));
        const id = (0, config_1.resolveIdentity)();
        const [datasources, resources] = await Promise.all([
            platform(auth).listDatasources(id.connectorId),
            platform(auth).listResources(id.connectorId),
        ]);
        let online = false;
        try {
            online = await (0, lite_1.getLiteClient)().nodeOnline(id.domainId);
        }
        catch { }
        res.json(wrap({ connector_id: id.connectorId, domain_id: id.domainId, online,
            datasource_count: Array.isArray(datasources) ? datasources.length : 0,
            resource_count: Array.isArray(resources) ? resources.length : 0,
            uptime_seconds: Math.floor((Date.now() - portalStartedAt) / 1000),
            lite_endpoint: id.liteKusciaEndpoint }));
    }
    catch (e) {
        sendError(res, e);
    }
});
exports.router.get("/routes", async (req, res) => {
    try {
        const auth = requireBearer(getAuthHeader(req));
        const id = (0, config_1.resolveIdentity)();
        const connectors = await platform(auth).listOwnedConnectors();
        const peers = (Array.isArray(connectors) ? connectors : []).filter((c) => c.id !== id.connectorId);
        const routes = [];
        for (const peer of peers) {
            const route = await (0, lite_1.getLiteClient)().queryRoute(id.domainId, peer.kuscia_domain_id);
            if (route)
                routes.push({ source: id.domainId, destination: peer.kuscia_domain_id, connector_id: peer.id, connector_name: peer.name, status: route.status?.status ?? route.status ?? "Unknown", raw: route });
        }
        res.json(wrap(routes));
    }
    catch (e) {
        sendError(res, e);
    }
});
exports.router.delete("/routes/:destination", async (req, res) => {
    try {
        requireBearer(getAuthHeader(req));
        await (0, lite_1.getLiteClient)().deleteRoute((0, config_1.resolveIdentity)().domainId, req.params.destination);
        res.json(wrap({ deleted: req.params.destination }));
    }
    catch (e) {
        sendError(res, e);
    }
});
// ---- 数据源：只读集合来自平台 ----
exports.router.get("/datasources", async (req, res) => {
    try {
        const auth = requireBearer(getAuthHeader(req));
        const items = await platform(auth).listDatasources((0, config_1.resolveIdentity)().connectorId);
        res.json(wrap(items));
    }
    catch (e) {
        sendError(res, e);
    }
});
exports.router.get("/resources", async (req, res) => {
    try {
        const auth = requireBearer(getAuthHeader(req));
        res.json(wrap(await platform(auth).listResources((0, config_1.resolveIdentity)().connectorId)));
    }
    catch (e) {
        sendError(res, e);
    }
});
exports.router.get("/projects", async (req, res) => {
    try {
        const auth = requireBearer(getAuthHeader(req));
        res.json(wrap(await platform(auth).listProjects((0, config_1.resolveIdentity)().connectorId)));
    }
    catch (e) {
        sendError(res, e);
    }
});
exports.router.get("/projects/:projectId", async (req, res) => {
    try {
        const auth = requireBearer(getAuthHeader(req));
        res.json(wrap(await platform(auth).getProject(req.params.projectId)));
    }
    catch (e) {
        sendError(res, e);
    }
});
exports.router.get("/jobs/:jobId/log", async (req, res) => {
    try {
        requireBearer(getAuthHeader(req));
        res.json(wrap(await (0, lite_1.getLiteClient)().queryLog(req.params.jobId, typeof req.query.task_id === 'string' ? req.query.task_id : undefined)));
    }
    catch (e) {
        sendError(res, e);
    }
});
// ---- 本节点日志 ----
//
// 全部经本机 Lite 的 KusciaAPI 读取，门户进程不需要宿主机的容器权限。
// Kuscia 的这组接口只返回本节点的日志，所以这里天然只能看到自己这台机器。
// 日志含内部地址、证书路径与请求详情，与其它受保护接口同级，一律要求 Bearer。
function queryString(value) {
    return typeof value === "string" && value !== "" ? value : undefined;
}
function requireLogPath(req) {
    const p = queryString(req.query.path);
    if (!p)
        throw new HttpError(400, "缺少 path 参数");
    return p;
}
function logLines(req, fallback) {
    const raw = Number(req.query.lines);
    if (!Number.isFinite(raw))
        return fallback;
    return Math.min(Math.max(Math.trunc(raw), 1), nodeLogs_1.MAX_TAIL_LINES);
}
exports.router.get("/logs/files", async (req, res) => {
    try {
        requireBearer(getAuthHeader(req));
        const kind = queryString(req.query.kind);
        res.json(wrap(await (0, lite_1.getLiteClient)().listNodeLogFiles(kind)));
    }
    catch (e) {
        sendError(res, e);
    }
});
exports.router.get("/logs/tail", async (req, res) => {
    try {
        requireBearer(getAuthHeader(req));
        const path = requireLogPath(req);
        const lines = logLines(req, 500);
        const collected = await (0, nodeLogs_1.readNodeLogLines)((0, lite_1.getLiteClient)(), {
            path,
            tailLines: lines,
            keyword: queryString(req.query.keyword),
        });
        res.json(wrap({
            path,
            requested_lines: lines,
            truncated: collected.length >= lines,
            lines: collected,
        }));
    }
    catch (e) {
        sendError(res, e);
    }
});
exports.router.get("/logs/stream", async (req, res) => {
    try {
        requireBearer(getAuthHeader(req));
        const path = requireLogPath(req);
        await (0, nodeLogs_1.pipeNodeLogSse)((0, lite_1.getLiteClient)(), {
            path,
            tailLines: logLines(req, 200),
            follow: true,
            keyword: queryString(req.query.keyword),
        }, req, res);
    }
    catch (e) {
        // pipeNodeLogSse 自己处理开流失败；能到这里说明鉴权或取客户端就失败了，
        // 此时响应头还没发出去。
        sendError(res, e);
    }
});
exports.router.get("/logs/download", async (req, res) => {
    try {
        requireBearer(getAuthHeader(req));
        const path = requireLogPath(req);
        const lines = logLines(req, nodeLogs_1.MAX_TAIL_LINES);
        const collected = await (0, nodeLogs_1.readNodeLogLines)((0, lite_1.getLiteClient)(), { path, tailLines: lines });
        const domain = (0, config_1.resolveIdentity)().domainId || "node";
        const base = path.split("/").filter(Boolean).pop() ?? "log";
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${domain}-${base}"`);
        res.send(collected.join("\n"));
    }
    catch (e) {
        sendError(res, e);
    }
});
exports.router.get("/audit/mirror", (_req, res) => res.json(wrap((0, auditMirror_1.readAuditMirror)())));
exports.router.post("/audit/sync", async (req, res) => {
    try {
        const auth = requireBearer(getAuthHeader(req));
        res.json(wrap(await (0, auditMirror_1.syncAuditMirror)(auth)));
    }
    catch (e) {
        sendError(res, e);
    }
});
exports.router.get("/files/status", async (_req, res) => {
    try {
        res.json(wrap(await (0, storage_1.getStorageBackend)().status()));
    }
    catch (e) {
        if (e instanceof storage_1.StorageUnavailableError) {
            // status 是前端进页面就调的探测接口，配置没做完也要给一个可渲染的结果，
            // 而不是抛错——页面据此显示"尚未就绪"而非报错弹窗。
            res.json(wrap({ available: false, message: e.message }));
        }
        else
            sendError(res, e);
    }
});
exports.router.get("/files", async (req, res) => {
    try {
        requireBearer(getAuthHeader(req));
        const relativePath = typeof req.query.path === "string" ? req.query.path : "";
        res.json(wrap(await (0, storage_1.getStorageBackend)().list(relativePath)));
    }
    catch (e) {
        sendFileError(res, e);
    }
});
exports.router.put("/files", async (req, res) => {
    try {
        requireBearer(getAuthHeader(req));
        const directory = typeof req.query.path === "string" ? req.query.path : "";
        const filename = typeof req.query.filename === "string" ? path.basename(req.query.filename) : "";
        if (!filename || filename === "." || filename === "..")
            throw new HttpError(422, "缺少合法文件名");
        const length = Number(req.headers["content-length"]) || undefined;
        await (0, storage_1.getStorageBackend)().upload(directory, filename, req, length);
        res.json(wrap({ path: path.posix.join(directory, filename) }));
    }
    catch (e) {
        sendFileError(res, e);
    }
});
// ---- 文件管理（建目录/删除/改名）----
//
// 文件服务的 4xx 由 sendFileError 原样透出：403 越权、404 不存在、409 冲突
// （同名已存在、目录非空未带 recursive）都要让用户看到具体原因。
exports.router.post("/files/mkdir", async (req, res) => {
    try {
        requireBearer(getAuthHeader(req));
        const relativePath = typeof req.body?.path === "string" ? req.body.path.trim() : "";
        if (!relativePath)
            throw new HttpError(422, "缺少目录路径");
        res.json(wrap(await (0, storage_1.getStorageBackend)().mkdir(relativePath)));
    }
    catch (e) {
        sendFileError(res, e);
    }
});
exports.router.post("/files/delete", async (req, res) => {
    try {
        requireBearer(getAuthHeader(req));
        const relativePath = typeof req.body?.path === "string" ? req.body.path.trim() : "";
        // 空路径在节点侧是"存储根"，删根会清空整个数据目录；这里先挡一道，
        // 不依赖节点的兜底。
        if (!relativePath)
            throw new HttpError(422, "缺少路径");
        const recursive = Boolean(req.body?.recursive);
        await (0, storage_1.getStorageBackend)().remove(relativePath, recursive);
        res.json(wrap({ deleted: relativePath }));
    }
    catch (e) {
        sendFileError(res, e);
    }
});
exports.router.post("/files/rename", async (req, res) => {
    try {
        requireBearer(getAuthHeader(req));
        const source = typeof req.body?.source === "string" ? req.body.source.trim() : "";
        const destination = typeof req.body?.destination === "string" ? req.body.destination.trim() : "";
        if (!source || !destination)
            throw new HttpError(422, "缺少源路径或目标路径");
        res.json(wrap(await (0, storage_1.getStorageBackend)().rename(source, destination)));
    }
    catch (e) {
        sendFileError(res, e);
    }
});
exports.router.post("/files/download-ticket", (req, res) => {
    try {
        requireBearer(getAuthHeader(req));
        const relativePath = typeof req.body?.path === "string" ? req.body.path : "";
        if (!relativePath)
            throw new HttpError(422, "缺少文件路径");
        const ticket = crypto.randomBytes(24).toString("base64url");
        downloadTickets.set(ticket, {
            filePath: relativePath,
            expiresAt: Date.now() + DOWNLOAD_TICKET_TTL_MS,
            connectorId: (0, config_1.resolveIdentity)().connectorId,
        });
        res.json(wrap({ ticket, expires_in: DOWNLOAD_TICKET_TTL_MS / 1000 }));
    }
    catch (e) {
        sendError(res, e);
    }
});
exports.router.get("/files/download", async (req, res) => {
    try {
        const ticket = typeof req.query.ticket === "string" ? req.query.ticket : "";
        const grant = downloadTickets.get(ticket);
        downloadTickets.delete(ticket);
        if (!grant || grant.expiresAt < Date.now())
            throw new HttpError(401, "下载凭证无效或已过期");
        if (!grant.connectorId || grant.connectorId !== (0, config_1.resolveIdentity)().connectorId) {
            throw new HttpError(401, "下载凭证不属于当前连接器");
        }
        const relativePath = grant.filePath;
        const file = await (0, storage_1.getStorageBackend)().download(relativePath);
        res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(path.posix.basename(relativePath))}`);
        if (file.contentType)
            res.setHeader("Content-Type", file.contentType);
        if (file.contentLength)
            res.setHeader("Content-Length", file.contentLength);
        file.stream.on("error", () => { if (!res.headersSent)
            res.status(502).end();
        else
            res.destroy(); });
        file.stream.pipe(res);
    }
    catch (e) {
        sendFileError(res, e);
    }
});
// ---- 数据源：创建（本机 Lite 建源 + 上报平台非密元数据）----
exports.router.post("/datasources", async (req, res) => {
    try {
        const auth = requireBearer(getAuthHeader(req));
        const id = (0, config_1.resolveIdentity)();
        const body = (req.body || {});
        const kusciaDsId = "ds-" + crypto.randomBytes(6).toString("hex"); // 12 位 hex
        const { kusciaInfo, uri, stored, accessDirectly } = buildKusciaInfo(body);
        // ① 本机 Lite 建 DomainDataSource（用密钥，不落库；失败 -> 502）
        try {
            await (0, lite_1.getLiteClient)().createDomainDataSource({
                domainId: id.domainId,
                datasourceId: kusciaDsId,
                type: body.type,
                name: body.name,
                info: kusciaInfo,
                accessDirectly,
            });
        }
        catch (e) {
            if (e instanceof lite_1.KusciaError) {
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
    }
    catch (e) {
        sendError(res, e);
    }
});
// ---- 数据源：删除（本机 Lite 删源 + 平台注销）----
exports.router.delete("/datasources/:platformId", async (req, res) => {
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
            await (0, lite_1.getLiteClient)().deleteDomainDataSource((0, config_1.resolveIdentity)().domainId, kusciaDatasourceId);
        }
        catch (e) {
            if (e instanceof lite_1.KusciaError) {
                throw new HttpError(502, `删除本地 Lite DomainDataSource 失败: ${e.message}`);
            }
            throw e;
        }
        // ② 平台注销记录
        const result = await platform(auth).deregisterDatasource(platformId);
        res.json(wrap(result));
    }
    catch (e) {
        sendError(res, e);
    }
});
// ---- 接入态 ----
// 有 state 时按 state；无 state 但 env 已配连接器身份，视为 onboarded（兼容 alice env 实例）。
exports.router.get("/onboarding/state", async (req, res) => {
    try {
        const envConfigured = Boolean(config_1.config.portalDomainId && config_1.config.portalConnectorId);
        const onboarded = Boolean((0, state_1.hasAnyProfile)() || envConfigured);
        // 登录页门禁需要在拿到 token 前判断走登录还是接入向导。匿名请求只返回布尔值，
        // 不暴露 connector/domain/pending；带 token 后才校验属主并返回详情。
        if (!getAuthHeader(req)) {
            res.json(wrap((0, onboardingState_1.publicOnboardingState)(onboarded)));
            return;
        }
        const auth = requireBearer(getAuthHeader(req));
        const user = await platform(auth).me();
        const username = String(user?.username ?? "");
        const profile = (0, state_1.selectedProfile)(username);
        const pending = (0, state_1.getPending)(username);
        res.json(wrap({
            onboarded: Boolean(profile),
            domain_id: profile?.domain_id,
            connector_id: profile?.connector_id,
            pending,
            connectors: (0, state_1.profilesForUser)(username),
            access_denied: onboarded && !profile,
        }));
    }
    catch (e) {
        sendError(res, e);
    }
});
// ---- 注册（驱动中心 provision：apply）----
// 列出当前用户的连接器（“已注册连接器”绕过路径用于选择要绑定的连接器）。
exports.router.get("/onboarding/connectors", async (req, res) => {
    try {
        const auth = requireBearer(getAuthHeader(req));
        const list = await platform(auth).listConnectors();
        res.json(wrap(list));
    }
    catch (e) {
        sendError(res, e);
    }
});
exports.router.get("/onboarding/discover", async (req, res) => {
    try {
        const auth = requireBearer(getAuthHeader(req));
        const connectorId = typeof req.query.connector_id === "string" ? req.query.connector_id : "";
        if (!connectorId)
            throw new HttpError(422, "缺少 connector_id");
        const { connector } = await requireConnectorOwner(auth, connectorId);
        const domain = String(connector?.kuscia_domain_id ?? "");
        const manifest = (0, connectorManifest_1.findConnectorManifest)(domain);
        if (!manifest)
            return void res.json(wrap({ detected: false, domain_id: domain, message: "未发现 connector.yaml" }));
        const certs = (0, connectorManifest_1.requiredCertFiles)(manifest.certDir);
        if (!certs.complete)
            return void res.json(wrap({ detected: false, domain_id: domain, message: `证书不完整: ${certs.missing.join(", ")}` }));
        const endpoint = manifest.liteEndpoint || `${String(connector.lite_api_endpoint).replace(/\/+$/, "")}:${connector.lite_api_port ?? 28081}`;
        try {
            await new lite_1.LiteClient(endpoint, manifest.certDir).queryDomain(domain);
        }
        catch (e) {
            return void res.json(wrap({ detected: false, domain_id: domain, message: `证书或 Lite 校验失败: ${e.message}` }));
        }
        res.json(wrap({ detected: true, domain_id: domain, lite_endpoint: endpoint, file_service_configured: Boolean(manifest.fileService) }));
    }
    catch (e) {
        sendError(res, e);
    }
});
exports.router.post("/onboarding/register", async (req, res) => {
    try {
        const auth = requireBearer(getAuthHeader(req));
        const body = (req.body || {});
        const owner = await platform(auth).me();
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
        const username = String(owner?.username ?? "");
        if (!username)
            throw new HttpError(401, "无法识别当前用户");
        (0, state_1.savePending)(username, {
            connector_id: connector?.id,
            kuscia_domain_id: connector?.kuscia_domain_id ?? body.kuscia_domain_id,
            lite_api_endpoint: body.lite_api_endpoint,
            lite_api_port: body.lite_api_port,
            owner_username: username,
        });
        res.json(wrap(connector));
    }
    catch (e) {
        sendError(res, e);
    }
});
// ---- 一键部署脚本（取中心 provision 产物；未审批时平台 409 透传）----
exports.router.get("/onboarding/deploy-script", async (req, res) => {
    try {
        const auth = requireBearer(getAuthHeader(req));
        const connectorId = req.query.connector_id;
        if (typeof connectorId !== "string" || connectorId === "") {
            throw new HttpError(422, "缺少 connector_id 查询参数");
        }
        await requireConnectorOwner(auth, connectorId);
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
        const commands = "#!/bin/bash\nset -euo pipefail\n" +
            String(info?.commands ?? "") +
            exportCerts +
            "\n";
        res.json(wrap({
            commands,
            deploy_token: info?.deploy_token,
            master_endpoint: info?.master_endpoint,
            kuscia_image: info?.kuscia_image,
        }));
    }
    catch (e) {
        sendError(res, e);
    }
});
// ---- 收尾（探活本地 Lite + 回传节点信息 + 落本地状态）----
// 上传 Lite 证书：门户把上传的证书写入自身数据根 <PORTAL_DATA_DIR>/lite/<域>/certs（门户可写）。
// files: { 文件名 -> base64 内容 }，通常为 ca.crt / kusciaapi-server.crt / kusciaapi-server.key / token。
exports.router.post("/onboarding/upload-certs", async (req, res) => {
    try {
        const auth = requireBearer(getAuthHeader(req));
        const body = (req.body || {});
        const connectorId = body.connector_id;
        if (!connectorId)
            throw new HttpError(422, "缺少 connector_id");
        const files = body.files || {};
        const names = Object.keys(files);
        if (names.length === 0)
            throw new HttpError(422, "未提供证书文件");
        // 解析目标域：pending 优先，否则回中心查询
        const { user: currentUser, connector } = await requireConnectorOwner(auth, connectorId);
        const pending = (0, state_1.getPending)(String(currentUser?.username ?? ""));
        let domain = pending && pending.connector_id === connectorId
            ? pending.kuscia_domain_id
            : undefined;
        if (!domain) {
            domain = connector?.kuscia_domain_id;
        }
        if (!domain)
            throw new HttpError(422, "无法确定连接器域");
        const manifest = (0, connectorManifest_1.findConnectorManifest)(domain);
        const discoveredCerts = manifest ? (0, connectorManifest_1.requiredCertFiles)(manifest.certDir) : null;
        const certDir = discoveredCerts?.complete ? manifest.certDir : (0, config_1.deriveLiteCertDir)(domain);
        fs.mkdirSync(certDir, { recursive: true });
        const saved = [];
        for (const name of names) {
            const safe = path.basename(name); // 防目录穿越
            if (!safe || safe === "." || safe === "..")
                continue;
            const buf = Buffer.from(files[name] ?? "", "base64");
            const mode = safe.endsWith(".key") || safe === "token" ? 0o600 : 0o644;
            fs.writeFileSync(path.join(certDir, safe), buf, { mode });
            saved.push(safe);
        }
        res.json(wrap({ cert_dir: certDir, saved }));
    }
    catch (e) {
        sendError(res, e);
    }
});
exports.router.post("/onboarding/finalize", async (req, res) => {
    try {
        const auth = requireBearer(getAuthHeader(req));
        const body = (req.body || {});
        const connectorId = body.connector_id;
        if (!connectorId) {
            throw new HttpError(422, "缺少 connector_id");
        }
        // 解析目标域：优先取 pending，否则回中心查询
        const { user: currentUser, connector } = await requireConnectorOwner(auth, connectorId);
        const username = String(currentUser?.username ?? "");
        const pending = (0, state_1.getPending)(username);
        let domain = pending && pending.connector_id === connectorId
            ? pending.kuscia_domain_id
            : undefined;
        if (!domain) {
            domain = connector?.kuscia_domain_id;
        }
        if (!domain) {
            throw new HttpError(422, "无法确定连接器域，请确认 connector_id 正确");
        }
        // 按约定推导 Lite 位置，用户无需手填：
        //   证书目录 = <PORTAL_DATA_DIR>/lite/<域>/certs（部署脚本已把 Lite 证书导出到此）
        //   endpoint = <注册时填写的物理地址>:<Lite KusciaAPI 端口>（支持跨机）
        const manifest = (0, connectorManifest_1.findConnectorManifest)(domain);
        const discoveredCerts = manifest ? (0, connectorManifest_1.requiredCertFiles)(manifest.certDir) : null;
        const certDir = discoveredCerts?.complete ? manifest.certDir : (0, config_1.deriveLiteCertDir)(domain);
        // endpoint：已注册连接器路径可显式指定；新注册路径使用登记的物理地址和端口。
        let liteEndpoint = body.lite_kuscia_endpoint || manifest?.liteEndpoint;
        if (!liteEndpoint) {
            let apiBase = pending && pending.connector_id === connectorId
                ? pending.lite_api_endpoint
                : undefined;
            let apiPort = pending && pending.connector_id === connectorId
                ? pending.lite_api_port
                : undefined;
            if (!apiBase || !apiPort) {
                apiBase = apiBase || connector?.lite_api_endpoint;
                apiPort = connector?.lite_api_port;
            }
            const base = String(apiBase || "https://127.0.0.1")
                .replace(/^(https?):\/+/, "$1://")
                .replace(/\/+$/, "");
            // 注册表单约定 lite_api_endpoint 不含 API 端口；若用户已显式带端口则原样使用。
            liteEndpoint = /^https?:\/\/[^/]+:\d+$/.test(base)
                ? base
                : `${base}:${apiPort ?? 28081}`;
        }
        // ① 用本机 Lite 证书构 LiteClient 探活（读证书失败/不可达 -> 502）
        try {
            const client = new lite_1.LiteClient(liteEndpoint, certDir);
            await client.queryDomain(domain);
        }
        catch (e) {
            throw new HttpError(502, `Lite 不可达，请确认已部署并起动: ${e?.message ?? String(e)}`);
        }
        // ② 回传节点物理信息给中心（供 CDR / 在线态派生）
        if (body.node) {
            await platform(auth).reportNodeInfo(connectorId, body.node);
        }
        // ③ 落本地状态：标记 onboarded，清除 pending
        (0, state_1.saveProfile)(username, {
            domain_id: domain,
            connector_id: connectorId,
            lite_kuscia_endpoint: liteEndpoint,
            lite_cert_dir: certDir,
        });
        (0, state_1.clearPending)(username);
        res.json(wrap({ onboarded: true, connector_id: connectorId, domain_id: domain }));
    }
    catch (e) {
        sendError(res, e);
    }
});
//# sourceMappingURL=routes.js.map