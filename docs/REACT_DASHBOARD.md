# React dashboard / React 面板

## Stack and local build

- React / React DOM 19.3.0, Radix Themes 3.3.0, Lucide React 1.52.0; versions pinned in the package lockfile.
- Lightweight Charts 5.2.1 stays the chart engine; no migration of market calculations into UI components.
- `ui/main.jsx` mounts the app and error boundary. `ui/App.jsx` owns navigation, preferences, request state and writes.
- `ui/components/` separates market/portfolio views, chart lifecycle, evidence/journal cards and editors.
- `ui/data.mjs` holds pure presentation checks: missing numbers, actual OHLC, source URLs, freshness, currency-safe holdings and evidence deduplication.
- `ui/styles.css` defines responsive layout and light/dark design tokens; Radix supplies accessible interaction primitives.

```bash
npm ci
npm run build:ui   # UI-only development build; reload the running local page
npm run build      # UI + MCP bundle + installable plugin assets/licenses
npm test
npm run check
npm run smoke
npm run demo
```

The page uses only `assets/dashboard.js` and `assets/dashboard.css`; it does not load duplicate legacy globals or remote CDN assets. The linked JavaScript notice file is distributed alongside the bundle. Do not edit generated assets directly. Source changes to HTTP/demo modules require restarting the server; browser bundle changes require a page reload.

## Interaction and safety contracts

- Market: scope-aware breadth, searchable/filterable/sortable watchlist, chart selection, candles/area, daily/intraday, MA overlay, expansion and technical/data-quality/evidence tabs.
- Holdings: saved positions take precedence over embedded report snapshots, including an explicitly empty list. Each currency has a separate summary. Missing or currency-mismatched quotes do not produce valuations.
- Evidence: source links, reporting period/unit/scale, published and available timestamps. The server projects sourced event revisions; forecast dates are marked as tentative. No invented earnings schedule.
- Paper trading: actual Futu SIMULATE accounts, UI-authorized bounded autonomous agent execution, order reconciliation and recorded equity observations. Disabled in synthetic demo mode. See `PAPER_TRADING.md`.
- Journal: original thesis, optional falsifiable pillars, derived scorecards and append-only reviews. The form does not create trading candidates or place orders. Existing backend validation remains authoritative.
- Editors: labeled fields, keyboard-accessible dialogs, loading locks and inline errors. A failed read after a successful write never retries the mutation. Blank invalidation prices preserve existing saved values; they are not a clear action.
- Preferences are stored through the existing API. Theme and color convention are presentation-only browser preferences. Automatic refresh is off by default and skips hidden tabs; it is not an operating-system scheduler.
- Data freshness is recalculated as the page ages. Incomplete OHLC bars are omitted rather than manufactured, and missing numbers are not shown as zero. Price freshness does not override signal eligibility or cross-source conflicts.
- Demo requests use isolated synthetic in-memory data. Selected symbols and saved positions affect refresh; unknown demo symbols return an explicit unavailable item rather than fabricated prices.

## Verification

`tests/react-dashboard.test.mjs` covers all five routes via server rendering, empty and escaped content, pure presentation contracts, network error handling, selected/unknown/empty demo scopes and isolated HTTP save-refresh-review flows. `scripts/smoke-local.mjs` also checks the packaged local assets and linked notices. Browser review should additionally check chart resize/cleanup, expanded charts, theme changes, dialog keyboard behavior and narrow-screen scrolling.

The interface preserves source and licensing disclosures. See `THIRD_PARTY_NOTICES.md`. No commercial data subscription, release publication or installed-plugin replacement is implied by a local build.
