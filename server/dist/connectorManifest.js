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
exports.findConnectorManifest = findConnectorManifest;
exports.requiredCertFiles = requiredCertFiles;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const config_1 = require("./config");
function unquote(value) {
    const v = value.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        return v.slice(1, -1);
    }
    return v;
}
// Parse the deliberately small connector.yaml schema without accepting arbitrary YAML features.
function parseManifest(file) {
    const values = new Map();
    let section = "";
    for (const raw of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
        const line = raw.replace(/\s+#.*$/, "");
        if (!line.trim() || line.trimStart().startsWith("#"))
            continue;
        const indent = line.length - line.trimStart().length;
        const match = line.trim().match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/);
        if (!match)
            throw new Error(`不支持的 connector.yaml 行: ${raw}`);
        const key = match[1];
        const value = match[2] ?? "";
        if (indent === 0) {
            section = value === "" ? key : "";
            if (value !== "")
                values.set(key, unquote(value));
        }
        else if (section && value !== "") {
            values.set(`${section}.${key}`, unquote(value));
        }
    }
    const domainId = values.get("domainId") ?? "";
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(domainId)) {
        throw new Error("connector.yaml 缺少合法的 domainId");
    }
    const base = path.dirname(file);
    const certValue = values.get("certDir") || "./certs";
    const endpoint = values.get("fileService.endpoint");
    return {
        domainId,
        connectorId: values.get("connectorId") || undefined,
        liteEndpoint: values.get("liteEndpoint") || undefined,
        certDir: path.resolve(base, certValue),
        fileService: endpoint
            ? {
                endpoint: endpoint.replace(/\/+$/, ""),
                serviceHost: values.get("fileService.serviceHost") || undefined,
                token: values.get("fileService.token") || undefined,
            }
            : undefined,
        manifestPath: file,
    };
}
function findConnectorManifest(domainId) {
    const root = path.resolve(config_1.config.portalHome, "connectors");
    const candidate = path.resolve(root, domainId, "connector.yaml");
    if (!candidate.startsWith(root + path.sep) || !fs.existsSync(candidate))
        return null;
    const manifest = parseManifest(candidate);
    if (manifest.domainId !== domainId)
        throw new Error("connector.yaml 的 domainId 与目录不一致");
    return manifest;
}
function requiredCertFiles(certDir) {
    const required = ["ca.crt", "kusciaapi-server.crt", "kusciaapi-server.key", "token"];
    const missing = required.filter((name) => !fs.existsSync(path.join(certDir, name)));
    return { complete: missing.length === 0, missing };
}
//# sourceMappingURL=connectorManifest.js.map