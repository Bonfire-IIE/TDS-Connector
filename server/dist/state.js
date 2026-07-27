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
exports.loadState = loadState;
exports.saveState = saveState;
/**
 * 门户本地状态持久化（设计见 design/connector-portal.md §8.5 / §9.3）。
 *
 * 门户接入(onboarding)后需跨重启记住"自身身份/接入态"，落**本地 JSON 文件**
 * （不上 DB，能用文件就不上库）。仅存路径引用，不拷贝 Lite 私钥/证书，
 * 不落数据源 AK/SK、不落平台会话 token。文件权限 0600（属门户运行用户）。
 *
 * 路径取 env PORTAL_STATE_FILE，dev 默认
 *   /home/bonfire-tds/src/connector_portal/.portal-state.json
 */
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
/** 门户数据根：优先 PORTAL_DATA_DIR，否则用户主目录下 ~/.bonfire-connector（无需 /home 或 root 权限）。 */
function dataDir() {
    const v = process.env.PORTAL_DATA_DIR;
    return v !== undefined && v !== ""
        ? v
        : path.join(os.homedir(), ".bonfire-connector");
}
function stateFile() {
    const v = process.env.PORTAL_STATE_FILE;
    return v !== undefined && v !== ""
        ? v
        : path.join(dataDir(), "portal-state.json");
}
let cache = null;
/** 读取本地状态；文件缺失/损坏时回退为未接入。进程内缓存一次。 */
function loadState() {
    if (cache)
        return cache;
    try {
        const raw = fs.readFileSync(stateFile(), "utf-8");
        const parsed = JSON.parse(raw);
        cache = parsed && typeof parsed === "object" ? parsed : { onboarded: false };
    }
    catch {
        cache = { onboarded: false };
    }
    return cache;
}
/**
 * 合并写入本地状态（浅合并 + 原子落盘，0600）。
 * 传 `pending: undefined` 可清除 pending（JSON.stringify 会丢弃 undefined 键）。
 */
function saveState(patch) {
    const next = { ...loadState(), ...patch };
    cache = next;
    const file = stateFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
    return next;
}
//# sourceMappingURL=state.js.map