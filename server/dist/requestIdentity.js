"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.withRequestIdentity = withRequestIdentity;
exports.requestIdentity = requestIdentity;
const node_async_hooks_1 = require("node:async_hooks");
const storage = new node_async_hooks_1.AsyncLocalStorage();
function withRequestIdentity(identity, fn) {
    return storage.run(identity, fn);
}
function requestIdentity() {
    return storage.getStore();
}
//# sourceMappingURL=requestIdentity.js.map