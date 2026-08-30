import assert from "node:assert/strict";
import { test } from "node:test";

import { publicOnboardingState } from "./onboardingState";

test("匿名已接入状态仅返回布尔值，不泄露连接器身份", () => {
  assert.deepEqual(publicOnboardingState(true), { onboarded: true });
  assert.deepEqual(Object.keys(publicOnboardingState(true)), ["onboarded"]);
});

test("匿名未接入状态可供前端导航到接入向导", () => {
  assert.deepEqual(publicOnboardingState(false), { onboarded: false });
});
