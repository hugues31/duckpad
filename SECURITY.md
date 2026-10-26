# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Report a vulnerability** button on the repository's Security tab. Do not open a public issue or pull request for a suspected vulnerability.

Include the affected version, a description of the impact and the steps to reproduce it. You will receive an acknowledgment, and a fix will be coordinated with you before public disclosure.

## Supported versions

Security fixes are released for the latest published version.

## Deployment model

Duckpad is designed as a single-user workspace that listens on `127.0.0.1` by default.

- All API routes except login require a session; the administrator password is shown once, at the first start.
- Connections and their secrets are stored in the instance directory, which is created with owner-only permissions. Keep that directory private.
- SQL templates and connector definitions run with the permissions of the Duckpad process. Only import projects and connectors that you trust.
- Before exposing Duckpad on a network, put it behind an HTTPS reverse proxy and set `DUCKPAD_SECURE_COOKIES=1`.
