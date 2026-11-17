# External agents and MCP

## Contract

Duckpad provides a **stdio** Model Context Protocol server with `duckpad mcp`.
The client starts that process locally. It forwards tools to a running Duckpad
instance over its authenticated HTTP API; it never opens the instance directory
or starts a second execution engine. Use HTTPS for remote instances. The MCP
wire protocol is handled by the [official Python SDK](https://github.com/modelcontextprotocol/python-sdk/tree/v1.x).
There is no remote MCP HTTP/SSE listener and no OAuth discovery endpoint.

Authentication uses an existing Duckpad API token, provided through
`DUCKPAD_TOKEN` or `--token-file`. Tokens inherit their account's current project
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
or declines. API tokens and MCP tools cannot approve. `launch_approved_run` then
uses the existing execution service, rechecks permissions and the approved
configuration, and consumes the approval once. Changed definitions, connections,
environment settings or Python policy require a fresh proposal. Pending approvals
expire after 15 minutes and are revoked on server restart. They are bound to the
requesting token, branch and configuration. Run records follow normal retention.

## Connect a client

Install Duckpad on the client machine and start the target instance normally:

```sh
pip install duckpad
duckpad start
```

Create a token in User settings (or a service-account token as an administrator).
Store it in a private file outside project Git. A client supporting stdio MCP can
use this configuration, substituting its own token-file path and server address:

```json
{
  "mcpServers": {
    "duckpad": {
      "command": "duckpad",
      "args": ["mcp", "--server", "http://127.0.0.1:8765", "--token-file", "/path/to/private/token"]
    }
  }
}
```

Alternatively set `DUCKPAD_SERVER` and `DUCKPAD_TOKEN` in the client process's
private environment. Do not paste credentials into prompts, project files or
client configuration committed to Git. Standard output is reserved for MCP;
diagnostics use standard error. Redirects are refused, and failed mutations are
never automatically retried.

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
   node. Share the returned review path with a human; open it on the same Duckpad
   server after signing in. Poll `read_approval`, then `launch_approved_run`.
7. `wait_for_run` and `inspect_run` read status and bounded diagnostics.
   `read_schemas`, `preview_output` and `explain_value` read results and lineage.
   `cancel_run` requests cancellation through the same service as the UI.

`preview_output` reads already materialized data; it never starts a run. To compute
a preview, request an approved run scoped to its node. Existing data and lineage
remain subject to current project connection grants. Connection credentials are
redacted from all tool outputs, including errors and logs. External writes that
have already happened cannot be undone by cancellation.

Validate without the UI using the same server-side validator:

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
