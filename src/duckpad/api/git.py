"""Git HTTP routes."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request

from .. import data_comparison, schemas
from ..types import Record
from ..util import Problem
from .context import Context
from .security import (
    no_api_token,
    worktree_role,
)


def router(ctx: Context) -> APIRouter:
    api = APIRouter()
    projects = ctx.services.projects
    engine = ctx.services.engine

    @api.get(
        "/api/worktrees/{worktree}/git/history",
        response_model=None,
        dependencies=[Depends(worktree_role("reader"))],
    )
    def git_history(
        worktree: str,
        ref: str = "HEAD",
        offset: int = Query(default=0, ge=0),
        limit: int = Query(default=50, ge=1, le=100),
        entity: str | None = None,
    ) -> Record:
        return projects.versioning.history(worktree, ref, offset, limit, entity)

    @api.get(
        "/api/worktrees/{worktree}/git/history/summary",
        response_model=None,
        dependencies=[Depends(worktree_role("reader"))],
    )
    def git_history_summary(worktree: str, entity: str, ref: str = "HEAD") -> Record:
        return projects.versioning.element_summary(worktree, entity, ref)

    @api.get(
        "/api/worktrees/{worktree}/git/tags",
        response_model=None,
        dependencies=[Depends(worktree_role("reader"))],
    )
    def git_tags(worktree: str) -> list[Record]:
        return projects.versioning.tags(worktree)

    @api.post(
        "/api/worktrees/{worktree}/git/tags",
        status_code=201,
        response_model=None,
        dependencies=[Depends(worktree_role("editor"))],
    )
    def git_create_tag(worktree: str, data: schemas.NewTag) -> Record:
        return projects.versioning.create_tag(worktree, data.name, data.commit, data.message)

    @api.get(
        "/api/worktrees/{worktree}/git/compare",
        response_model=None,
        dependencies=[Depends(worktree_role("reader"))],
    )
    def git_compare(worktree: str, a: str = "HEAD", b: str = "working") -> Record:
        return projects.versioning.compare(worktree, a, b)

    @api.get(
        "/api/worktrees/{worktree}/git/branches",
        response_model=None,
        dependencies=[Depends(worktree_role("reader"))],
    )
    def git_branches(worktree: str, integrated_worktree: str | None = None) -> list[Record]:
        branches = projects.versioning.branches(worktree, integrated_worktree)
        if integrated_worktree:
            for branch in branches:
                if branch["worktree"] and not branch.get("cleanup_error"):
                    try:
                        engine.require_idle(branch["worktree"])
                    except Problem as error:
                        branch["cleanup_error"] = str(error)
        return branches

    @api.post(
        "/api/worktrees/{worktree}/git/open",
        response_model=None,
        dependencies=[Depends(worktree_role("editor"))],
    )
    def git_open(worktree: str, data: schemas.NewBranch) -> Record:
        return projects.versioning.open_branch(worktree, data.name)

    @api.post(
        "/api/worktrees/{worktree}/git/cleanup",
        response_model=None,
        dependencies=[Depends(worktree_role("editor"))],
    )
    def git_cleanup(worktree: str, data: schemas.BranchCleanup) -> Record:
        with engine.exclusive(projects.get(worktree)["project"]):
            engine.require_idle(data.remove_worktree)
            removed = projects.versioning.cleanup_records(
                worktree, data.remove_worktree, data.integrated_worktree, data.expected_head
            )
            engine.discard_worktree(data.remove_worktree)
        projects.versioning.cleanup_files(*removed)
        return {"ok": True}

    @api.post(
        "/api/worktrees/{worktree}/git/reviews",
        response_model=None,
        dependencies=[Depends(worktree_role("editor"))],
    )
    def git_review(worktree: str, data: schemas.GitReview) -> Record:
        return projects.versioning.prepare(worktree, data.source)

    @api.post(
        "/api/worktrees/{worktree}/git/review-origin",
        response_model=None,
        dependencies=[Depends(worktree_role("editor"))],
    )
    def git_review_origin(worktree: str) -> Record:
        return projects.versioning.prepare_origin(worktree)

    @api.post(
        "/api/worktrees/{worktree}/git/reviews/{review}",
        response_model=None,
        dependencies=[Depends(worktree_role("editor"))],
    )
    def git_choices(worktree: str, review: str, data: schemas.GitChoices) -> Record:
        return projects.versioning.proposal(worktree, review, data.choices)

    @api.post(
        "/api/worktrees/{worktree}/git/reviews/{review}/apply",
        response_model=None,
        dependencies=[Depends(worktree_role("editor"))],
    )
    def git_apply(worktree: str, review: str, data: schemas.GitApply) -> Record:
        return projects.versioning.apply(worktree, review, data.choices, data.proposal_revision)

    @api.get(
        "/api/worktrees/{worktree}/git/reviews/{review}/data",
        response_model=None,
        dependencies=[Depends(worktree_role("reader"))],
    )
    def git_data_results(worktree: str, review: str, environment: str) -> list[Record]:
        return data_comparison.available_results(
            engine.results, current_review(worktree, review), environment
        )

    @api.post(
        "/api/worktrees/{worktree}/git/reviews/{review}/data",
        response_model=None,
        dependencies=[Depends(worktree_role("reader"))],
    )
    def git_data_comparison(worktree: str, review: str, data: schemas.GitDataComparison) -> Record:
        return data_comparison.compare_result(
            engine.results, current_review(worktree, review), **data.model_dump()
        )

    @api.get(
        "/api/worktrees/{worktree}/git/remote",
        response_model=None,
        dependencies=[Depends(worktree_role("reader"))],
    )
    def git_remote(worktree: str) -> Record:
        return projects.remotes.status(worktree)

    @api.put(
        "/api/worktrees/{worktree}/git/remote",
        response_model=None,
        dependencies=[Depends(worktree_role("admin"))],
    )
    def git_configure(worktree: str, data: schemas.RemoteConfiguration) -> Record:
        return projects.remotes.configure(worktree, data.url, data.remote_branch, data.config_revision)

    @api.post(
        "/api/worktrees/{worktree}/git/consent",
        response_model=None,
        dependencies=[
            Depends(no_api_token("API tokens cannot authorize Git credentials or network Git")),
            Depends(worktree_role("editor")),
        ],
    )
    def git_consent(worktree: str, data: schemas.GitConsent, request: Request) -> Record:
        return projects.remotes.consent(worktree, request.state.user, data.url)

    @api.post(
        "/api/worktrees/{worktree}/git/fetch",
        response_model=None,
        dependencies=[
            Depends(no_api_token("API tokens cannot authorize Git credentials or network Git")),
            Depends(worktree_role("editor")),
        ],
    )
    def git_fetch(worktree: str, data: schemas.RemoteState, request: Request) -> Record:
        return projects.remotes.fetch(worktree, data.config_revision, request.state.user)

    @api.post(
        "/api/worktrees/{worktree}/git/pull",
        response_model=None,
        dependencies=[Depends(worktree_role("editor"))],
    )
    def git_pull(worktree: str, data: schemas.RemoteHeads) -> Record:
        return projects.remotes.pull(worktree, data.config_revision, data.local_head, data.remote_head)

    @api.post(
        "/api/worktrees/{worktree}/git/push",
        response_model=None,
        dependencies=[
            Depends(no_api_token("API tokens cannot authorize Git credentials or network Git")),
            Depends(worktree_role("editor")),
        ],
    )
    def git_push(worktree: str, data: schemas.RemoteHeads, request: Request) -> Record:
        return projects.remotes.push(
            worktree,
            data.config_revision,
            data.local_head,
            data.remote_head,
            data.recreate,
            request.state.user,
        )

    def current_review(worktree: str, review: str) -> Record:
        """A review whose branches did not move. Results are then read without the repository lock."""
        with projects.locked(worktree):
            proposal = projects.versioning.review(worktree, review)
            projects.versioning.verify_review(proposal)
            return proposal

    return api
