// These are strategy presets, not a claim that every physical model has every rung.
export const REASONING_EFFORTS = Object.freeze([
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
]);

export function adaptReasoning(model, parameters, fallback = "medium") {
  const requested = parameters.reasoning_effort ?? fallback;
  const next = { ...parameters };
  delete next.reasoning_effort;
  const supported = model.reasoningEfforts;
  // Unknown and explicitly non-reasoning models must not receive invented flags.
  if (!Array.isArray(supported) || !supported.length)
    return { parameters: next, requested, effective: null, adaptation: "unsupported-or-unknown" };
  // Codex's ultra is a client-level delegation preset; its inference wire effort is max.
  const boundary = requested === "ultra" ? "max" : requested;
  const available = [...new Set(supported.map((e) => e === "ultra" ? "max" : e))];
  const atOrBelow = REASONING_EFFORTS.filter((e) => e !== "ultra" &&
    available.includes(e) && REASONING_EFFORTS.indexOf(e) <= REASONING_EFFORTS.indexOf(boundary));
  const effective = available.includes(boundary) ? boundary : atOrBelow.at(-1) ||
    REASONING_EFFORTS.find((e) => available.includes(e));
  if (effective) next.reasoning_effort = effective;
  return { parameters: next, requested, effective: effective || null,
    adaptation: effective === requested ? "exact" : "mapped" };
}
