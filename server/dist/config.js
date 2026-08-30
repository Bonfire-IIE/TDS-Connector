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
exports.config = void 0;
exports.deriveLiteCertDir = deriveLiteCertDir;
exports.resolveIdentity = resolveIdentity;
exports.identityFromProfile = identityFromProfile;
/**
 * 门户配置（12-factor：环境变量优先，给与 FastAPI 原型一致的默认值）。
 *
 * 门户实例绑定单个连接器域；部署时经环境变量注入（无前缀），
 * 如 PORTAL_DOMAIN_ID / LITE_KUSCIA_ENDPOINT / PLATFORM_API_BASE ...
 * 对齐原型 app/core/config.py 的默认值。
 */
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const dotenv = __importStar(require("dotenv"));
const requestIdentity_1 = require("./requestIdentity");
dotenv.config();
function env(name, fallback) {
    const v = process.env[name];
    return v !== undefined && v !== "" ? v : fallback;
}
function num(name, fallback) {
    const v = process.env[name];
    if (v === undefined || v === "")
        return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}
function bool(name, fallback) {
    const v = process.env[name];
    if (v === undefined || v === "")
        return fallback;
    return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}
function httpsMode() {
    const mode = env("TRANSPORT_MODE", "http").toLowerCase();
    // REQUIRE_HTTPS 保留为旧部署兼容开关；新部署只需切 TRANSPORT_MODE。
    return mode === "https" || bool("REQUIRE_HTTPS", false);
}
exports.config = {
    // 绑定的连接器（域）与平台连接器 id。
    // **默认留空**：全新下载的门户无身份 → onboarding/state 判为未接入 → 走接入向导。
    // 已接入的实例经本地 state 提供身份；dev 联调实例经 env 显式注入。
    portalDomainId: env("PORTAL_DOMAIN_ID", ""),
    portalConnectorId: env("PORTAL_CONNECTOR_ID", ""),
    // 本地 Lite KusciaAPI（mTLS，用本机 Lite 证书；经 IP 访问，故关 hostname 校验）
    liteKusciaEndpoint: env("LITE_KUSCIA_ENDPOINT", "https://127.0.0.1:28081"),
    // 证书目录：**默认留空**——接入后由门户按约定推导(deriveLiteCertDir)并落 state；
    // dev 联调实例经 LITE_CERT_DIR 显式注入。内含 kusciaapi-server.crt/key / ca.crt / token。
    liteCertDir: env("LITE_CERT_DIR", ""),
    // 本地 LFS 存储卷根（localfs 数据源默认落点，仅展示/推导用）
    storageRoot: env("STORAGE_ROOT", "/home/kuscia/var/storage/data"),
    // 外挂文件服务（deploy/file-service 部署的 Kuscia 常驻服务）。
    // connector.yaml 的 fileService 段优先，这里是容器化部署用的等价 env——
    // 在跑的门户容器全靠 env 配置，没有 PORTAL_HOME 下的 connector.yaml。
    //
    // fileServiceEndpoint 是**本机 Lite 的域网关**地址（宿主机上的 80 端口映射），
    // 不是服务自己的地址：服务跑在 Kuscia 分配的动态端口上，只能经网关按
    // serviceHost 路由过去。
    fileServiceEndpoint: env("FILE_SERVICE_ENDPOINT", "").replace(/\/+$/, ""),
    fileServiceServiceHost: env("FILE_SERVICE_SERVICE_HOST", ""),
    fileServiceToken: env("FILE_SERVICE_TOKEN", ""),
    // 平台 API（HTTP，上报/读取中心侧数据源；调用时透传前端 Bearer）
    platformApiBase: env("PLATFORM_API_BASE", "http://127.0.0.1:8000/api/v1"),
    // master 节点认证端口（仅连通展示用）
    masterEndpoint: env("MASTER_ENDPOINT", "https://10.26.174.75:18080"),
    // 门户监听端口
    port: num("PORT", 8100),
    // 前端构建产物目录（默认解析到 ../web/dist 的绝对路径）
    webDist: env("WEB_DIST", path.resolve(__dirname, "..", "..", "web", "dist")),
    // 门户数据根（state + 部署脚本导出的 Lite 证书按 <root>/lite/<域>/certs 落）。
    // 默认用户主目录下 ~/.bonfire-connector——跑门户的用户天然可写，无需 /home 或 root 权限；
    // 可经 PORTAL_DATA_DIR 指向任意可写目录（如挂载卷）。
    portalDataDir: env("PORTAL_DATA_DIR", path.join(os.homedir(), ".bonfire-connector")),
    // 安装根：连接器清单位于 <PORTAL_HOME>/connectors/<domain>/connector.yaml。
    portalHome: env("PORTAL_HOME", path.join(os.homedir(), ".bonfire-connector")),
    // 生产必须由 TLS 反代接入；应用依据 X-Forwarded-Proto 拒绝明文认证请求。
    requireHttps: httpsMode(),
    trustProxy: bool("TRUST_PROXY", httpsMode()),
};
/**
 * 按约定推导某域的本地 Lite 证书目录：<PORTAL_DATA_DIR>/lite/<domain>/certs。
 * 门户生成的部署脚本会把 Lite 证书导出到此路径；finalize 据此免用户手填。
 */
function deriveLiteCertDir(domain) {
    return path.join(exports.config.portalDataDir, "lite", domain, "certs");
}
/**
 * 统一身份解析：onboarded 时优先取 state（缺项回退 env），否则全取 env。
 * routes / lite 客户端一律经此取身份，避免直接读 config 的静态默认值。
 */
function resolveIdentity() {
    const scoped = (0, requestIdentity_1.requestIdentity)();
    if (scoped)
        return scoped;
    const certPath = (p) => {
        if (!p)
            return exports.config.liteCertDir;
        // state may have been written on the host before the portal was containerized;
        // remap its persisted host data root to the mounted /data root.
        const hostRoot = "/home/bonfire-tds/src/connector_portal/.data";
        if (p.startsWith(hostRoot))
            return path.join(exports.config.portalDataDir, p.slice(hostRoot.length).replace(/^\/+/, ""));
        return p;
    };
    return {
        domainId: exports.config.portalDomainId,
        connectorId: exports.config.portalConnectorId,
        liteKusciaEndpoint: exports.config.liteKusciaEndpoint,
        liteCertDir: exports.config.liteCertDir,
    };
}
function identityFromProfile(profile) {
    return {
        domainId: profile.domain_id,
        connectorId: profile.connector_id,
        liteKusciaEndpoint: profile.lite_kuscia_endpoint || exports.config.liteKusciaEndpoint,
        liteCertDir: profile.lite_cert_dir || exports.config.liteCertDir || deriveLiteCertDir(profile.domain_id),
    };
}
//# sourceMappingURL=config.js.map