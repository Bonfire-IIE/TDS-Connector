import axios, { AxiosInstance } from "axios";

import { findConnectorManifest } from "./connectorManifest";
import { resolveIdentity } from "./config";

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  modified_at?: string;
}

export interface StorageStatus {
  available: boolean;
  backend: "remote";
  endpoint?: string;
  message: string;
}

export interface StorageBackend {
  status(): Promise<StorageStatus>;
  list(relativePath: string): Promise<FileEntry[]>;
  upload(directory: string, filename: string, body: NodeJS.ReadableStream, contentLength?: number): Promise<void>;
  download(relativePath: string): Promise<{ stream: NodeJS.ReadableStream; contentType?: string; contentLength?: number }>;
}

export class StorageUnavailableError extends Error {}

class RemoteStorageBackend implements StorageBackend {
  private readonly client: AxiosInstance;
  constructor(private readonly endpoint: string, token?: string) {
    this.client = axios.create({
      baseURL: endpoint,
      timeout: 15000,
      proxy: false,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
  }

  async status(): Promise<StorageStatus> {
    try {
      await this.client.get("/health");
      return { available: true, backend: "remote", endpoint: this.endpoint, message: "文件服务可用" };
    } catch (e: any) {
      return { available: false, backend: "remote", endpoint: this.endpoint, message: e?.message ?? "文件服务不可达" };
    }
  }

  async list(relativePath: string): Promise<FileEntry[]> {
    const resp = await this.client.get("/api/v1/files", { params: { path: relativePath } });
    return resp.data?.data ?? resp.data ?? [];
  }

  async upload(directory: string, filename: string, body: NodeJS.ReadableStream, contentLength?: number): Promise<void> {
    await this.client.put("/api/v1/files", body, {
      params: { path: directory, filename },
      headers: { "Content-Type": "application/octet-stream", ...(contentLength ? { "Content-Length": contentLength } : {}) },
      maxBodyLength: 1024 * 1024 * 1024,
    });
  }

  async download(relativePath: string) {
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

export function getStorageBackend(): StorageBackend {
  const manifest = findConnectorManifest(resolveIdentity().domainId);
  if (!manifest?.fileService?.endpoint) {
    throw new StorageUnavailableError("未配置节点文件服务，请先完成文件服务部署并在 connector.yaml 中配置 fileService");
  }
  return new RemoteStorageBackend(manifest.fileService.endpoint, manifest.fileService.token);
}
