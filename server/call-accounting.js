import { AppError, failureDetails } from "./provider.js";

export function totals(calls) {
  const complete = calls.every((call) =>
    call.usage?.source !== "unavailable" &&
    Number.isFinite(call.usage?.input) && call.usage.input >= 0 &&
    Number.isFinite(call.usage?.output) && call.usage.output >= 0,
  );
  return {
    input: complete ? calls.reduce((sum, call) => sum + call.usage.input, 0) : null,
    output: complete ? calls.reduce((sum, call) => sum + call.usage.output, 0) : null,
    cost: calls.length && calls.every((call) => Number.isFinite(call.cost) && call.cost >= 0)
      ? calls.reduce((sum, call) => sum + call.cost, 0) : null,
    calls: calls.length,
  };
}

// Count attempted calls, not just successful responses. Unknown failed usage must
// invalidate the aggregate without discarding earlier provider-reported details.
export async function recordModelCall(run, model, role, invoke, details = {}) {
  const started = performance.now();
  const identity = { ...details, role, modelId: model.id, modelName: model.name };
  let result;
  try {
    result = await invoke();
  } catch (error) {
    run.calls.push({
      ...identity,
      status: "failed",
      usage: { input: null, output: null, source: "unavailable" },
      cost: null,
      latencyMs: Math.round(performance.now() - started),
      error: error instanceof AppError ? error.message : "模型调用失败。",
      ...failureDetails(error),
      ...(Number.isInteger(error?.upstreamStatus) ? { upstreamStatus: error.upstreamStatus } : {}),
    });
    run.totals = totals(run.calls);
    throw error;
  }
  run.calls.push({
    ...identity,
    status: "completed",
    usage: result.usage,
    cost: result.cost,
    latencyMs: result.latencyMs,
    ...(result.finishReason ? { finishReason: result.finishReason } : {}),
  });
  run.totals = totals(run.calls);
  return result;
}
