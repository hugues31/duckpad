# Single sign-on with OpenID Connect

Instance administrators can configure one OIDC provider in **Settings → Single
sign-on (OIDC)**. Password sign-in remains available. Keep the local administrator
credentials for recovery if the provider becomes unavailable.

1. Register a confidential web application with your identity provider. Enable
   the authorization code grant and PKCE S256. Duckpad supports
   `client_secret_basic` and `client_secret_post` authentication, and RSA or EC
   signed ID tokens published through the provider's JWKS endpoint.
2. Enter the provider's **Issuer URL**, exactly as returned by its OIDC discovery
   document, the **Client ID**, and the **Client secret**. For example, an issuer
   can be `https://identity.example.com/realms/team`.
3. Set **Application URL** to the public origin of this Duckpad instance, such as
   `https://duckpad.example.com`. Copy the displayed **Redirect URI** into the
   provider's allowed redirect URLs: it ends in `/api/oidc/callback`. HTTPS is
   required; HTTP loopback URLs are accepted for local development. When using a
   TLS reverse proxy, set `DUCKPAD_SECURE_COOKIES=1`.
4. Choose the sign-in button label and whether to create member accounts on first
   sign-in. Restrict access to this client in the provider before enabling it.
5. Enable single sign-on and save. Saving an enabled configuration validates
   discovery and supported protocol features. This does not verify the client
   credentials; complete a sign-in in a separate browser session to test them.

The sign-in page offers both SSO and local password authentication. Duckpad
requests the `openid profile email` scopes. A successful first sign-in creates a
member with no access to existing private projects. Administrators can grant
project membership, change roles, and deactivate SSO users from the existing
administration interface. Disabling account creation still permits previously
provisioned SSO users to sign in.

Accounts are matched only by the verified `(issuer, sub)` pair, never by email or
username. A generated `-sso-` suffix distinguishes their usernames from local
accounts; the UI marks them as SSO. Provider role claims do not grant Duckpad
privileges. Password changes and password resets do not apply to SSO accounts.
At least one active local administrator must remain available.

Settings and the client secret live in the protected instance database, outside
project Git repositories. The API never returns the secret. Leave its field
blank to retain it; changing the issuer or client ID requires a new secret.
Protect the instance directory and its backups: the database is not encrypted
at rest. No provider access, refresh or ID tokens are retained after sign-in.

Every settings save invalidates pending sign-ins and existing SSO sessions.
Disabling SSO hides the login button and prevents new SSO authentication. Account
deactivation immediately invalidates that user's sessions. Duckpad sessions
expire after seven days; provider-side revocation is not continuously polled.
Signing out ends the Duckpad session only, so the provider may still have an
active login. Provider logout, group mapping, multiple providers, and automatic
linking of existing local accounts are not supported.

The code flow uses one-time, ten-minute state bound to an HttpOnly browser cookie,
PKCE S256, and nonce validation. ID token verification checks the signature,
issuer, audience, authorized party, subject, and token lifetime. Callback failures
return a generic retry message without displaying provider errors or tokens.
The Duckpad CLI redacts callback query parameters from its access log; configure
any upstream proxy to redact them as well.
