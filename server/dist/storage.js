"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.StorageRequestError = exports.StorageUnavailableError = void 0;
exports.getStorageBackend = getStorageBackend;
const axios_1 = __importDefault(require("axios"));
const connectorManifest_1 = require("./connectorManifest");
const config_1 = require("./config");
class StorageUnavailableError extends Error {
}
exports.StorageUnavailableError = StorageUnavailableError;
/** 文件服务返回的错误，带它的 HTTP 状态码，供路由层原样透出。 */
class StorageRequestError extends Error {
    constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
        this.name = "StorageRequestError";
    }
}
exports.StorageRequestError = StorageRequestError;
/**
 * 解析文件服务的接入信息：connector.yaml 的 fileService 段优先，其次环境变量
 * （在跑的门户容器全靠 env 配置，没有 PORTAL_HOME 下的 connector.yaml）。
 *
 * serviceHost 没配时按部署脚本的命名规则推导，省掉一处一定会手抄错的配置。
 */
function resolveTarget() {
    const identity = (0, config_1.resolveIdentity)();
    const domain = identity.domainId;
    if (!domain) {
        throw new StorageUnavailableError("门户尚未绑定连接器，无法确定文件服务所在的节点");
    }
    const manifest = (() => {
        try {
            return (0, connectorManifest_1.findConnectorManifest)(domain);
        }
        catch {
            // connector.yaml 写坏了不该让整个页面报错，退回 env 继续试。
            return null;
        }
    })();
    const endpoint = (manifest?.fileService?.endpoint || config_1.config.fileServiceEndpoint || "").replace(/\/+$/, "");
    const token = manifest?.fileService?.token || config_1.config.fileServiceToken || "";
    const serviceHost = manifest?.fileService?.serviceHost ||
        config_1.config.fileServiceServiceHost ||
        `filesvc-${domain}-http.${domain}.svc`;
    if (!endpoint) {
        throw new StorageUnavailableError(`尚未配置连接器 ${domain} 的文件服务地址。请先部署（deploy/file-service/deploy.sh ${domain}），再把它打印的 fileService 配置填入 connector.yaml 或环境变量`);
    }
    if (!token) {
        throw new StorageUnavailableError(`尚未配置连接器 ${domain} 的文件服务访问令牌`);
    }
    return { endpoint, serviceHost, sourceDomain: domain, token };
}
/**
 * 本节点的外挂文件服务（由 Kuscia 调度的常驻服务，见 deploy/file-service）。
 *
 * 请求不是直接打服务，而是打**本机 Lite 的域网关**，靠两个头让它路由过去：
 *   Host          → 选中这个服务的 virtual host
 *   Kuscia-Source → 端口 scope 的强制点。域内 pod 发来的请求由 envoy 自动打上；
 *                   门户在容器外，必须自己带，否则匹配不上路由、拿到的是 404
 *                   （看起来像"服务没起来"）。
 * 之所以走网关而不是直连：服务监听的是 Kuscia 动态分配的端口，没有固定地址。
 */
