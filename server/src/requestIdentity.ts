import { AsyncLocalStorage } from "node:async_hooks";
import type { Identity } from "./config";

const storage = new AsyncLocalStorage<Identity>();

export function withRequestIdentity<T>(identity: Identity, fn: () => T): T {
  return storage.run(identity, fn);
}

export function requestIdentity(): Identity | undefined {
  return storage.getStore();
}
