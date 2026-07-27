/**
 * 门户后端入口：单端口既出 API（/portal/*, /health）又出前端页面（托管 WEB_DIST）。
 * 对齐原型：/portal 路由 + 健康检查；额外承担前端静态托管与 SPA 回退（单制品部署关键）。
 */
import * as fs from "fs";
import * as path from "path";
import express, { Request, Response } from "express";

import { config } from "./config";
import { router as portalRouter } from "./routes";

const app = express();
app.use(express.json({ limit: "5mb" })); // 上限放宽以容纳证书上传(base64)

// ---- API 路由 ----
app.use("/portal", portalRouter);

// ---- 健康检查 ----
app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ code: 0, message: "ok", data: { status: "healthy" } });
});

// ---- 托管前端（单制品）：静态资源 + SPA 回退 ----
const webDist = config.webDist;
const indexHtml = path.join(webDist, "index.html");
const hasWeb = fs.existsSync(indexHtml);

if (hasWeb) {
  app.use(express.static(webDist));
  // SPA 回退：非 /portal、非 /health、非已命中静态资源的 GET -> index.html
  app.get("*", (req: Request, res: Response, next) => {
    if (req.path.startsWith("/portal") || req.path.startsWith("/health")) {
      return next();
    }
    res.sendFile(indexHtml);
  });
  console.log(`[portal-server] serving web dist from ${webDist}`);
} else {
  console.warn(
    `[portal-server] WEB_DIST 不存在，跳过静态托管：${webDist}（仅提供 API）`
  );
}

app.listen(config.port, () => {
  console.log(`[portal-server] listening on :${config.port}`);
  console.log(
    `[portal-server] domain=${config.portalDomainId} connector=${config.portalConnectorId}`
  );
  console.log(`[portal-server] lite=${config.liteKusciaEndpoint} platform=${config.platformApiBase}`);
});

export { app };
