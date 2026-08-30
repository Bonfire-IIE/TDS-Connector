"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_TAIL_LINES = void 0;
exports.splitJsonObjects = splitJsonObjects;
exports.readNodeLogLines = readNodeLogLines;
exports.pipeNodeLogSse = pipeNodeLogSse;
const lite_1 = require("./lite");
/** 单次一次性拉取最多返回的行数，兜住 tail_lines 被绕过的情况。 */
exports.MAX_TAIL_LINES = 10000;
/** 无日志产出时的保活间隔：SSE 长时间静默会被中间代理判定为死连接。 */
const HEARTBEAT_MS = 15000;
/**
 * 增量切分背靠背的 JSON 对象。
 *
 * 只跟踪花括号深度与字符串状态就够了：顶层一定是对象，且日志正文里的换行和
 * 引号在 JSON 里都是转义过的，不会被误当成结构字符。
 */
function splitJsonObjects() {
    let buffer = "";
    // 扫描状态跨 chunk 保留，所以必须记住扫到哪了：从头重扫会拿当前状态去解析
    // 已经处理过的字符。
    let scanned = 0;
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    return (chunk) => {
        buffer += chunk;
        const out = [];
        for (let i = scanned; i < buffer.length; i++) {
            const ch = buffer[i];
            if (inString) {
                if (escaped)
                    escaped = false;
                else if (ch === "\\")
                    escaped = true;
                else if (ch === '"')
                    inString = false;
                continue;
            }
            if (ch === '"') {
                inString = true;
            }
            else if (ch === "{") {
                if (depth === 0)
                    start = i;
                depth++;
            }
            else if (ch === "}") {
                depth--;
                if (depth === 0 && start >= 0) {
                    out.push(buffer.slice(start, i + 1));
                    start = -1;
                }
            }
        }
        scanned = buffer.length;
        // 只保留尚未配平的尾部，避免 buffer 随流无限增长。depth 归零时残留的只可能
        // 是对象之间的空白（出现过 { 的话 depth 就不是 0），整体丢弃即可。
        if (depth === 0) {
            buffer = "";
            scanned = 0;
            start = -1;
        }
        else if (start > 0) {
            buffer = buffer.slice(start);
            scanned = buffer.length;
            start = 0;
        }
        return out;
    };
}
/**
 * 解析一个 chunk。流式响应用的是 encoding/json，code 为 0 时字段会被省略，
 * 所以「没有 code」等同于成功。
 */
function parseChunk(text) {
    let obj;
    try {
        obj = JSON.parse(text);
    }
    catch {
        return { lines: [], error: `无法解析 Kuscia 返回的日志分片：${text.slice(0, 200)}` };
    }
    const code = obj.status?.code;
    if (code !== undefined && code !== 0) {
        return { lines: [], error: obj.status?.message ?? `Kuscia 返回错误码 ${code}` };
    }
    const payload = obj.log ?? "";
    // 心跳是一条空 log，不产出任何行。
    if (payload === "")
        return { lines: [] };
    return { lines: payload.split("\n") };
}
/** 一次性读完一个非 follow 的日志查询，返回行数组。 */
async function readNodeLogLines(client, query) {
    const stream = await client.openNodeLogStream({ ...query, follow: false });
    const split = splitJsonObjects();
    const lines = [];
    let failure;
    await new Promise((resolve, reject) => {
        stream.setEncoding("utf-8");
        stream.on("data", (chunk) => {
            for (const text of split(chunk)) {
                const { lines: batch, error } = parseChunk(text);
                if (error && !failure)
                    failure = error;
                for (const line of batch) {
                    if (lines.length < exports.MAX_TAIL_LINES)
                        lines.push(line);
                }
            }
        });
        stream.on("end", resolve);
        stream.on("error", reject);
    });
    if (failure)
        throw new lite_1.KusciaError(failure);
    return lines;
}
function writeSse(res, event, data) {
    if (event)
        res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}
/**
 * 把 Kuscia 的日志流转成 SSE 转发给浏览器。
 *
 * 客户端断开时必须 abort 上游请求：否则 Kuscia 那边的 tail 会一直等我们读，
 * 直到连接超时才退出，页面开关几次就会在节点上攒下一堆读取协程。
 */
async function pipeNodeLogSse(client, query, req, res) {
    const controller = new AbortController();
    let stream;
    try {
        stream = await client.openNodeLogStream(query, controller.signal);
    }
    catch (e) {
        // 还没开始写响应体，可以正常返回错误状态。
        res.status(502).json({ detail: e?.message ?? String(e) });
        return;
    }
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    // nginx 默认缓冲响应体，会让实时日志攒够缓冲区才下发。
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const heartbeat = setInterval(() => {
        // 注释帧：EventSource 会忽略，但足以让中间链路知道连接还活着。
        res.write(": keep-alive\n\n");
    }, HEARTBEAT_MS);
    let finished = false;
    const finish = (event, payload) => {
        if (finished)
            return;
        finished = true;
        clearInterval(heartbeat);
        controller.abort();
        if (!res.writableEnded) {
            writeSse(res, event, payload ?? {});
            res.end();
        }
    };
    req.on("close", () => {
        if (finished)
            return;
        finished = true;
        clearInterval(heartbeat);
        controller.abort();
    });
    const split = splitJsonObjects();
    stream.setEncoding("utf-8");
    stream.on("data", (chunk) => {
        for (const text of split(chunk)) {
            const { lines, error } = parseChunk(text);
            if (error) {
                finish("error", { message: error });
                return;
            }
            if (lines.length > 0)
                writeSse(res, null, { lines });
        }
    });
    stream.on("end", () => finish("end"));
    stream.on("error", (e) => {
        // abort 触发的 error 是我们自己造成的，不该报给前端。
        if (controller.signal.aborted) {
            finish("end");
            return;
        }
        finish("error", { message: e?.message ?? String(e) });
    });
}
//# sourceMappingURL=nodeLogs.js.map