// Inspect the current user's task, never system/tool text or all historical turns.
export function officeTask(text) {
  const office = /\.(?:docx?|xlsx?|xlsm|csv)\b|\b(?:excel|spreadsheet|workbook|worksheet)\b|\bword\s+(?:document|file)\b|(?:操作|编辑|修改|生成|创建|整理|读取|排版|转换|处理).{0,20}\bword\b|\bword\b.{0,20}(?:文档|文件)|电子表格|工作簿|工作表|[表文]档排版|Word文档|Excel表格/i.test(text);
  if (!office) return null;
  const sensitive = /复杂公式|财务|审计|会计|税务|现金流|估值|重要.{0,8}(?:审校|审核|审查)|法律|合同|\b(?:vba|macros?|financial|accounting|audit|valuation)\b|宏(?:代码|编程|脚本)?|(?:编写|修改|调试).{0,12}(?:代码|脚本)|(?:complex|advanced).{0,12}formulas?/i.test(text);
  return sensitive ? "office-sensitive" : "office-routine";
}

export function officeModelRank(model) {
  const id = model.model.toLowerCase();
  if (/^kimi-code\//.test(id)) {
    // Prefer current K3.1 variants to legacy configured rows.
    return /highspeed|--fast/.test(id)
      ? /k3\.1/.test(id) ? 0 : 1
      : /k3\.1/.test(id) ? 2 : 3;
  }
  if (/^(?:zhipu-bigmodel-coding|deepseek)\//.test(id) && /flash|fast|highspeed/.test(id)) return 4;
  if (/(?:^|\/)gpt-[\d.]+-(?:luna|terra)--fast$/.test(id)) return 5;
  return Infinity;
}

export function officeCandidates(models, fits) {
  return models.filter((m) => m.kind === "live" && Number.isFinite(officeModelRank(m)) && fits(m))
    .sort((a, b) => {
      const rank = officeModelRank(a) - officeModelRank(b);
      if (rank) return rank;
      // Compare configured prices only when both are known; do not invent prices.
      const price = (m) => Number.isFinite(m.inputPrice) && Number.isFinite(m.outputPrice)
        ? m.inputPrice + m.outputPrice : null;
      const ap = price(a), bp = price(b);
      return ap !== null && bp !== null ? ap - bp : 0;
    });
}

export function officeAttemptModels(model, preferred, planner, fits) {
  const unique = [...new Map([model, ...preferred, planner].filter(fits).map((m) => [m.id, m])).values()];
  // At most three requests, reserving the final slot for the stronger planner.
  if (unique.length <= 3) return unique;
  return fits(planner) && planner.id !== model.id
    ? [...unique.filter((m) => m.id !== planner.id).slice(0, 2), planner]
    : unique.slice(0, 3);
}

export function canFallbackOffice(error, signal) {
  return !signal?.aborted && [401, 403, 404, 429, 500, 502, 503, 504].includes(error.upstreamStatus);
}
