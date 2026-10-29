# Portal 微服务切换

2026-10-24 已完成部署切换，入口为 ICBC http://10.26.174.75:8211 和 CERT-BJ http://10.26.174.75:8212。实际镜像、Compose 命令、备份和验收证据见 [部署记录](../../../release/resource-masterlite-20261024/README.md)。

本次为不兼容切换。Portal 统一登录与导航，正式数据界面使用 DI、DR、TS HTTP 接口；服务自带页面仍只用于演示。现有 TS 改造由另一任务负责，本改造不写入 `transit-storage/`。

## 资源与调度职责（最终切换）

资源仅由连接器经 DR 登记；中心接收私有目录投影，无资源登记表单。普通用户仅见自己的资源，跨参与方发现的是已发布产品。中心下架和 DELETE 都撤回投影；边缘 DELETE 删除资源登记、绑定和版本，保留审计及 DI 原始数据。被产品引用的资源撤回返回 409，产品下架独立处理。协议 published 不等于资源全员可见。字段校验以 DR 标准模型为准，中心维护相同快照与一致性测试。

DR 独立 reconcile_worker 持久化重试和退避，定期对账；Portal 提供同步状态及立即对账。PETs 默认 Master-Lite：中心维护作业提交意图并对账，由 Kuscia Master 调度两个 Lite；Portal 只准备本地输入，不创建自治作业。历史自治任务不自动接管。部署、恢复和真实验收以以上最终部署记录为准。

## 运行边界

- 浏览器：`/portal/services/di/*`、`dr/*`、`ts/*`；仅允许明确列出的公共业务接口。响应保持服务状态码和 JSON，204 不包裹；文件流式转发。浏览器不能访问内部搬运、资源 locator、演示审核或受信业务任务创建接口。
- Portal：中心认证、连接器身份和证书、Kuscia 会话/DomainData、本地计算输入准备、Lite 节点运维；作业与应用分发由中心 Kuscia Master 负责。只在 `portal-services.sqlite` 保存本地编排与身份；不创建数据源、资源或普通搬运业务表。不回退旧实现，不续跑旧任务。
- DI：源凭据、普通搬运及新增计算输入搬运。新增 `python -m data_integration.compute_worker`，普通 `transfer_worker` 和 TS 专属 `transit_worker` 的职责不变。
- DR：资源及不可变元数据版本；中心发布投影已有 `resource_id`、`version_no`，中心绑定新增显式 `dr_resource_id`。执行请求的 `ref` 仍是连接器资源引用，不能当中心目录 ID 使用。
- TS：仅由 Portal HTTP 客户端调用，使用 HMAC v2，覆盖原始路径/查询、请求体摘要及 Idempotency-Key。Portal 不存入仓或访问状态，不代理 OSS 内容。

普通搬运创建返回 created，用户另行执行；写操作不做透明重试。DR 写请求携带 If-Match，冲突后刷新列表，由用户核对。TS 一次性访问凭证仅保存在弹窗内，关闭清除，不进入查询缓存或浏览器存储。

## 身份与配置

`SERVICE_IDENTITIES_FILE` 指向 `deploy/service-identities.example.json` 同结构文件。外层连接器键是中心已验证的连接器 ID；条目内 tenant/connector 是 DI/DR/TS 实际作用域，可与中心 ID 不同。用户键来自中心 `/identity/me`，客户端不能覆盖。

- `DI_URL`、`DR_URL`、`TS_URL`：服务根地址，不包含 `/api/v1`。
- 用户 DI 身份按需授予 source:read/write、transfer:read/write；DR 身份按需授予 resource:read/write/publish。
- 机器 DI 身份仅需 compute:transfer；机器 DR 身份需 resource:locate。机器与用户令牌分开。
- TS 服务端主体与 Portal signer/secret/roles 必须一致，grant、import、import:unbound 并不由 admin 自动获得。Portal 配置 roles 只控制界面展示，TS 仍独立鉴权。
- DI/DR 继续使用现有 token_sha256 身份文件，不把中心登录令牌直接当服务令牌。`create-di-identities.py` 从环境生成 DI 摘要文件且拒绝覆盖；DR 还需配置其调用 DI 和中心的既有绑定。
- `DI_COMPUTE_TARGETS_FILE` 按绑定名固定目标主机、端口和作用域，示例见 `deploy/compute-targets.example.json`。多连接器使用不同绑定名；Portal 引擎 profile 可配置 compute_target_binding，缺省使用 COMPUTE_TARGET_BINDING。
- `DI_COMPUTE_CREDENTIAL_KEY` 为 Fernet 密钥，DI API 和 compute worker 使用同一值。只在 DI 配置，不能与 Portal/TS HMAC 密钥混用。

对源文件的浏览、上传和下载通过 DI；节点文件管理仍通过 Kuscia，含义不同。DI LocalFS 必须在 `/data/<tenant>/<connector>` 下；SeaTunnel 与 DI 在相同路径挂载该数据卷，Portal 不挂载。DI UID 10001 需要可读写该租户目录。