class NodeFileServiceBackend {
    constructor(target) {
        this.target = target;
        this.client = axios_1.default.create({
            baseURL: target.endpoint,
            proxy: false,
            headers: {
                Host: target.serviceHost,
                "Kuscia-Source": target.sourceDomain,
                Authorization: `Bearer ${target.token}`,
            },
            // 上传下载都是流式且可能很大：
            //  - maxBodyLength 默认 10MB，不放开的话大文件在门户客户端就被拒，根本到不了节点
            //  - timeout 默认值会把长传输掐断
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 0,
            // 4xx/5xx 自己判断，好把服务端的 detail 与状态码一起带出去。
            validateStatus: () => true,
        });
    }
    /**
     * 文件服务的错误体一定是 `{"detail": "..."}`。响应体不是这个形状，就说明请求
     * 根本没到服务 —— 网关上没有这条路由（服务没部署），或者 Host / Kuscia-Source
     * 不对。这两种 404 必须分开：否则"该节点没部署文件服务"会显示成"目录不存在"，
     * 把人往完全错误的方向引。
     */
    detailOf(resp) {
        if (resp.data && typeof resp.data === "object" && typeof resp.data.detail === "string") {
            return resp.data.detail;
        }
        return undefined;
    }
    notFromService(status) {
        return new StorageUnavailableError(`请求没有到达文件服务（网关 ${this.target.endpoint} 返回 HTTP ${status}，Host ${this.target.serviceHost}）。` +
            `通常是该节点还没部署文件服务：deploy/file-service/deploy.sh ${this.target.sourceDomain}`);
    }
    /** 把响应统一成"成功取 data，失败抛错"。 */
    unwrap(resp, _what) {
        if (resp.status >= 200 && resp.status < 300)
            return resp.data;
        const detail = this.detailOf(resp);
        if (detail === undefined)
            throw this.notFromService(resp.status);
        throw new StorageRequestError(detail, resp.status);
    }
    /** 网关/服务不可达时给出可操作的提示，而不是把 axios 的原文抛给用户。 */
    unreachable(e) {
        if (e instanceof StorageRequestError)
            return e;
        return new StorageUnavailableError(`文件服务不可达（${this.target.endpoint}，Host ${this.target.serviceHost}）：${e?.message ?? e}。` +
            `请确认该节点上的文件服务在跑：deploy/file-service/deploy.sh ${this.target.sourceDomain}`);
    }
    async status() {
        const base = { endpoint: this.target.endpoint, service_host: this.target.serviceHost };
        try {
            // 用 /readyz 而不是 /healthz：token 没配上时进程活着、/healthz 也 200，
            // 但所有操作都会 401。readyz 会把这种情况判成 503。
            const resp = await this.client.get("/readyz");
            if (resp.status >= 200 && resp.status < 300) {
                return { ...base, available: true, message: "节点文件服务可用" };
            }
            const detail = this.detailOf(resp);
            return {
                ...base,
                available: false,
                // 服务自己回的（有 detail）= 起来了但配置不全；否则 = 请求没到服务。
                message: detail ? `节点文件服务未就绪：${detail}` : this.notFromService(resp.status).message,
            };
        }
        catch (e) {
            return { ...base, available: false, message: this.unreachable(e).message };
        }
    }
    async list(relativePath) {
        let resp;
        try {
            resp = await this.client.get("/api/v1/files", { params: { path: relativePath } });
        }
        catch (e) {
            throw this.unreachable(e);
        }
        const data = this.unwrap(resp, "列举目录");
        const files = Array.isArray(data?.files) ? data.files : [];
        return {
            files: files.map((f) => ({
                name: String(f?.name ?? ""),
                path: String(f?.path ?? ""),
                type: f?.type === "directory" ? "directory" : "file",
                size: typeof f?.size === "number" ? f.size : undefined,
                modified_at: f?.modified_at || undefined,
            })),
            truncated: Boolean(data?.truncated),
        };
    }
    async upload(directory, filename, body, contentLength) {
        let resp;
        try {
            resp = await this.client.put("/api/v1/files", body, {
                params: { path: directory, filename },
                headers: {
                    "Content-Type": "application/octet-stream",
                    ...(contentLength !== undefined ? { "Content-Length": contentLength } : {}),
                },
            });
        }
        catch (e) {
            throw this.unreachable(e);
        }
        this.unwrap(resp, "上传");
    }
    async download(relativePath) {
        let resp;
        try {
            resp = await this.client.get("/api/v1/files/content", {
                params: { path: relativePath },
                responseType: "stream",
            });
        }
        catch (e) {
            throw this.unreachable(e);
        }
        if (resp.status < 200 || resp.status >= 300) {
            // responseType=stream 时错误体也是流，先收完再取 detail，否则只能报一个
            // 光秃秃的状态码。错误体很小，不存在内存风险。
            const body = await readStreamAsText(resp.data).catch(() => "");
            let detail;
            try {
                const parsed = JSON.parse(body);
                if (parsed && typeof parsed.detail === "string")
                    detail = parsed.detail;
            }
            catch {
                /* 不是 JSON：说明不是文件服务回的 */
            }
            if (detail === undefined)
                throw this.notFromService(resp.status);
            throw new StorageRequestError(detail, resp.status);
        }
        return {
            stream: resp.data,
            contentType: typeof resp.headers["content-type"] === "string" ? resp.headers["content-type"] : undefined,
            contentLength: Number(resp.headers["content-length"]) || undefined,
        };
    }
    async mkdir(relativePath) {
        let resp;
        try {
            resp = await this.client.post("/api/v1/files/mkdir", { path: relativePath });
        }
        catch (e) {
            throw this.unreachable(e);
        }
        return normalizeEntry(this.unwrap(resp, "创建目录"));
    }
    async remove(relativePath, recursive) {
        let resp;
        try {
            resp = await this.client.post("/api/v1/files/delete", { path: relativePath, recursive });
        }
        catch (e) {
            throw this.unreachable(e);
        }
        this.unwrap(resp, "删除");
    }
    async rename(source, destination) {
        let resp;
        try {
            resp = await this.client.post("/api/v1/files/rename", { source, destination });
        }
        catch (e) {
            throw this.unreachable(e);
        }
        return normalizeEntry(this.unwrap(resp, "重命名"));
    }
}
function normalizeEntry(raw) {
    return {
        name: String(raw?.name ?? ""),
        path: String(raw?.path ?? ""),
        type: raw?.type === "directory" ? "directory" : "file",
        size: typeof raw?.size === "number" ? raw.size : undefined,
        modified_at: raw?.modified_at || undefined,
    };
}
function readStreamAsText(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        stream.on("data", (chunk) => {
            // 上限兜底：正常错误体只有几十字节，异常情况下也不该无上限缓冲。
            if (size < 64 * 1024) {
                chunks.push(chunk);
                size += chunk.length;
            }
        });
        stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        stream.on("error", reject);
    });
}
function getStorageBackend() {
    return new NodeFileServiceBackend(resolveTarget());
}
//# sourceMappingURL=storage.js.map