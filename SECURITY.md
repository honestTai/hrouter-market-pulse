# Security

The dashboard binds to `127.0.0.1`. It is a local application, not an authenticated multi-user web service. Do not expose its port to the public internet. Browser mutations require a same-origin request and JSON content type; static routes are allowlisted.

This project has no order-execution integration and stores no brokerage or model API credentials. Public data queries still leave the local machine. Official-record imports allow only HTTPS exchange and regulator hostnames; an allowed hostname does not independently prove user-supplied document contents.

Report reproducible vulnerabilities using GitHub private vulnerability reporting when enabled. Do not put sensitive data in public issues. For contact and project updates, visit https://hrouter.net/ .

## Automatic update trust

Automatic updates are opt-in and execute future stable code published by this repository. HTTPS and SHA-256 detect transfer/package inconsistencies; they are not independent publisher signatures and do not protect against a compromised maintainer or release workflow. See [AUTO_UPDATE.md](docs/AUTO_UPDATE.md) for source restrictions, integrity checks, runtime coordination, disabling and rollback. The updater never deletes or migrates report/preferences storage.