## 计算输入协议

内部接口由专用 Bearer 机器身份调用，不属于浏览器代理白名单：

- `POST /internal/v1/compute-transfers`，202；Idempotency-Key 必须等于 request_id。
- `GET /internal/v1/compute-transfers/by-request/{request_id}`。
- `POST /internal/v1/compute-transfers/{id}/cancel`，202；表示取消意图，查询到 cancelled 才代表引擎确认停止。

请求包含 request_id、source_id、object_ref、input_format、columns、可选 filter、target_binding、session_id、directory、username、password、expires_at（Unix 秒）。输出固定 CSV；临时会话最长接受 24 小时有效期。同作用域同键异体 409，其他作用域查询 404。响应仅包含 id/request_id/state/job_id/error/时间，不返回凭据或作业配置。

Portal 首次调用 DR 经中心审核版本 locator，保存源对象和字段快照，再创建 Kuscia FTP 会话，提交 DI。后续恢复按原请求 ID 查询 DI，不重新定位资源或重新创建已存在的交付任务。数据字节仍来自执行时的源，不声称元数据版本冻结历史内容。

DI 在创建时固定目标绑定的主机与端口，后续配置变化不改变已有任务的目标。提交意图先落库，SeaTunnel 使用持久化 job ID。提交响应丢失后查询原作业；作业不存在或提交状态不确定则 needs_attention，不自动重投。取消/过期先停止引擎并核对终态；终态和过期均清除加密凭据。needs_attention 需要核对引擎，不允许当作已停止。

Portal 在 DI 成功后核对接收文件、complete 会话，登记 DomainData 并按字节数和 SHA-256 验证。会话过期不复活：先取消并确认旧 DI 任务终止，再清理旧会话，以新的准备请求键创建新尝试。自动搬运凭据不向浏览器返回；手工 CSV 上传可显式取得自己的临时凭据。

## 部署与回退

`deploy/compose.microservices.yaml` 是独立项目，不覆盖 TS Agent 的部署。先构建新 Portal/DI 镜像，配置 PORTAL_IMAGE、DI_IMAGE、SEATUNNEL_IMAGE、DR_URL、TS_URL。SeaTunnel 必须使用支持 DI 结构化/二进制兼容补丁的镜像。复制 portal.env.example、di.env.example 和身份/目标绑定示例，填写真实凭据；凭据文件不提交版本库。

DR 和 TS 独立部署，地址及身份必须指向本次 DI/DR 实例；跨 Compose 网络使用服务双方实际可达的地址或由部署方配置共同网络，不使用容器内 localhost 代指宿主机。当前模板不启动或修改 DR/TS，不应直接指向仍运行旧数据集的服务并声称完成全新初始化。

新数据库默认 `/state/portal-services.sqlite`。身份接入有两种情况：全新环境走已有接入向导；已有连接器先停止旧入口、等待在途任务完成或明确终止，再备份整个旧 state（SQLite 使用 backup API，不能只复制活跃 WAL 主文件）。保留原证书目录路径，启动新服务前执行：

```bash
python -m bonfire_portal.initialize --source /state/portal.sqlite --destination /state/portal-services.sqlite
```

该工具以只读方式读取旧库，仅复制已完成的连接器身份与选中关系，过滤 profile 内嵌的 local_execution_runs，不复制业务表、任务、未完成接入会话或审计副本；目标已存在则拒绝。证书文件不移动。旧源和资源需在 DI/DR 重新登记，中心旧资源/合约不会自动改绑，必须用新资源重新建立业务引用。

完成新环境验收后一次性切换流量。回退先停止新入口及新 worker，再恢复旧镜像/旧状态快照；不删除新服务数据、不回灌旧 Portal、不尝试合并两边任务。

## TS 并行变更与验收界限

当前 Portal 覆盖仓库/保留策略、入仓及业务任务查询、对象版本、grant、访问签发/释放、软删除/恢复、hold、双人清理审批、异常与存储访问观察。业务任务通过 imports 列表及 by-reference 查询呈现，TS 没有独立 business-tasks 列表接口。存储访问观察不等同于精确完整下载证明。

已观察到并行 TS 增加 data-requests、preloads、authorization-policies、notification-deliveries。它们不属于本次锁定的管理页面契约，本次没有擅自开放新的业务准入入口。本次已对 demand-preload-20261024 镜像完成真实签名与生命周期验收，以及两租户的实际入仓/下载和隔离检查；后续 TS 升级仍需重新核验接口。

测试及运行命令见 `VALIDATION-microservices.md`。本次已完成真实五类源、SeaTunnel/FTP 计算准备、双方 PSI 结果检查和已部署 TS 镜像联调；后续切换仍不得把跳过或模拟测试算作环境验收。
