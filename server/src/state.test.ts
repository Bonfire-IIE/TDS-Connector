import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-state-test-"));
process.env.PORTAL_STATE_FILE = path.join(testDir, "portal-state.json");
const require = createRequire(import.meta.url);
const { clearPending, getPending, profilesForUser, savePending, saveProfile, selectedProfile } = require("./state") as typeof import("./state");

test("多用户的 pending 接入进度互不覆盖", () => {
  savePending("state-test-a", { connector_id: "pa", kuscia_domain_id: "da", owner_username: "state-test-a" });
  savePending("state-test-b", { connector_id: "pb", kuscia_domain_id: "db", owner_username: "state-test-b" });
  assert.equal(getPending("state-test-a")?.connector_id, "pa");
  assert.equal(getPending("state-test-b")?.connector_id, "pb");
  clearPending("state-test-a");
  clearPending("state-test-b");
});

test("一个文件可保存多个连接器并按属主隔离", () => {
  saveProfile("state-owner-a", { connector_id: "profile-a", domain_id: "domain-a" });
  saveProfile("state-owner-b", { connector_id: "profile-b", domain_id: "domain-b" });
  assert.deepEqual(profilesForUser("state-owner-a").map((p) => p.connector_id), ["profile-a"]);
  assert.equal(selectedProfile("state-owner-b")?.connector_id, "profile-b");
});

test("同一属主重新接入同一域时淘汰旧 connector ID", () => {
  saveProfile("state-redeploy", { connector_id: "old-id", domain_id: "same-domain" });
  saveProfile("state-redeploy", { connector_id: "new-id", domain_id: "same-domain" });
  assert.deepEqual(profilesForUser("state-redeploy").map((p) => p.connector_id), ["new-id"]);
  assert.equal(selectedProfile("state-redeploy")?.connector_id, "new-id");
});
