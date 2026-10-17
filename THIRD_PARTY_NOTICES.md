# Third-party notices

Hrouter Market Pulse source code is MIT licensed. Included dependencies retain their original licenses.

| Component | License | Purpose |
| --- | --- | --- |
| TradingView Lightweight Charts 5.2.1 | Apache-2.0 | Financial charts |
| React / React DOM 19.3.0 | MIT | Component rendering and client lifecycle |
| Radix UI Dialog 1.3.1 | MIT | Accessible dialogs |
| TanStack Router 1.170 / TanStack Query 5.104 | MIT | Routing and data fetching |
| Tailwind CSS 4.3.3 | MIT | Styles (compiled at build time) |
| sonner 2.0.8 | MIT | Notifications |
| clsx 2.1.1 / tailwind-merge 3.7.0 | MIT | Class names |
| Lucide React 1.52.0 | ISC | Interface icons |
| Geist and Geist Mono (Fontsource 5.3.0) | SIL OFL 1.1 | Interface fonts |
| Model Context Protocol TypeScript SDK | MIT | MCP transport and tools |
| Zod | MIT | Input schemas |

Lightweight Charts is copyright TradingView, Inc.; its supplied copyright notices are retained in the distributed library and license. The chart includes attribution linking to [TradingView](https://www.tradingview.com/). Upstream project: https://github.com/tradingview/lightweight-charts . Full license: `assets/vendor/LICENSE-lightweight-charts`.

Lucide is maintained by its contributors; see https://lucide.dev/ and `assets/vendor/LICENSE-lucide` for its full copyright and license text.

React, Radix, TanStack and font license texts are retained in `assets/vendor/licenses/`. Browser dependencies and fonts are bundled locally into `assets/app/`, not loaded from a CDN.

Bundled direct and transitive dependencies have their license texts collected in `assets/vendor/licenses/` by the build process. Market data, issuer documents, names and exchange marks remain subject to their owners' terms. The MIT license for this software does not grant redistribution rights to third-party market data.

## Financial-services research workflow reference

The financial-results review, thesis scorecard and catalyst-calendar workflows draw on concepts from Anthropic's `financial-services` reference skills, distributed under Apache-2.0:
https://github.com/anthropics/financial-services/tree/574ed3624aebd0418c7e96cd101262f30210ab26

Reference skills: `earnings-analysis`, `earnings-preview`, `thesis-tracker`, and `catalyst-calendar` under `plugins/vertical-plugins/equity-research/skills/`.
The upstream license is retained at `licenses/financial-services-APACHE-2.0.txt`.
Hrouter's adaptations (2026-10-04) use its own evidence contracts, deterministic comparisons, append-only journals, bilingual UI and existing safety gates. They do not bundle Anthropic's runtime, its connector configuration, or commercial financial datasets. Reference examples are not investment recommendations. Data-provider access, caching and redistribution require separate authorization.

## Built-in trader skill library

`library/` adapts the methods of the following open-source trading skills to this workbench's own, verified data tools. Upstream scripts, data clients and API keys are not bundled or executed; each adapted skill credits its source in its first lines. `library/catalog.json` records the exact upstream commit each adaptation was read from. Personas are stylized approximations of public investment philosophies, not the people themselves and not endorsements. Nothing here is investment advice.

| Upstream | Commit | License | Used for | License text |
| --- | --- | --- | --- | --- |
| [tradermonty/claude-trading-skills](https://github.com/tradermonty/claude-trading-skills) | b29c6dfc | MIT | pre-trade gate, position sizing, loss circuit breaker and exposure posture, trade review, CANSLIM, VCP | `licenses/tradermonty-claude-trading-skills-LICENSE.txt` |
| [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents) | e8f5503e | Apache-2.0 | analyst / bull-bear / trader / risk / portfolio-manager role structure | `licenses/TauricResearch-TradingAgents-LICENSE.txt` |
| [virattt/ai-hedge-fund](https://github.com/virattt/ai-hedge-fund) | 78b779c1 | MIT | investor panel checklists (Buffett, Munger, Graham, Lynch, Druckenmiller) | `licenses/virattt-ai-hedge-fund-LICENSE.txt` |
| [shouldnotappearcalm/a-share-skill](https://github.com/shouldnotappearcalm/a-share-skill) | 8874bd1c | MIT | A-share trend pullback rules and parameters, MACD trend resonance grading; starter strategies `trend-pullback`, `macd-resonance` | `licenses/shouldnotappearcalm-a-share-skill-LICENSE.txt` |
| [wbh604/UZI-Skill](https://github.com/wbh604/UZI-Skill) | 2c5505d9 | MIT | listed only (hot-money / LHB skills need data not yet available) | `licenses/wbh604-UZI-Skill-LICENSE.txt` |
| [simonlin1212/vibe-astock](https://github.com/simonlin1212/vibe-astock) | d5bf80d2 | Apache-2.0 | listed only (emotion-cycle skills need data not yet available) | `licenses/simonlin1212-vibe-astock-LICENSE.txt` |

## Optional Futu bridge

The locally authored Python bridge calls the separately installed official `futu-api` SDK (pinned at 10.11.7108 in `bridges/futu/requirements.txt`). The SDK/OpenD are not bundled in the plugin. Their licenses, account permissions, API limits, market-data terms and simulation limitations apply separately. The adapter is not affiliated with or endorsed by Futu, and does not grant access to paid data or real-money trading.
