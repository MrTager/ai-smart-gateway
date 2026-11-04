import test from "node:test";
import assert from "node:assert/strict";
import { REASONING_EFFORTS, adaptReasoning } from "../server/reasoning.js";
import { modelFitsContext } from "../server/limits.js";
import { validateModel } from "../server/provider.js";
import { agentMetadata, catalogModelRow } from "../scripts/connect-opencodex.mjs";

test("strategy advertises all local Codex presets and a separate 32K output budget", () => {
  const metadata = agentMetadata();
  assert.deepEqual(metadata.modelReasoningEfforts.strategy, [...REASONING_EFFORTS]);
  assert.deepEqual(metadata.noReasoningModels, []);
  assert.equal(metadata.defaultMaxOutputTokens, 32768);
  assert.equal(metadata.modelReasoningEffortMap.strategy.none, "none");
  assert.equal(metadata.modelReasoningEffortMap.strategy.minimal, "minimal");
  assert.equal(metadata.modelReasoningEffortMap.strategy.ultra, "max");
});

test("reasoning is mapped per physical model and never invents unsupported flags", () => {
  const model = { reasoningEfforts: ["low", "high", "max"] };
  const expected = { none:"low", minimal:"low", low:"low", medium:"low", high:"high", xhigh:"high", max:"max", ultra:"max" };
  for (const requested of REASONING_EFFORTS) {
    const original = { reasoning_effort: requested, tools: [{type:"function"}] };
    const mapped = adaptReasoning(model, original);
    assert.equal(mapped.effective, expected[requested]);
    assert.equal(mapped.parameters.reasoning_effort, expected[requested]);
    assert.equal(original.reasoning_effort, requested);
    assert.deepEqual(mapped.parameters.tools, original.tools);
  }
  assert.equal(adaptReasoning({reasoningEfforts:["none","low"]},{reasoning_effort:"none"}).effective,"none");
  assert.equal(adaptReasoning({reasoningEfforts:["high"]},{reasoning_effort:"low"}).effective,"high");
  for(const m of [{}, {reasoningEfforts:[]}]) assert(!("reasoning_effort" in adaptReasoning(m,{reasoning_effort:"high"}).parameters));
});

test("1M budget includes output reserve and never expands small model windows", () => {
  const large = {contextWindow:1050000,maxTokens:32768};
  assert(modelFitsContext(large,900000));
  assert(modelFitsContext(large,967232));
  assert(!modelFitsContext(large,967233));
  assert(!modelFitsContext({contextWindow:272000,maxTokens:32768},900000));
  assert(modelFitsContext(large,999000,1000));
});

test("capability metadata survives edits and synthetic fast rows inherit real capabilities", () => {
  const row={slug:"gpt-6-luna",context_window:872000,supported_reasoning_levels:[{effort:"high"}]};
  assert.equal(catalogModelRow("openai/gpt-6-luna--fast",[row]),row);
  const base={name:"model",model:"model",baseUrl:"https://example.com/v1",reasoningEfforts:["low","high"]};
  const previous=validateModel(base);
  assert.deepEqual(validateModel({...base,reasoningEfforts:undefined},previous).reasoningEfforts,["low","high"]);
  assert.throws(()=>validateModel({...base,reasoningEfforts:["typo"]}),/reasoningEfforts/);
});
