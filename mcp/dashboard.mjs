function safeJson(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function buildReportHtml(report) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="description" content="HRouter 股票工作台：本机运行的多 Agent 交易员工作台，A 股、港股、美股模拟盘与研究。">
  <title>HRouter 股票工作台</title>
  <link rel="icon" href="data:,">
  <link rel="stylesheet" href="/assets/app/app.css">
  <script type="module" src="/assets/app/app.js"></script>
</head>
<body>
  <script id="report-data" type="application/json">${safeJson(report)}</script>
  <div id="app"><div style="font:14px system-ui;padding:40px;color:#6b7180">HRouter 股票工作台 · 加载中…</div></div>
  <noscript>JavaScript is required / 请启用 JavaScript</noscript>
</body>
</html>`;
}

export function buildEmptyHtml() {
  return buildReportHtml({
    schemaVersion: 2,
    runId: null,
    generatedAt: null,
    phase: "research",
    items: [],
    summary: {},
    empty: true,
  });
}
