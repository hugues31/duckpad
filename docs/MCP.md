# External agents and MCP

## Contract

Duckpad serves the Model Context Protocol itself, over **Streamable HTTP**, at
`/api/agent/mcp` on the instance address. Clients connect with an address and an
API token, or with the address alone when they sign in through OAuth, as the
claude.ai and ChatGPT connectors do ([web apps and OAuth](#web-apps-and-oauth)).
Nothing is installed on the client machine. The endpoint is stateless:
each POST gets one JSON response, with no session to resume and no server-initiated
stream (GET and DELETE answer 405). For clients that only start local processes,
`duckpad mcp` is a **stdio** bridge that forwards the same tools to the instance's
HTTP API. Neither transport opens the instance directory or starts a second
execution engine. Use HTTPS for remote instances. The MCP wire protocol is handled
by the [official Python SDK](https://github.com/modelcontextprotocol/python-sdk/tree/v1.x).

Authentication uses an existing Duckpad API token, sent as
`Authorization: Bearer <token>` (or given to the bridge through `DUCKPAD_TOKEN` or
`--token-file`), or the access token of an app that a person authorized through
OAuth. A browser session cannot call the tools. Tokens inherit their account's
current project
memberships and roles; they do not have independent scopes. For project-scoped
access, use a Member account granted only the intended projects. A Reader can
inspect definitions and existing results; an Editor can
create branches, edit and request execution. Revocation and role changes apply
to every call. The MCP server exposes no account, connection-credential, or
permission-management tools. Existing service accounts remain limited to Reader
or Operator roles and cannot edit or launch ad hoc runs; use an Editor's personal
token for authoring, or a service account's Reader token for inspection.

Edits require a worktree and the revision returned by `validate_project` or a
previous edit. They use the same operation models, validators and Git writer as
the assistant. A stale revision or invalid edit fails without saving the proposal.
The resulting commits are visible in Duckpad's history and comparison tools.

Every execution requires a human decision, including previews and environments
that do not normally ask for confirmation. `request_run` creates a bounded,
expiring proposal and returns a review path. A human signs in to Duckpad, opens
that path, reviews the environment, scope, exports and Python nodes, and approves
or declines. API tokens and MCP tools cannot approve. The approval covers the
commit shown on the review page: once the branch has a newer commit, even one
that restores earlier content, the page no longer offers approval and the launch
is refused. `launch_approved_run` then uses the existing execution service,
rechecks permissions and the approved configuration, and consumes the approval
once. Changed definitions, connections, environment settings or Python policy
require a fresh proposal. A launch refused because another execution holds the
branch starts nothing and keeps the approval for a later attempt. Pending
approvals expire after 15 minutes and are revoked on server restart. They are
bound to the requesting token, branch and configuration. Each account can have
20 requests awaiting a decision, and each token runs up to 4 tool calls at a
time. Run records follow normal retention.

This decision governs the MCP tools. An API token also opens Duckpad's HTTP API
with its account's role, where an Editor can launch runs directly, as automation
clients do. An agent that can read the token (for example from a configuration
file on a machine where it runs shell commands) could bypass the review: keep the
token out of the agent's reach, and give inspection-only agents a Reader's token.
Tokens that apps receive through OAuth only open `/api/agent`, so for them the
human decision is a boundary, not only a policy.

## Connect a client

Create a token in User settings (or a service-account token as an administrator)
and keep it outside project Git. Then point the client at the endpoint. For
example, a project `.mcp.json` for Claude Code that reads the token from the
environment of the client process:

```json
{
  "mcpServers": {
    "duckpad": {
      "type": "http",
      "url": "https://duckpad.example.com/api/agent/mcp",
      "headers": { "Authorization": "Bearer ${DUCKPAD_TOKEN}" }
    }
  }
}
```

The equivalent command is
`claude mcp add --transport http duckpad https://duckpad.example.com/api/agent/mcp --header "Authorization: Bearer $DUCKPAD_TOKEN"`,
which stores the expanded token in Claude Code's user configuration. Other clients
take the same URL and header; use their secret storage for the token. A local
instance answers at `http://127.0.0.1:8765/api/agent/mcp`.

A client that only supports stdio starts the bridge, which needs Duckpad installed
on the client machine (`pip install duckpad`):

```json
{
  "mcpServers": {
    "duckpad": {
      "command": "duckpad",
      "args": ["mcp", "--server", "https://duckpad.example.com", "--token-file", "/path/to/private/token"]
    }
  }
}
```

Alternatively set `DUCKPAD_SERVER` and `DUCKPAD_TOKEN` in the client process's
private environment. Do not paste credentials into prompts, project files or
client configuration committed to Git. The bridge reserves standard output for
MCP and writes diagnostics to standard error. It refuses redirects, never retries
failed mutations, and adds the full `review_url` to run requests.

## Web apps and OAuth

Web connectors such as claude.ai and ChatGPT cannot store a fixed header. They
connect with the endpoint address alone and follow the
[MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
flow, in which Duckpad is the OAuth 2.1 authorization server: the app sends you to
Duckpad, you sign in with your usual method (password or single sign-on), check
which app asks for access and for which account, and allow it. The app then acts
with your account's current project roles, through the agent tools only.

### Requirements

- Duckpad must be served over HTTPS. Apps cannot connect to plain HTTP, except a
  client running on the same computer as Duckpad (`localhost`, `127.0.0.1`).
- claude.ai and ChatGPT connect from their own servers: the instance must be
  reachable from the internet under a public name.
- Behind a reverse proxy, Duckpad must know that its public address uses HTTPS.
  List the proxy in `FORWARDED_ALLOW_IPS` so that Duckpad trusts its
  `X-Forwarded-Proto` header, or set `DUCKPAD_SECURE_COOKIES=1`, and let the proxy
  pass the original `Host` header (see the
  [installation guide](INSTALLATION.md#reverse-proxy)). Otherwise discovery answers
  404 and agent API errors do not advertise OAuth.

### Connect claude.ai

1. Copy the MCP server address from **User settings → Authorized apps**, for
   example `https://duckpad.example.com/api/agent/mcp`.
2. In claude.ai, open **Settings → Connectors** and add a custom connector with
   that address. Keep the default authentication, Claude's published identity; no
   client ID or secret is needed. On Team and Enterprise plans, an owner adds the
   connector for the organization.
3. Select **Connect**. Claude opens Duckpad: sign in if needed, check the app and
   the account, and select **Allow Claude**. You return to Claude, which lists the
   Duckpad tools.

Claude identifies itself with its published client metadata document, so the
consent page shows "Identified by claude.ai". If you chose automatic registration
in Claude instead, the page shows the name the app registered with: check that
the "Returns to" address is `claude.ai`.

### Connect ChatGPT

Add a custom MCP server with the same address and OAuth authentication, where
your plan and workspace policies allow custom servers, then follow the same
sign-in and consent steps. ChatGPT identifies itself as `chatgpt.com`.

### Other MCP clients

Clients that implement MCP authorization need only the address. For example
`claude mcp add --transport http duckpad https://duckpad.example.com/api/agent/mcp`
in Claude Code, then **Authenticate** from its `/mcp` menu. The consent page warns
when an app returns to an address on a computer (`localhost`): allow it only if you
started that connection yourself. Clients that cannot use OAuth keep using an
[API token](#connect-a-client).

### What an authorization allows

- Access tokens work only on `/api/agent` (MCP and the tools HTTP API), only for
  the origin they were issued for, and only for one hour. Every other route
  answers 403, including token management, run launches and the automation API.
- The app uses the account's current roles and memberships: a role change or a
  revoked membership applies to its next call. Runs still need a person's
  approval on the review page; an app cannot approve, even its own requests.
  Approvals stay bound to the authorization when the app renews its tokens.
- The app renews its access with a refresh token that changes at each use. An
  authorization unused for 30 days expires. If an already used refresh token comes
  back, Duckpad revokes the whole authorization, since it may have been copied.
- Run history names the account and, as token name, the app.

### Review and revoke apps

**User settings → Authorized apps** lists the apps allowed to use your account,
with the address they return to, when you allowed them and when they last called
Duckpad. **Revoke** disconnects an app immediately; it needs your approval again
to reconnect. Authorizing the same app again replaces its previous authorization.
Instance administrators see and revoke a person's apps from **Instance settings →
Users and permissions → Tokens and apps**. Deactivating an account revokes all of
its apps for good; reactivating it does not restore them.

### Protocol reference

For client developers and security reviews:

| Item | Value |
| --- | --- |
| Protected resource metadata (RFC 9728) | `/.well-known/oauth-protected-resource/api/agent/mcp`, also at `/.well-known/oauth-protected-resource`. A 401 from `/api/agent` points to it in `WWW-Authenticate` with `scope="agent"`. |
| Authorization server metadata (RFC 8414) | `/.well-known/oauth-authorization-server`; the issuer is the instance origin. |
| Authorization endpoint | `/oauth/authorize`: authorization code with PKCE `S256` (required). Responses carry `iss` (RFC 9207). |
| Token endpoint | `/api/oauth/token`: `authorization_code` and `refresh_token` grants, form-encoded. |
| Client registration | Client ID metadata documents (an HTTPS client ID, preferred) or dynamic registration at `/api/oauth/register` (RFC 7591). |
| Client authentication | `none` with PKCE, or `client_secret_post` / `client_secret_basic` for registered confidential clients. |
| Revocation (RFC 7009) | `/api/oauth/revoke`; revoking any token revokes the whole authorization. |
| Resource (RFC 8707) | `https://<instance>/api/agent/mcp`; another value is refused with `invalid_target`. |
| Scopes | `agent` (always granted); `offline_access` is accepted. Refresh tokens are always issued. |

Redirect URIs must be HTTPS, or HTTP on `localhost`, `127.0.0.1` or `[::1]`, where
any port matches (RFC 8252). They are compared exactly otherwise. Codes are single
use and expire after five minutes; reusing one revokes the tokens it produced.
Duckpad reads a client metadata document only when a signed-in person opens an
authorization request, only from a public address on port 443, without
redirects, within 5 seconds and 8 KiB. It keeps a copy for an hour, and up to a
week while the publisher is unreachable. Metadata documents must name their own
address as `client_id` and allow the `none` authentication method. Dynamic
registrations are limited to 30 per client address and hour; registrations idle
for 30 days without an authorization are deleted.

## Tools and workflow

Tool discovery returns JSON schemas generated from the same validated arguments
used on the server. Each call returns a structured object. Failures set MCP
`isError` and include `error.code`, `error.status`, `error.message` and
`error.details`. Pagination uses `offset`, `limit` and `next_offset` where offered.
Responses have a size limit; use smaller pages when a response is too large.

1. `list_projects` discovers authorized projects and their working branches.
2. `create_branch` creates an editable branch from a discovered worktree.
3. `read_flow`, `read_sql`, `read_file`, `read_documentation`, `read_variables`
   and `list_templates` inspect definitions. `read_guide` reads Duckpad's manual.
4. `validate_project` returns the branch's revision, commit and structured errors.
5. `edit_flow` adds, updates or removes nodes and edges; `write_sql` changes code.
   Both require that revision. Read the returned revision before the next edit.
6. Validate again, then `request_run` with the worktree, environment and optional
   node. Share the returned review path with a human, who opens it on the same
   Duckpad address after signing in. Apps connected through OAuth also receive the
   full `review_url`. Poll `read_approval`, then
   `launch_approved_run`.
7. `wait_for_run` and `inspect_run` read status and bounded diagnostics.
   `read_schemas`, `preview_output` and `explain_value` read results and lineage.
   `cancel_run` requests cancellation through the same service as the UI.

`preview_output` reads already materialized data; it never starts a run. To compute
a preview, request an approved run scoped to its node. Existing data and lineage
remain subject to current project connection grants. Connection credentials are
redacted from all tool outputs, including errors and logs. External writes that
have already happened cannot be undone by cancellation.

Validate without the UI using the same server-side validator. The worktree ID is
the `worktree_...` segment of the branch's page address, or the `worktree` that
`list_projects` returns:

```sh
duckpad validate WORKTREE_ID --server http://127.0.0.1:8765 --token-file /path/to/private/token
```

The command prints JSON and exits 0 for valid definitions, 1 for validation errors,
or 2 for authentication, transport or request failures. Structural validation does
not execute code, prove external connectivity or guarantee runtime success.

## Project instructions template

Append this section to an existing project `AGENTS.md` after reviewing it. Preserve
all existing instructions; do not replace the file or insert instance credentials.

```markdown
## Duckpad agent workflow

- Use the Duckpad MCP tools to inspect the project and its Duckpad authoring guide.
- Create a working branch before editing. Read definitions and schemas first.
- Preserve unrelated nodes, connections, parameters and project instructions.
- Use the latest revision for each edit and run validate_project afterward.
- Report the branch, commit and validation errors so a human can review the diff.
- Request a run only when needed. Ask the human to review its approval page;
  never approve your own execution request or bypass it with another API.
- Inspect status, bounded results and lineage after execution. Report failures.
- Never put credentials in SQL, parameters, comments, instructions or Git.
```
