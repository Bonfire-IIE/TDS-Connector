"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * 文件后端的联机验证脚本（不是单测，需要一个在跑的节点文件服务）。
 *
 * 单测跑不到真正要紧的部分：经域网关的两个头（Host / Kuscia-Source）是否对、
 * 流式上传下载、以及节点侧 4xx 的错误消息有没有原样带出来。这些只有对着真实
 * 节点才验得出来，所以单独放一个脚本，用 env 指定目标后手动跑：
 *
 *   cd src/connector_portal/server
 *   PORTAL_HOME=/tmp/no-manifest PORTAL_DOMAIN_ID=bonfire-lite \
 *   FILE_SERVICE_ENDPOINT=http://127.0.0.1:49083 \
 *   FILE_SERVICE_TOKEN=$(cat ../../../deploy/file-service/.tokens/bonfire-lite.token) \
 *   npx tsx src/storageBackend.live.ts
 *
 * serviceHost 不传会按部署脚本的命名规则推导（filesvc-<domain>-http.<domain>.svc）。
 * PORTAL_HOME 指一个不存在的目录，是为了绕开本机真实的 connector.yaml，确保验的
 * 就是 env 里这一组配置。
 *
 * 加 EXPECT_UNAVAILABLE=1 则反过来断言目标节点**没有**部署文件服务（用来检查
 * "没部署"时给出的是可操作的提示，而不是一句笼统的连不上）。
 */
