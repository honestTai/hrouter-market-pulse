# Third-party notices

Hrouter Market Pulse source code is MIT licensed. Included dependencies retain their original licenses.

| Component | License | Purpose |
| --- | --- | --- |
| TradingView Lightweight Charts 5.2.1 | Apache-2.0 | Financial charts |
| React / React DOM 19.3.0 | MIT | Component rendering and client lifecycle |
| Radix Themes 3.3.0 and Radix UI primitives | MIT | Accessible dialogs, menus, tabs and theme components |
| Lucide React 1.52.0 | ISC | React interface icons |
| Lucide 1.42.0 | ISC | Legacy compatible vendor asset |
| Model Context Protocol TypeScript SDK | MIT | MCP transport and tools |
| Zod | MIT | Input schemas |

Lightweight Charts is copyright TradingView, Inc.; its supplied copyright notices are retained in the distributed library and license. The chart includes attribution linking to [TradingView](https://www.tradingview.com/). Upstream project: https://github.com/tradingview/lightweight-charts . Full license: `assets/vendor/LICENSE-lightweight-charts`.

Lucide is maintained by its contributors; see https://lucide.dev/ and `assets/vendor/LICENSE-lucide` for its full copyright and license text.

React and Radix license texts are retained in `assets/vendor/licenses/`; linked JavaScript notices are retained at `assets/dashboard.js.LEGAL.txt`. Browser dependencies are bundled locally, not loaded from a CDN.

Bundled direct and transitive dependencies have their license texts collected in `assets/vendor/licenses/` by the build process. Market data, issuer documents, names and exchange marks remain subject to their owners' terms. The MIT license for this software does not grant redistribution rights to third-party market data.

## Financial-services research workflow reference

The financial-results review, thesis scorecard and catalyst-calendar workflows draw on concepts from Anthropic's `financial-services` reference skills, distributed under Apache-2.0:
https://github.com/anthropics/financial-services/tree/574ed3624aebd0418c7e96cd101262f30210ab26

Reference skills: `earnings-analysis`, `earnings-preview`, `thesis-tracker`, and `catalyst-calendar` under `plugins/vertical-plugins/equity-research/skills/`.
The upstream license is retained at `licenses/financial-services-APACHE-2.0.txt`.
Hrouter's adaptations (2026-10-04) use its own evidence contracts, deterministic comparisons, append-only journals, bilingual UI and existing safety gates. They do not bundle Anthropic's runtime, its connector configuration, or commercial financial datasets. Reference examples are not investment recommendations. Data-provider access, caching and redistribution require separate authorization.

## Optional Futu bridge

The locally authored Python bridge calls the separately installed official `futu-api` SDK (pinned at 10.11.7108 in `bridges/futu/requirements.txt`). The SDK/OpenD are not bundled in the plugin. Their licenses, account permissions, API limits, market-data terms and simulation limitations apply separately. The adapter is not affiliated with or endorsed by Futu, and does not grant access to paid data or real-money trading.
