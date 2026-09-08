# Contributing

Use Node.js 20 or newer. Run `npm ci`, `npm run build`, `npm test`, and `npm run smoke` before opening a pull request. Both source and the generated installable package must match; rerun the build after changing assets, tools, or skills.

For financial calculations, provide independent expected values and fixtures that exercise missing data, market sessions, currencies, corporate actions, and timestamp availability. Do not weaken a validation condition to make a fixture pass. Provider tests must be offline and deterministic; live-provider checks should report their timestamp and failure separately.

UI changes must include Chinese and English labels, desktop and narrow-screen checks, keyboard focus, and explicit loading, missing-data and error states. Use synthetic data for public screenshots.

Keep pull requests focused. Describe the concrete trigger, before/after behavior, assumptions, and validation. Do not commit local reports, holdings, account details, credentials, tokens, or `.env` files.

Website: https://hrouter.net/
