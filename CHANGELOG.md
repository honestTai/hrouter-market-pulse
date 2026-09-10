# Changelog

## 1.2.1 - automatic market data failover

- Continue quote analysis, strategy selection and price alerts with a usable Yahoo or Tencent source when the other is unavailable; retain single-source warnings and block genuine cross-source conflicts.
- Fall back to Tencent daily history for indicators and historical research, validating OHLCV and aligning available adjusted prices by session date. Resolve US history symbols from Tencent metadata.
- Keep valid snapshots when history fails, and preserve freshness, corporate-action coverage and model qualification checks.

## 1.2.0 — managed automatic updates

- Opt-in, per-user auto-updater for stable GitHub Releases (macOS LaunchAgent, Linux user timer, Windows Scheduled Task), with manual status/check/disable/rollback controls.
- Complete-plugin updates verified with bounded downloads, SHA-256, safe file manifests and isolated MCP/dashboard health checks.
- Runtime leases defer replacement while a plugin process is alive; transaction recovery and a previous-version snapshot protect failed updates without touching report data.
- Explicit migration for existing installs; disabled/uninstalled or externally changed plugins are not automatically re-enabled.
- Cross-platform release validation and draft-first publication of a ZIP, update bundle, metadata and checksums.
- Automatic updating requires a one-time managed installation; publishing this version cannot retrofit old installations silently.


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
