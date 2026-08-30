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
exports.app = void 0;
/**
 * 门户后端入口：单端口既出 API（/portal/*, /health）又出前端页面（托管 WEB_DIST）。
 * 对齐原型：/portal 路由 + 健康检查；额外承担前端静态托管与 SPA 回退（单制品部署关键）。
 */
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const express_1 = __importDefault(require("express"));
const config_1 = require("./config");
const routes_1 = require("./routes");
const app = (0, express_1.default)();
exports.app = app;
if (config_1.config.trustProxy)
    app.set("trust proxy", 1);
app.use(express_1.default.json({ limit: "5mb" })); // 上限放宽以容纳证书上传(base64)
app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (req.secure)
        res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    if (req.path === "/portal/login" || req.path.startsWith("/portal/onboarding")) {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Pragma", "no-cache");
    }
    if (config_1.config.requireHttps && !req.secure && req.path !== "/health") {
        res.status(426).json({ detail: "此服务仅允许通过 HTTPS 访问" });
        return;
    }
    next();
});
// ---- API 路由 ----
app.use("/portal", routes_1.router);
// ---- 健康检查 ----
app.get("/health", (_req, res) => {
    res.status(200).json({ code: 0, message: "ok", data: { status: "healthy" } });
});
// ---- 托管前端（单制品）：静态资源 + SPA 回退 ----
const webDist = config_1.config.webDist;
const indexHtml = path.join(webDist, "index.html");
const hasWeb = fs.existsSync(indexHtml);
if (hasWeb) {
    app.use(express_1.default.static(webDist));
    // SPA 回退：非 /portal、非 /health、非已命中静态资源的 GET -> index.html
    app.get("*", (req, res, next) => {
        if (req.path.startsWith("/portal") || req.path.startsWith("/health")) {
            return next();
        }
        res.sendFile(indexHtml);
    });
    console.log(`[portal-server] serving web dist from ${webDist}`);
}
else {
    console.warn(`[portal-server] WEB_DIST 不存在，跳过静态托管：${webDist}（仅提供 API）`);
}
app.listen(config_1.config.port, () => {
    console.log(`[portal-server] listening on :${config_1.config.port}`);
    console.log(`[portal-server] domain=${config_1.config.portalDomainId} connector=${config_1.config.portalConnectorId}`);
    console.log(`[portal-server] lite=${config_1.config.liteKusciaEndpoint} platform=${config_1.config.platformApiBase}`);
});
//# sourceMappingURL=index.js.map