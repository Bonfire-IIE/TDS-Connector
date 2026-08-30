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
exports.syncAuditMirror = syncAuditMirror;
exports.readAuditMirror = readAuditMirror;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const config_1 = require("./config");
const platform_1 = require("./platform");
function mirrorFile() { return path.join(config_1.config.portalDataDir, "audit-mirror.json"); }
function read() { try {
    return JSON.parse(fs.readFileSync(mirrorFile(), "utf-8"));
}
catch {
    return { cursor: undefined, events: [] };
} }
async function syncAuditMirror(authorization) {
    const id = (0, config_1.resolveIdentity)();
    if (!id.connectorId)
        throw new Error("门户尚未绑定连接器");
    const current = read();
    const data = await new platform_1.PlatformClient(authorization).syncAudit(id.connectorId, current.cursor);
    const events = [...(current.events ?? [])];
    for (const event of data?.events ?? []) {
        if (!events.some((x) => x.event_id === event.event_id))
            events.push(event);
    }
    fs.mkdirSync(path.dirname(mirrorFile()), { recursive: true });
    fs.writeFileSync(mirrorFile(), JSON.stringify({ cursor: data?.next_cursor, events }, null, 2), { mode: 0o600 });
    return { count: data?.count ?? 0, cursor: data?.next_cursor };
}
function readAuditMirror() { return read(); }
//# sourceMappingURL=auditMirror.js.map