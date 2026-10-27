# Project Git history and synchronization

Duckpad versions project definitions automatically. Git synchronization applies to
each project managed inside Duckpad. Results, uploaded source data, connection
credentials, exports and databases remain outside its declarative repository.

## Commit authors

Project creation, saves, imports, conflict resolutions and reviewed merges record
both the Git author and committer from the authenticated account. Concurrent
sessions keep separate identities. The shared author setting and `/api/identity`
endpoint have been removed; existing commits keep their original attribution.

Local accounts use their username and a stable technical address,
`<account-id>@users.duckpad.invalid`. SSO accounts use the name (or preferred
username) and verified email from the validated ID token, refreshed on sign-in.
If those claims are missing or invalid, Duckpad falls back to the account's
username and technical address. Provider claims never change account linkage,
which still uses issuer and subject. Git author information is part of the project
history and travels with it when pushed to a remote.

File edits outside Duckpad have no authenticated actor. The watcher and any
pending external edits finalized before a save or run use
`Duckpad external changes <external@duckpad.invalid>`, rather than attributing
them to whichever account happened to make the next request.

## Compare versions

Open **Git synchronization** beside the branch selector, or **Compare versions**
in History. Choose **A: reference** and **B: target** from local branches, fetched
remote branches, commit IDs or **Working files**. The resolved commits, author and
date appear below each selection. **Swap A/B** reverses the comparison.

Working files are captured once. **Capture working files** takes a new snapshot;
retrying the same comparison retains the existing capture and resolved commits.
Captures are bounded in memory and expire on server restart. Select Working files
again if an old capture has expired. Selections and filters are remembered per
worktree for the browser session.

The comparison workspace includes a resizable element list, read-only graph and
before/after inspector. Added (`+`), removed (`−`), modified (`~`) and unchanged
(`=`) elements remain distinguishable without color. Deleted nodes and connections
are inspectable. SQL uses Monaco's read-only diff editor. Component definitions,
boundary ports, exposed parameters, node parameters and documentation have their
own logical entries, identified by stable IDs and component paths.

Use **Only changes**, category filters, search, previous/next and **Focus on
change** to navigate. Processing/configuration, documentation/names and canvas
layout are separate categories. A layout change alone claims no processing impact.

**Potential impact** follows dependencies in both versions, including expanded
nested instance paths and before/after wiring. This is partial, static analysis:
it does not resolve runtime schemas or prove that result values changed. Invalid
or unsupported definitions are reported as partial. Comparing never runs SQL,
reads source data, publishes outputs, switches branches or flushes external edits.

Expand Git history to load older pages. **Element history**, also available in
the node inspector, filters by a node, template or component ID. **Compare with
parent** uses the actual first Git parent; merge commits also offer their other
parents. A root commit compares with an empty tree.

## Branches and reviewed merges

The Branches view lists local and fetched remote identity, head and worktree state.
Create a branch from a chosen commit or branch, or open an existing local branch
in its isolated worktree. Opening it preserves the other worktrees.

Choose an explicit source and destination, compare them, then select **Review
merge**. The review displays the common base and exact heads. For every conflicting
field, inspect base/current/incoming values and choose one. Each choice recomputes
the proposed changes and validates the combined definitions, references, ports and
graph. Correct invalid definitions on their branch and start a fresh review.

**Apply reviewed merge** requires all conflicts and validation errors to be
resolved. The server rejects changed heads (including same-content commits),
pending external saves, changed fetched state and changed remote configuration.
It never implicitly saves dirty work to make a review succeed. Cancelled or
rejected reviews leave local work intact. Successful integration retains both
parents when the source was not already integrated. Execution remains a separate
manual action; applying never pushes.

After integration, an optional cleanup action removes an integrated source branch
and its worktree. Main, the currently open worktree, the destination, dirty work,
untracked files, active executions and unmerged commits are protected. Cleanup
is explicit; no branch is deleted automatically.

## Origin, fetch, pull and push

A project administrator configures one **origin** and an explicit mapping from
the current local branch to its remote branch. Origin is shared across worktrees;
each branch has its own mapping. Settings live in instance metadata and Git's
shared configuration, outside versioned project files. Disconnecting origin keeps
local work and commits. External edits to origin's URL require reviewing and
saving its configuration again in Duckpad.

Use HTTPS without credentials (for example `https://example.com/team/project.git`)
or SSH (`git@example.com:team/project.git` or
`ssh://git@example.com/team/project.git`). Passwords, tokens, URL query strings and
unsupported transports are rejected. Network Git runs on the Duckpad server and
uses its configured credential helper or SSH keys and trusted hosts. Authentication
errors never echo raw Git output. Each network operation has a 30-second limit.

1. **Fetch** updates remote-tracking references and the last successful check. It
   does not change local branches or project files. The status distinguishes an
   unverified remote, up-to-date/ahead/behind/diverged branches, a first publication,
   a deleted remote branch and unrelated histories.
2. **Review incoming changes** uses the displayed fetched head and opens the same
   semantic review as a local merge. Fetch again first when newer remote knowledge
   is needed. Unrelated or invalid incoming definitions cannot be adopted.
3. **Review publication** shows the definitions that the displayed local commit
   would publish. **Publish reviewed commit** publishes that exact commit to the
   displayed branch. The fetched remote head must be its ancestor. An exact-head
   lease rejects a remote race, including an update between inspection and push.
   This lease never authorizes a non-fast-forward replacement. Fetch and integrate
   incoming commits before retrying a divergence. Recreating a deleted remote
   branch requires an explicit checkbox.

Publication and adoption validate the complete reachable history for allowed
declarative files, regular file modes and the project `.gitignore`. A deleted
non-project file still exists in history and therefore blocks synchronization.
Repositories with more than 10,000 reachable commits require a smaller project
repository. These checks do not inspect data sources or run project SQL.

Readers can inspect authorized comparisons, history and synchronization state.
Project editors can create/open branches, fetch, review/apply integration, publish
and clean up integrated work. Configuring/disconnecting origin or changing its
mapping requires project administrator access. Instance administrators retain their
existing access to projects. All permissions are checked by the server.

## Automatic commit subjects

Subjects are derived from the actual saved semantic changes. They use English
Conventional Commits: `feat` for processing changes, `docs` for descriptions/names,
`style(canvas)` for movement, and `chore(merge)` for integration. A parameter edit
does not claim to fix a bug. Imports and conflict resolution retain their context;
external batches are marked `[external]`.

Single-element subjects identify the action and readable name. Multi-element
saves report accurate counts and include a bounded body of affected elements,
fields and categories. Parameter values and SQL statements are omitted. Existing
history is not rewritten, no-op saves add no commit, and ordinary edits still
require no commit dialog.

## Verification

Backend tests exercise semantic categories, nested scopes, immutable comparisons,
commit subjects, actual merge parents, pagination, stale reviews, role enforcement,
dirty work, divergence, concurrent remote advancement, remote deletion/recreation,
invalid imports, unsafe ancestry and sanitized network failures. Git integration
tests use disposable bare repositories. Browser tests cover comparison, field
conflict resolution, synchronization, stale responses and narrow layouts. Their
disposable server replaces only the network transport with local bare repositories;
production authentication and real network reachability remain operator settings.
