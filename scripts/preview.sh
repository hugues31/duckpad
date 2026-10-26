#!/usr/bin/env bash
# Use the server's existing Coolify integration with Duckpad's build settings.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export PATH="$HOME/.local/bin:$PATH"
helper="${COOLIFY_PREVIEW_HELPER:-$HOME/.claude/skills/coolify-preview/preview.sh}"
if [[ ! -x "$helper" ]]; then
    echo "Coolify preview helper is not installed at $helper." >&2
    exit 1
fi
export PREVIEW_BUILD_PACK=dockerfile PREVIEW_PORT=8765
export PREVIEW_TIMEOUT="${PREVIEW_TIMEOUT:-1200}"
export COOLIFY_GITHUB_APP_UUID="${COOLIFY_GITHUB_APP_UUID:-configured-github-app}"
if [[ -z "${COOLIFY_TOKEN:-}" && -r "$HOME/.coolify/multica-token" ]]; then
    export COOLIFY_TOKEN
    COOLIFY_TOKEN="$(cat "$HOME/.coolify/multica-token")"
fi
case "${1:-}" in
    deploy)
        slug="${2:?Usage: scripts/preview.sh deploy <ticket-slug> [branch]}"
        branch="${3:-$(git branch --show-current)}"
        [[ -n "$branch" ]] || { echo "Specify a branch when HEAD is detached." >&2; exit 1; }
        git check-ref-format --branch "$branch" >/dev/null
        local_commit="$(git rev-parse "$branch")"
        remote_commit="$(git ls-remote --exit-code origin "refs/heads/$branch" | cut -f1)"
        [[ "$local_commit" == "$remote_commit" ]] || {
            echo "Push $branch to origin before deploying its preview." >&2
            exit 1
        }
        "$helper" deploy "$slug" https://github.com/hugues31/duckpad "$branch"
        python3 scripts/verify_preview.py "https://$slug.app.example.invalid" --commit "$local_commit"
        ;;
    status|destroy) exec "$helper" "$@" ;;
    *) echo "Usage: scripts/preview.sh {deploy <slug> [branch]|status <slug>|destroy <slug>}" >&2; exit 2 ;;
esac
