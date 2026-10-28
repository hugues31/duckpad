# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Report a vulnerability** button on the repository's Security tab. Do not open a public issue or pull request for a suspected vulnerability.

Include the affected version, a description of the impact and the steps to reproduce it. You will receive an acknowledgment, and a fix will be coordinated with you before public disclosure.

## Supported versions

Security fixes are released for the latest published version.

## Deployment model

Duckpad listens on `127.0.0.1` by default. An instance serves individual accounts with instance roles (member or administrator) and private projects with reader, editor and administrator roles, which the server checks on every request.

- All API routes except login and the single sign-on handshake require a session; the initial administrator password is shown once, at the first start.
- Every account can create projects and administers the projects it creates.
- Connections and their secrets are stored in the instance directory, which is created with owner-only permissions. Keep that directory private.
- Project SQL runs in isolated worker processes limited to the project's files and authorized connections. Connector definitions and DuckDB extensions are administrator-installed code that runs with the permissions of the Duckpad process. Only import projects, connectors and extensions that you trust.
- Network Git never uses the SSH keys, agent, SSH or Git configuration, credential helper or Kerberos tickets of the server account. SSH origins use the key that Duckpad generated for the account that triggers the operation, only on hosts whose keys an instance administrator trusts, and only after that account confirmed the project's exact origin URL. HTTPS origins run without credentials and require an allowed URL prefix. The API never returns private keys, and deactivating an account deletes its key.
- What an account's key can read from a confirmed origin becomes visible to the project's members. Add a Duckpad key only to a Git host account whose repository access you accept to share with the projects where you confirm origins. The instance directory holds every account's private key; keep it private and back it up as a secret.
- With single sign-on, enable **Create member accounts on first SSO sign-in** only when every identity that your provider accepts for this client may use the instance.
- Before exposing Duckpad on a network, put it behind an HTTPS reverse proxy and set `DUCKPAD_SECURE_COOKIES=1`. When the proxy runs on another host or container, set `FORWARDED_ALLOW_IPS` to its address so that login throttling applies to each client instead of the proxy as a whole.
