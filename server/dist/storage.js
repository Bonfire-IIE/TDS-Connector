"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.StorageUnavailableError = void 0;
exports.getStorageBackend = getStorageBackend;
const axios_1 = __importDefault(require("axios"));
const connectorManifest_1 = require("./connectorManifest");
const config_1 = require("./config");
class StorageUnavailableError extends Error {
}
exports.StorageUnavailableError = StorageUnavailableError;
class RemoteStorageBackend {
    constructor(endpoint, token) {
        this.endpoint = endpoint;
        this.client = axios_1.default.create({
            baseURL: endpoint,
            timeout: 15000,
            proxy: false,
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
    }
    async status() {
        try {
            await this.client.get("/health");
            return { available: true, backend: "remote", endpoint: this.endpoint, message: "文件服务可用" };
        }
        catch (e) {
            return { available: false, backend: "remote", endpoint: this.endpoint, message: e?.message ?? "文件服务不可达" };
        }
    }
    async list(relativePath) {
        const resp = await this.client.get("/api/v1/files", { params: { path: relativePath } });
        return resp.data?.data ?? resp.data ?? [];
    }
    async upload(directory, filename, body, contentLength) {
        await this.client.put("/api/v1/files", body, {
            params: { path: directory, filename },
            headers: { "Content-Type": "application/octet-stream", ...(contentLength ? { "Content-Length": contentLength } : {}) },
            maxBodyLength: 1024 * 1024 * 1024,
        });
    }
    async download(relativePath) {
        const resp = await this.client.get("/api/v1/files/content", {
            params: { path: relativePath },
            responseType: "stream",
        });
        return {
            stream: resp.data,
            contentType: typeof resp.headers["content-type"] === "string" ? resp.headers["content-type"] : undefined,
            contentLength: Number(resp.headers["content-length"]) || undefined,
        };
    }
}
function getStorageBackend() {
    const manifest = (0, connectorManifest_1.findConnectorManifest)((0, config_1.resolveIdentity)().domainId);
    if (!manifest?.fileService?.endpoint) {
        throw new StorageUnavailableError("未配置节点文件服务，请先完成文件服务部署并在 connector.yaml 中配置 fileService");
    }
    return new RemoteStorageBackend(manifest.fileService.endpoint, manifest.fileService.token);
}
//# sourceMappingURL=storage.js.map