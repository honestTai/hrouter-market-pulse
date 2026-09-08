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
  <meta name="color-scheme" content="light">
  <meta name="description" content="Hrouter Market Pulse: A-share, Hong Kong and US market research workspace.">
  <title>Hrouter Market Pulse</title>
  <link rel="icon" href="data:,">
  <link rel="stylesheet" href="/assets/dashboard.css">
  <script defer src="/assets/vendor/lightweight-charts.js"></script>
  <script defer src="/assets/vendor/lucide.js"></script>
  <script defer src="/assets/dashboard.js"></script>
</head>
<body>
  <script id="report-data" type="application/json">${safeJson(report)}</script>
  <div id="app"><div class="boot"><strong>Hrouter Market Pulse</strong><progress aria-label="Loading"></progress></div></div>
  <div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
  <dialog id="editor-dialog"></dialog>
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