const stream_1 = require("stream");
const storage_1 = require("./storage");
let failed = 0;
const ok = (msg) => console.log(`  [OK] ${msg}`);
const bad = (msg) => { console.log(`  [!!] ${msg}`); failed = 1; };
const step = (msg) => console.log(`\n=== ${msg} ===`);
async function collect(stream) {
    const chunks = [];
    for await (const c of stream) {
        chunks.push(typeof c === "string" ? Buffer.from(c) : c);
    }
    return Buffer.concat(chunks);
}
/** 断言操作被拒，且拒绝的消息与状态码都符合预期。 */
async function expectReject(what, fn, match, status) {
    try {
        await fn();
        bad(`${what} 本应失败却成功了`);
    }
    catch (e) {
        const message = String(e?.message ?? e);
        if (!match.test(message)) {
            bad(`${what} 的错误消息不符合预期：${message}`);
            return;
        }
        if (status !== undefined) {
            const got = e instanceof storage_1.StorageRequestError ? e.statusCode : undefined;
            if (got !== status) {
                bad(`${what} 的状态码应为 ${status}，实际 ${got ?? "无"}（消息正确：${message}）`);
                return;
            }
        }
        ok(`${what} 被拒（HTTP ${e instanceof storage_1.StorageRequestError ? e.statusCode : "-"}）：${message}`);
    }
}
async function main() {
    if (process.env.EXPECT_UNAVAILABLE === "1") {
        step("反面用例：目标节点应当没有可用的文件服务");
        let backend;
        try {
            backend = (0, storage_1.getStorageBackend)();
        }
        catch (e) {
            // 连配置都没有时 getStorageBackend 直接抛，这本身也是一种"没部署"。
            if (e instanceof storage_1.StorageUnavailableError && /deploy\.sh|令牌|连接器/.test(e.message)) {
                ok(`未配置即给出可操作提示：${e.message}`);
            }
            else {
                bad(`抛出的不是可操作的 StorageUnavailableError：${e?.message ?? e}`);
            }
            process.exit(failed);
        }
        const status = await backend.status();
        console.log(`  status: ${JSON.stringify(status)}`);
        if (status.available) {
            bad("目标竟然可用，反面用例不成立");
        }
        else if (/deploy\.sh|未就绪|不可达/.test(status.message)) {
            ok("给出的是可操作的原因，而不是笼统的连不上");
        }
        else {
            bad(`错误消息没有指出根因：${status.message}`);
        }
        // 关键区分：网关的 404（没部署）不能显示成服务自己的 404（路径不存在），
        // 否则会把人往"目录不存在"这个完全错误的方向引。
        await expectReject("list", () => backend.list(""), /没有到达文件服务|不可达|deploy\.sh/);
        process.exit(failed);
    }
    const backend = (0, storage_1.getStorageBackend)();
    step("1. status（打 /readyz，能区分「活着但没配 token」）");
    const status = await backend.status();
    console.log(`  ${JSON.stringify(status)}`);
    status.available ? ok(`可用，网关 ${status.endpoint}，Host ${status.service_host}`) : bad(`不可用：${status.message}`);
    const dir = "portal-live-check";
    step("2. mkdir（多级）");
    const made = await backend.mkdir(`${dir}/sub`);
    made.type === "directory" && made.path === `${dir}/sub` ? ok(`建出 ${made.path}`) : bad(`返回异常：${JSON.stringify(made)}`);
    step("3. 上传（流式）");
    const payload = Buffer.from("id,name\n001,Alice\n002,Bob\n");
    await backend.upload(`${dir}/sub`, "sample.csv", stream_1.Readable.from(payload), payload.length);
    ok("上传完成");
    step("4. 列举");
    const listed = await backend.list(`${dir}/sub`);
    listed.files.length === 1 && listed.files[0].name === "sample.csv"
        ? ok(`列到 ${listed.files[0].name}，size=${listed.files[0].size}，mtime=${listed.files[0].modified_at}`)
        : bad(`列举结果异常：${JSON.stringify(listed)}`);
    listed.truncated === false ? ok("truncated=false 已透传") : bad("truncated 字段异常");
    step("5. 下载并比对内容");
    const dl = await backend.download(`${dir}/sub/sample.csv`);
    const got = await collect(dl.stream);
    got.equals(payload) ? ok(`内容一致（${got.length} 字节，content-type=${dl.contentType}）`) : bad("内容不一致");
    step("6. 大文件往返（8MB，验证流式与 axios body 上限已放开）");
    const big = Buffer.alloc(8 * 1024 * 1024, 0x61);
    await backend.upload(dir, "big.bin", stream_1.Readable.from(big), big.length);
    const bigBack = await collect((await backend.download(`${dir}/big.bin`)).stream);
    bigBack.equals(big) ? ok(`8MB 往返一致（${bigBack.length} 字节）`) : bad(`8MB 往返不一致（收到 ${bigBack.length} 字节）`);
    step("7. 改名");
    const renamed = await backend.rename(`${dir}/sub/sample.csv`, `${dir}/sub/renamed.csv`);
    renamed.path === `${dir}/sub/renamed.csv` ? ok(`改名为 ${renamed.path}`) : bad(`改名结果异常：${JSON.stringify(renamed)}`);
    step("8. 错误映射（4xx 要带着状态码和可读消息一起出来）");
    await expectReject("改名到已存在的目标", () => backend.rename(`${dir}/big.bin`, `${dir}/sub/renamed.csv`), /已存在/, 409);
    await expectReject("删除非空目录（未带 recursive）", () => backend.remove(dir, false), /非空|递归/, 409);
    await expectReject("目录穿越", () => backend.list("../certs"), /超出存储根/, 403);
    await expectReject("下载不存在的文件", () => backend.download(`${dir}/nope.bin`), /不存在/, 404);
    step("9. 递归删除收尾");
    await backend.remove(dir, true);
    const rootAfter = await backend.list("");
    rootAfter.files.some((f) => f.name === dir) ? bad("目录没删掉") : ok("目录已删除，根目录已清理");
    console.log(failed ? "\n存在失败项" : "\n全部通过");
    process.exit(failed);
}
main().catch((e) => {
    console.error("脚本异常:", e);
    process.exit(1);
});
//# sourceMappingURL=storageBackend.live.js.map