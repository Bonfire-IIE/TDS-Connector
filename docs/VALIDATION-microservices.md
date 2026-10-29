# 微服务迁移验证记录

日期：2026-10-24。已完成 ICBC/CERT-BJ 新 Portal、独立 DI/DR/TS 与两个 FTP Kuscia 的部署切换；49 个历史 Portal 容器已移除。TS 源码目录未修改。部署清单与脱敏证据见 [部署记录](../../../release/portal-microservices-20261024/README.md)。

## 最终资源语义与 Master-Lite 验收

最终部署见 [资源职责与 Master-Lite](../../../release/resource-masterlite-20261024/README.md)。中心 98 项测试通过；DR 64 passed、5 skipped；Portal 原 93 项及追加 2 项边界测试通过。Portal 类型检查和两端生产构建通过；中心全量类型检查仍有既有错误。

真实验证覆盖用户资源隔离、中心撤回/幂等 DELETE、边缘删除不删源数据、中心停机及同步 worker 重启后自动恢复。Master 和两个 Lite 重建后再次完成双边 PSI，实际 CSV 交集为 2、3。新架构不由边缘自治调度。

## 第一阶段已执行验证

- 最终合并回归：**204 passed，0 skipped**，耗时 46.23 秒；其中 Portal 93 项、DI 111 项。存在 2 条弃用警告，无失败。
- Portal Python 回归，覆盖连接器认证、服务代理、旧路由退出、fresh database、身份单独导入、计算准备、失响应恢复、Kuscia 编排及节点运维。
- DI 测试在独立 SeaTunnel/FTP 网络中执行：数据库/结构化/二进制任务、不同格式、空文件、大文件、取消、恢复、隔离、文件操作及计算交付。
- 新增真实计算交付测试：DI 加密落库 -> worker -> SeaTunnel LocalFile -> FTP，下载核对 CSV 表头及两行数据，检查终态凭据已清除。
- TypeScript `tsc --noEmit` 和 Vite production build 均通过。构建输出使用 `/tmp/portal-microservices-web`，既有 web/dist 属于此前制品，未拿它当新制品。Vite 提示 bundle 体积偏大，不影响构建成功。
- Chromium 自动化：数据源登记、DI 创建任务不自动执行/幂等键、DR 探测信息项和登记/If-Match、TS 一次性访问凭证关闭清除、只读用户操作隐藏。接口使用明确测试 fixture，不声称是在线 TS 验收；无浏览器运行错误。
- 独立 Compose 配置使用示例环境文件及占位镜像执行 `docker compose config --quiet`，语法验证通过。最终部署另使用 release 目录中三个 Compose 文件，`compose.sh config --quiet` 通过。

## 复现

Portal（Python 3.12，安装项目测试依赖）：

```bash
cd src/connector_portal
PYTHONPATH=python pytest python/tests -q
npm ci
./node_modules/.bin/tsc --noEmit -p web/tsconfig.json
npm run build
```

DI 基础测试：

```bash
cd src/cnt-services
PYTHONPATH=shared:data-integration pytest tests -q
```

真实测试需独立 SeaTunnel、FTP 以及测试 runner/SeaTunnel 同路径的共享目录。设置 `DI_TEST_SEATUNNEL_URL`，同时设置 `COMPUTE_TEST_SEATUNNEL_URL`、`COMPUTE_TEST_FTP_HOST`、`COMPUTE_TEST_FTP_USER`、`COMPUTE_TEST_FTP_PASSWORD`；按需设置 COMPUTE_TEST_FTP_PORT，默认 21。使用专属空目录作为 `pytest --basetemp`，不要指向业务数据。

本次使用 `bonfire/seatunnel:2.3.8-di-slim-20261023` 和一次性 FTP 容器，测试依赖来自已有 Portal Python 3.12 镜像。未下载或更改宿主机 Python。

浏览器测试使用 Node + Playwright/Chromium：

```bash
npm run dev --workspace web -- --host 127.0.0.1 --port 18731
# 另一个终端；Playwright 可从独立测试目录安装。
PLAYWRIGHT_MODULE=/path/to/playwright CHROMIUM_PATH=/path/to/chrome \
  node web/tests/microservices.browser.cjs
```

测试 URL 默认 http://127.0.0.1:18731，可用 PORTAL_BROWSER_URL 修改。Chromium 所需系统库须在测试环境中可用。

## 已完成的部署验收

- ICBC http://10.26.174.75:8211；CERT-BJ http://10.26.174.75:8212。两端真实登录，六个主要页面无 pageerror、无失败 HTTP 请求，不使用 mock。
- 五类真实源：LocalFS/JDBC/FTP/S3/SFTP；DR 幂等、版本、If-Match、locator 边界。
- 两方公开资源经中心 admin 审批后 sync；DR locator→DI/SeaTunnel→各自新 FTP Kuscia→DomainData 与 SHA256 检查通过。
- 双方新数据签约、调度与 PSI 实跑成功：run `d0d0cd59-87f4-4613-8d44-11f145ae6d1a`；job `kuscia-cf83762d528cc269378f50305997`。直接读取 CERT 结果文件，CSV 为 `id\n2\n3\n`，符合预期交集。首轮缺提供方 AppImage 的失败在补齐两端登记后重新运行通过。
- TS 镜像 `bonfire/transit-storage:demand-preload-20261024` 真实 HMAC v2、幂等、入仓、grant、签名下载与 SHA256、一次性访问、释放、生命周期、双主体审批和物理清理通过；CERT 独立仓库及双向租户隔离 404 通过。
- DI 7 个计算搬运终态均成功，临时凭据非空数 0。
- 身份导入过滤嵌套历史执行索引的追加回归：6 passed；新 Portal 库仅含 3 个业务表。

## 验收边界

测试使用合成数据、现有测试源与 MinIO。未执行长期负载/灾备演练、外部云 OSS 生产 IAM 验收。TS 新增 data-requests/preloads 等业务入口仍由并行任务负责，不属于本次 Portal 管理面页面范围。旧资源/合约未自动迁入新微服务数据集。
