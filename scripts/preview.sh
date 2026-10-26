#!/usr/bin/env bash
# Use the server's existing Coolify integration with Duckpad's build settings.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export PATH="$HOME/.local/bin:$PATH"
config="${DUCKPAD_PREVIEW_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/duckpad/preview.env}"
if [[ -f "$config" ]]; then
    set -a
    # This is trusted, operator-owned shell configuration kept outside Git.
    source "$config"
    set +a
fi
helper="${COOLIFY_PREVIEW_HELPER:-}"
if [[ "${1:-}" != verify && ! -x "$helper" ]]; then
    echo "Set COOLIFY_PREVIEW_HELPER in the private preview configuration." >&2
    exit 1
fi
export PREVIEW_BUILD_PACK=dockerfile PREVIEW_PORT=8765
export PREVIEW_TIMEOUT="${PREVIEW_TIMEOUT:-1200}"
if [[ -z "${COOLIFY_TOKEN:-}" && -n "${COOLIFY_TOKEN_FILE:-}" ]]; then
    export COOLIFY_TOKEN
    COOLIFY_TOKEN="$(cat "$COOLIFY_TOKEN_FILE")"
fi
slug="${2:-}"
[[ "$slug" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "Specify a lowercase ticket slug." >&2; exit 2; }
case "${1:-}" in
    deploy)
        : "${DUCKPAD_PREVIEW_DOMAIN:?Set DUCKPAD_PREVIEW_DOMAIN in the private preview configuration}"
        : "${COOLIFY_API_URL:?Set COOLIFY_API_URL in the private preview configuration}"
        docker image inspect duckpad-python:3.12-duckdb2.0.0 >/dev/null 2>&1 || {
            echo "Run bash scripts/provision-runtime.sh once before deploying previews on this server." >&2
            exit 1
        }
        branch="${3:-$(git branch --show-current)}"
        [[ -n "$branch" ]] || { echo "Specify a branch when HEAD is detached." >&2; exit 1; }
        git check-ref-format --branch "$branch" >/dev/null
        # A managed worktree can publish HEAD under a different PR branch name.
        local_commit="$(git rev-parse HEAD)"
        remote_commit="$(git ls-remote --exit-code origin "refs/heads/$branch" | cut -f1)"
        [[ "$local_commit" == "$remote_commit" ]] || {
            echo "Push $branch to origin before deploying its preview." >&2
            exit 1
        }
        repository="${DUCKPAD_REPOSITORY_URL:-$(git remote get-url origin)}"
        "$helper" deploy "$slug" "$repository" "$branch"
        python3 scripts/verify_preview.py "https://$slug.$DUCKPAD_PREVIEW_DOMAIN" --commit "$local_commit"
        ;;
    verify)
        : "${DUCKPAD_PREVIEW_DOMAIN:?Set DUCKPAD_PREVIEW_DOMAIN in the private preview configuration}"
        python3 scripts/verify_preview.py "https://$slug.$DUCKPAD_PREVIEW_DOMAIN" --commit "${3:-$(git rev-parse HEAD)}"
        ;;
    status|destroy) exec "$helper" "$@" ;;
    *) echo "Usage: scripts/preview.sh {deploy <slug> [branch]|verify <slug> [commit]|status <slug>|destroy <slug>}" >&2; exit 2 ;;
esac
