import test from "node:test";
import assert from "node:assert/strict";
import { officeTask, officeCandidates, officeAttemptModels, canFallbackOffice } from "../server/office-routing.js";

test("Office classification is scoped and protects sensitive work", () => {
  for (const text of ["排版报告.docx", "整理 Excel 工作表", "编辑 Word 文档", "Create a Word document", "Format a spreadsheet", "整理导出的.csv"]) assert.equal(officeTask(text), "office-routine", text);
  for (const text of ["审计 Excel 财务表", "Excel 复杂公式", "Excel VBA 宏", "重要合同.docx 审校", "advanced formulas in workbook", "在 Excel 编写脚本"]) assert.equal(officeTask(text), "office-sensitive", text);
  for (const text of ["天气如何", "word ".repeat(100), "Fix a JavaScript word counter", "修改网页样式"]) assert.equal(officeTask(text), null, text);
});

test("Office preference uses eligible real models and configured prices only", () => {
  const m = (model, extra = {}) => ({ id: model, model, kind: "live", ...extra });
  const models = [m("openai/gpt-6-terra--fast"), m("deepseek/deepseek-v4-flash"), m("kimi-code/k3.1-pro"), m("kimi-code/k3.1-pro-highspeed"), m("openai/gpt-6.1-sol"), m("kimi-code/k3", { kind: "demo" }), m("kimi-code/kimi-for-coding-highspeed", { tooSmall: true })];
  assert.deepEqual(officeCandidates(models, (m) => !m.tooSmall).map(m => m.model), ["kimi-code/k3.1-pro-highspeed", "kimi-code/k3.1-pro", "deepseek/deepseek-v4-flash", "openai/gpt-6-terra--fast"]);
  const priced = [m("deepseek/flash", { inputPrice: 2, outputPrice: 3 }), m("deepseek/fast", { inputPrice: 1, outputPrice: 2 })];
  assert.equal(officeCandidates(priced, () => true)[0].model, "deepseek/fast");
});

test("Office fallback is bounded, deduplicated and retains stronger final option", () => {
  const [a,b,c,p] = ["a","b","c","planner"].map(id => ({ id }));
  assert.deepEqual(officeAttemptModels(a,[a,b,c],p,()=>true),[a,b,p]);
  assert.deepEqual(officeAttemptModels(a,[a,b],p,m=>m!==p),[a,b]);
  assert.deepEqual(officeAttemptModels(p,[a,b,c],p,()=>true),[p,a,b]);
  assert(canFallbackOffice({ upstreamStatus:429 }));
  assert(!canFallbackOffice({ upstreamStatus:400 }));
  assert(!canFallbackOffice(new Error("timeout")));
  assert(!canFallbackOffice({ upstreamStatus:503 },{ aborted:true }));
});
