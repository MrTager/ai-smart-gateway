import test from "node:test";
import assert from "node:assert/strict";
import {
  routedModels,
  contextMetadata,
} from "../scripts/connect-opencodex.mjs";
import { validateModel } from "../server/provider.js";
import { LIMITS } from "../server/limits.js";

test("1M metadata and automatic compaction leave room for output and wrappers", () => {
  const metadata = contextMetadata();
  assert.equal(metadata.contextWindow, 1_000_000);
  assert.equal(metadata.modelContextWindows.strategy, 1_000_000);
  assert.equal(metadata.modelAutoCompactTokenLimits.strategy, 900_000);
  assert.equal(LIMITS.maxRequestBytes, 32 * 1024 * 1024);
});

test("OpenCodex import canonicalizes aliases and excludes the gateway itself", () => {
  assert.deepEqual(
    routedModels([
      { id: "gpt-test" },
      { id: "openai/gpt-test" },
      { id: "deepseek/fast" },
      { id: "ai-smart-gateway/strategy" },
      { id: "strategy" },
    ]),
    ["openai/gpt-test", "deepseek/fast"],
  );
});
test("Docker host is allowed only as an explicit local upstream", () => {
  const model = {
    name: "local",
    model: "openai/test",
    baseUrl: "http://host.docker.internal:10100/v1",
  };
  assert.equal(validateModel(model).model, "openai/test");
  assert.throws(() =>
    validateModel({ ...model, baseUrl: "http://example.com/v1" }),
  );
  assert.throws(
    () => validateModel({ ...model, model: "ai-smart-gateway/strategy" }),
    /循环/,
  );
  assert.throws(() => validateModel({ ...model, model: "strategy" }), /循环/);
});
