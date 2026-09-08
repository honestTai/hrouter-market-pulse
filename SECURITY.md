# Security

The dashboard binds to `127.0.0.1`. It is a local application, not an authenticated multi-user web service. Do not expose its port to the public internet. Browser mutations require a same-origin request and JSON content type; static routes are allowlisted.

This project has no order-execution integration and stores no brokerage or model API credentials. Public data queries still leave the local machine. Official-record imports allow only HTTPS exchange and regulator hostnames; an allowed hostname does not independently prove user-supplied document contents.

Report reproducible vulnerabilities using GitHub private vulnerability reporting when enabled. Do not put sensitive data in public issues. For contact and project updates, visit https://hrouter.net/ .
