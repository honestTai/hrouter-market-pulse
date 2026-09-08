# Changelog

## 1.1.1

- Enumerate regression test files explicitly so the same test command works on Windows with Node.js 20 and newer.
- Select an available local dashboard port when an older plugin instance occupies the requested port; advertise the actual URL through MCP.

## 1.1.0

- Rebuilt the market dashboard with Chinese / English switching, sortable watchlists, holdings, financial charts, indicators, events and decision records.
- Added session calendars, quote-age and timestamp agreement checks, indicator warmup requirements, neutral flat RSI, and same-time intraday volume comparisons.
- Added currency and FX validation, existing holdings, remaining cash and aggregate position-risk constraints.
- Added persisted alert transitions, recovery and cooldown behavior.
- Added shared-capital historical simulation, A-share holding restrictions, execution assumptions and company-action processing.
- Added purged walk-forward evaluation, baseline comparisons, qualification gates and a forecast outcome ledger.
- Added official evidence adapters/imports, benchmark-relative context and append-only decision reviews.
- Added reproducible marketplace packaging, bilingual documentation, isolated demo data and cross-platform CI.

## 1.0.0

- Initial local research plugin with seven skills, quote cross-checking, deterministic indicators, evidence contracts and experimental research tools.
