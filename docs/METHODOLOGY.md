# Data and methodology / 数据与方法

These are explicit implementation assumptions for version 1.1.0. They are not a claim of profitable trading performance.

## Quote integrity

Yahoo Finance and Tencent Finance provide quote snapshots with automatic failover. If one source fails or has an unusable timestamp, the other usable source can support signals and alerts, explicitly marked as single-source. When both sources are usable, agreement checks currency, price difference, timestamps and freshness; detected conflicts still block signals. Price agreement alone is insufficient. Current regular-session signals require usable data and the final quote-level `signalEligible` gate. Default freshness permits public-feed delay; it does not certify real-time delivery.

Daily history falls back from Yahoo to Tencent, aligning raw and available forward-adjusted rows by session date. Tencent history may be shorter than requested and may lack adjustment or corporate-action records; sample counts, price basis and warnings remain explicit. Missing history does not discard a valid snapshot. Intraday bars remain Yahoo-only and can be unavailable independently. Execution and prediction retain their existing corporate-action and validation requirements.

The included calendars cover **2026** regular sessions in mainland China, Hong Kong and the US, including listed holidays and configured half-days. Dates outside verified coverage do not qualify for fresh trading signals. Exceptional closures need dated calendar evidence; instrument-specific holding and price-limit exceptions require separate verified trading rules. Sources: [SSE 2026 holidays](https://www.sse.com.cn/disclosure/announcement/general/c/c_20251222_10802507.shtml), [HKEX 2026 holidays](https://www.hkex.com.hk/-/media/HKEX-Market/Services/Circulars-and-Notices/Participant-and-Members-Circulars/SEHK/2025/ce_SEHK_CT_075_2025.pdf), [NYSE hours and calendars](https://www.nyse.com/trade/hours-calendars).

## Indicators

Daily MA values require the indicated number of valid observations. RSI uses Wilder smoothing; an unchanged price series has neutral RSI rather than an overbought reading. Missing prices are not converted into zeros, and incomplete current-day candles do not become finalized daily observations. Intraday charts are five-minute bars; same-time relative volume requires complete matching clock slots across a minimum number of historical sessions. Daily volume divided by a full-day average is not called intraday relative volume.

## Position budgets

Position ceilings obey user-supplied risk and allocation limits, available cash and remaining aggregate risk after existing holdings. Native quote prices and account currency cannot be mixed. Live budget FX inputs carry a rate, direction, timestamp and source; stale or missing conversion data is rejected. Rounded executable quantities require a known lot size. These are mathematical ceilings; gap risk and failed exits can still exceed modeled loss.

## Backtests

Signals use completed daily information, with entry at a subsequent opening session. Ordinary A-share holding restrictions prevent new same-session round trips. Unsupported instrument rules require explicit verification. Shared account cash and concurrent positions form the portfolio curve; independent trade returns are not compounded as though every trade had access to all capital.

Execution includes configured fees and adverse slippage, no-volume or flagged nonfills, blocked limit-price fills and deferred exits. Split/dividend handling preserves position economics; inconsistent unexplained adjustments invalidate affected histories. Yahoo's split-adjusted history must not cause a split to be counted twice. Native currencies require conversion into the account currency. Backtest FX inputs are fixed scenario rates, not a historical FX-return model.

Survivorship, delistings, queue position, full depth, tax schedules and every exceptional market rule are not completely modeled. An instrument's default board rule is not sufficient evidence for ST, IPO, fund or special-session execution. Refer to the returned assumptions, skipped trades, exclusions and source coverage.

## Forecast qualification

The technical probability baseline uses purged chronological walk-forward folds. Evaluation windows do not overlap, and training labels that resolve at or after a fold's evaluation boundary are excluded. It compares against a training-prevalence baseline and records calibration and drift.

Current default qualification requires at least three valid folds, at least 90 out-of-sample observations, AUC of at least 0.55, Brier score and log loss better than the baseline, calibration error at most 0.10, and positive Brier skill in every fold. Missing/stale features and detected drift block qualification. These are transparent research gates, not universal statistical guarantees; correlated labels and a finite sample remain limitations.

Unqualified probabilities are withheld from actionable output. Forecasts are recorded with model version and server time before an outcome is resolved. Eligibility lasts at most 24 hours and ends on resolution, supersession or a newer unsuccessful assessment. Qualified means eligible for research review, not a recommendation to buy. Candidate decisions additionally require an active qualified record, a current usable quote without a cross-source conflict, supporting evidence, explicit conditions and a computable risk allocation.

## Evidence, events and context

Official built-in adapters target [SEC EDGAR submissions and company facts](https://www.sec.gov/search-filings/edgar-application-programming-interfaces) and [CNINFO disclosures](https://www.cninfo.com.cn/). Adapters may be blocked or rate-limited. [HKEXnews](https://www1.hkexnews.hk/search/titlesearch.xhtml?lang=en) currently uses original-record import. Host allowlisting is a transport/origin check, not proof that imported text matches a document.

First ingestion is the default historical availability time. An announced calendar event requires an explicit date and source; an earnings date is not invented from previous reports. Financial concepts preserve period, unit and filing accession. Date-only publication metadata is marked as such and never grants availability before first ingestion.

Breadth and sector aggregation default to the configured watchlist, not the entire exchange. Full-market breadth accepts separately sourced universe counts with explicit scope, timestamp and supporting evidence. Relative returns use matched completed sessions. Decision reviews append observations to the original thesis and do not manufacture realized P&L.
