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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LiteClient = exports.KusciaError = void 0;
exports.getLiteClient = getLiteClient;
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
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const https = __importStar(require("https"));
const crypto_1 = require("crypto");
const axios_1 = __importDefault(require("axios"));
const config_1 = require("./config");
class KusciaError extends Error {
    constructor(message) {
        super(message);
        this.name = "KusciaError";
    }
}
exports.KusciaError = KusciaError;
/**
 * protojson 把 int64 序列化成字符串（"283"），int32 才是数字。
 * 不做归一化的话前端拿到的 size 会是字符串，排序和格式化都会出错。
 */
function toNumber(value) {
    const n = typeof value === "string" ? Number(value) : value;
    return Number.isFinite(n) ? n : 0;
}
function normalizeLogFile(raw) {
    const pod = raw.pod
        ? {
            namespace: String(raw.pod.namespace ?? ""),
            pod_name: String(raw.pod.pod_name ?? ""),
            container: String(raw.pod.container ?? ""),
            restart_count: toNumber(raw.pod.restart_count),
        }
        : undefined;
    return {
        path: String(raw.path ?? ""),
        name: String(raw.name ?? ""),
        kind: raw.kind === "pod" ? "pod" : "component",
        category: String(raw.category ?? "other"),
        size: toNumber(raw.size),
        modified_time: toNumber(raw.modified_time),
        rotated: Boolean(raw.rotated),
        compressed: Boolean(raw.compressed),
        pod,
    };
}
class LiteClient {
    constructor(endpoint, certDir) {
        this.endpoint = (endpoint ?? config_1.config.liteKusciaEndpoint).replace(/\/+$/, "");
        const dir = certDir ?? config_1.config.liteCertDir;
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
        this.client = axios_1.default.create({
            baseURL: this.endpoint,
            httpsAgent: agent,
            timeout: 10000,
            headers: { Token: token, "Content-Type": "application/json" },
            // 只走显式 Agent，不吃环境代理（对应 httpx trust_env=False）
            proxy: false,
        });
    }
    async post(apiPath, payload) {
        let data;
        try {
            const resp = await this.client.post(apiPath, payload);
            data = resp.data;
        }
        catch (e) {
            // 网络/TLS/HTTP 错误
            const msg = e?.response?.data && typeof e.response.data === "object"
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
    async queryDomain(domainId) {
        return this.post("/api/v1/domain/query", { domain_id: domainId });
    }
    /** 有就绪工作节点即视为 online。 */
    async nodeOnline(domainId) {
        const resp = await this.queryDomain(domainId);
        const d = (resp && resp.data) || {};
        const statuses = d.node_statuses || [];
        return Array.isArray(statuses) && statuses.length > 0;
    }
    // ---- DomainDataSource（数据源，只能由本域 Lite 处理）----
    async createDomainDataSource(args) {
        await this.post("/api/v1/domaindatasource/create", {
            domain_id: args.domainId,
            datasource_id: args.datasourceId,
            type: args.type,
            name: args.name,
            info: args.info,
            access_directly: args.accessDirectly ?? true,
        });
    }
    async deleteDomainDataSource(domainId, datasourceId) {
        await this.post("/api/v1/domaindatasource/delete", {
            domain_id: domainId,
            datasource_id: datasourceId,
        });
    }
    async queryRoute(source, destination) {
        try {
            return (await this.post("/api/v1/route/query", { source, destination }))?.data ?? null;
        }
        catch (e) {
            if (String(e).toLowerCase().includes("not found") || String(e).toLowerCase().includes("not exist"))
                return null;
            throw e;
        }
    }
    async deleteRoute(source, destination) {
        try {
            await this.post("/api/v1/route/delete", { source, destination });
        }
        catch (e) {
            const m = String(e).toLowerCase();
            if (!m.includes("not found") && !m.includes("not exist"))
                throw e;
        }
    }
    /** Kuscia Lite Log API：按作业/任务查询本域运行日志与状态。 */
    async queryLog(jobId, taskId) {
        // Kuscia Lite 1.0 使用 task log endpoint；job_id 仅作为兼容输入，实际查询键为 task_id。
        return this.post("/api/v1/log/task/query", {
            task_id: taskId || jobId || "",
        });
    }
    // ---- 本节点日志（组件日志 + 任务容器日志）----
    //
    // 这两个接口只返回接收请求的那个节点上的日志，Kuscia 不会替我们转发到别的
    // 节点。门户绑定单个 Lite，因此连接器运维只看得到自己这台机器的日志。
    async listNodeLogFiles(kind) {
        const resp = await this.post("/api/v1/log/node/files", { kind: kind ?? "" });
        const data = (resp && resp.data) || {};
        const files = Array.isArray(data.files) ? data.files : [];
        return {
            domain_id: String(data.domain_id ?? ""),
            node_name: String(data.node_name ?? ""),
            run_mode: String(data.run_mode ?? ""),
            files: files.map(normalizeLogFile),
        };
    }
    /**
     * 打开日志流。返回的是 Kuscia 的 chunked 响应体（背靠背的 JSON 对象），
     * 由调用方用 splitJsonObjects 切分。
     *
     * timeout 必须显式置 0：客户端实例上的 10 秒超时会把 follow 流掐断。
     */
    async openNodeLogStream(query, signal) {
        try {
            const resp = await this.client.post("/api/v1/log/node/log/query", {
                path: query.path,
                tail_lines: query.tailLines ?? 0,
                follow: Boolean(query.follow),
                keyword: query.keyword ?? "",
            }, { responseType: "stream", timeout: 0, signal });
            return resp.data;
        }
        catch (e) {
            const msg = e?.message ?? String(e);
            throw new KusciaError(msg);
        }
    }
}
exports.LiteClient = LiteClient;
// Cache clients by endpoint/cert directory *and certificate fingerprint*.
// Re-deploying the same domain normally reuses both paths but overwrites its
// credentials.  Keying only by the paths kept an https.Agent holding the old
// certificate until Portal restart, making a healthy replacement appear
// offline.
const clientCache = new Map();
function credentialRevision(certDir) {
    return ["ca.crt", "kusciaapi-server.crt", "kusciaapi-server.key", "token"]
        .map((name) => {
        try {
            const content = fs.readFileSync(path.join(certDir, name));
            return `${name}:${(0, crypto_1.createHash)("sha256").update(content).digest("hex")}`;
        }
        catch {
            return `${name}:missing`;
        }
    })
        .join("|");
}
/**
 * 本机 Lite KusciaAPI 客户端（门户绑定单域）。身份经 resolveIdentity 解析
 * （onboarded 取 state，否则回退 env），据此缓存/复用实例。
 */
function getLiteClient() {
    const id = (0, config_1.resolveIdentity)();
    const identityKey = `${id.liteKusciaEndpoint}|${id.liteCertDir}`;
    const key = `${identityKey}|${credentialRevision(id.liteCertDir)}`;
    let c = clientCache.get(key);
    if (!c) {
        c = new LiteClient(id.liteKusciaEndpoint, id.liteCertDir);
        // Keep at most one credential generation for this endpoint/path.
        for (const oldKey of clientCache.keys()) {
            if (oldKey.startsWith(`${identityKey}|`))
                clientCache.delete(oldKey);
        }
        clientCache.set(key, c);
    }
    return c;
}
//# sourceMappingURL=lite.js.map