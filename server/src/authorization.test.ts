import assert from "node:assert/strict";
import { test } from "node:test";

import { authorizeBoundOwner, isConnectorOwner } from "./authorization";

const identity = { connectorId: "connector-b", domainId: "domain-b" };
const connector = { id: "connector-b", kuscia_domain_id: "domain-b", created_by: "user-b" };

test("连接器属主可以访问本机能力", () => {
  assert.deepEqual(authorizeBoundOwner(identity, { username: "user-b" }, connector), { ok: true });
});

test("有效登录的其他用户不能访问上一用户的连接器", () => {
  const result = authorizeBoundOwner(identity, { username: "user-a" }, connector);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.statusCode, 403);
});

test("中心管理员可查看连接器也不能代替属主操作边缘能力", () => {
  const result = authorizeBoundOwner(identity, { username: "operator" }, connector);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.statusCode, 403);
});

test("onboarding 只能操作当前 token 主体创建的连接器", () => {
  assert.equal(isConnectorOwner({ username: "user-b" }, connector), true);
  assert.equal(isConnectorOwner({ username: "user-a" }, connector), false);
  assert.equal(isConnectorOwner({}, connector), false);
});

test("中心身份与本机 connector 或 domain 不一致时拒绝访问", () => {
  for (const changed of [
    { ...connector, id: "connector-a" },
    { ...connector, kuscia_domain_id: "domain-a" },
  ]) {
    const result = authorizeBoundOwner(identity, { username: "user-b" }, changed);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.statusCode, 409);
  }
});
