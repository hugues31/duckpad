"""Instance-owned execution targets, pinned versions and audited promotion."""

from sqlalchemy.exc import IntegrityError

from .bundle import files_to_bundle
from .components import expand_for
from .execution.runs import launch_scope
from .git.command import check_branch_name
from .git.workspace import require_valid
from .util import Problem, now, uid


class Jobs:
    def __init__(self, services):
        self.store, self.projects = services.store, services.projects
        self.engine, self.catalog = services.engine, services.catalog

    def get(self, slug):
        job = self.store.get("job", slug)
        if not job:
            raise Problem("Job not found", 404)
        return job

    def path(self, project):
        record = self.store.get("project", project)
        if not record:
            raise Problem("Project not found", 404)
        return self.projects.get(record["main"])["path"]

    def resolve(self, project, kind, ref):
        path = self.path(project)
        if kind not in ("tag", "branch") or not isinstance(ref, str) or not ref or "\0" in ref:
            raise Problem("Choose a tag or branch", 422)
        # Validate the complete ref before resolving it; revision expressions are not targets.
        prefix = "refs/tags/" if kind == "tag" else "refs/heads/"
        try:
            self.projects.git(path, "check-ref-format", prefix + ref)
        except Problem as error:
            raise Problem("Invalid Job reference", 422) from error
        if kind == "branch":
            check_branch_name(path, ref)
        try:
            commit = self.projects.versioning.resolve(path, prefix + ref)
        except Problem as error:
            raise Problem("Job target is unavailable", 409) from error
        target = {"kind": kind, kind: ref}
        if kind == "tag":
            target["commit"] = commit
        return target, commit

    def validate(self, project, commit, environment, scope):
        self.catalog.environment(environment)
        files = self.projects.revision_files(self.path(project), commit)
        require_valid(files, "The Job version contains invalid project files")
        bundle = files_to_bundle(files)
        nodes, edges, _ = expand_for(bundle, environment)
        launch_scope(nodes, edges, scope)

    @staticmethod
    def event(previous, target, before, commit, actor):
        return {
            "at": now(),
            "actor": {"id": actor["id"], "username": actor["username"]},
            "previous": previous,
            "target": target,
            "previous_commit": before,
            "commit": commit,
        }

    def create(self, project, data, actor):
        with self.projects.repository(project):
            if self.store.get("job", data.slug):
                raise Problem("A Job with this slug already exists", 409)
            target, commit = self.resolve(project, data.target.kind, data.target.ref)
            self.validate(project, commit, data.environment, data.scope)
            worktree = self.projects.job_worktree(project, commit)
            job = {
                "id": data.slug,
                "project": project,
                "worktree": worktree["id"],
                "name": data.name.strip(),
                "description": data.description,
                "environment": data.environment,
                "scope": data.scope,
                "target": target,
                "runtime_variables": [],
                "revision": uid(),
                "versions": [self.event(None, target, None, commit, actor)],
            }
            try:
                # Project locks differ across repositories; serialize the instance-wide slug claim.
                with self.store.transaction():
                    if self.store.get("job", data.slug):
                        raise Problem("A Job with this slug already exists", 409)
                    self.store.put("job", data.slug, job)
            except Exception as error:
                self.store.delete("worktree", worktree["id"])
                self.projects.git(self.path(project), "worktree", "remove", "--force", worktree["path"])
                if isinstance(error, IntegrityError):
                    raise Problem("A Job with this slug already exists", 409) from error
                raise
            return self.public(job)

    def current_commit(self, job):
        return job["target"].get("commit") or self.projects.git(
            self.projects.get(job["worktree"])["path"], "rev-parse", "HEAD"
        )

    def retain_commit(self, job, commit):
        # A moved/deleted tag and Git garbage collection must not erase an accepted version.
        # Internal refs are not branches and are never published by remote branch operations.
        self.projects.git(
            self.path(job["project"]),
            "update-ref",
            f"refs/duckpad/jobs/{job['worktree']}/{commit}",
            commit,
        )

    def public(self, job):
        target = job["target"]
        warning = None
        resolved = None
        try:
            _, resolved = self.resolve(job["project"], target["kind"], target[target["kind"]])
            if target["kind"] == "tag" and resolved != target["commit"]:
                warning = "tag_moved"
        except Problem:
            warning = "target_unavailable"
        runs = self.runs(job, limit=1)
        return {
            **job,
            "slug": job["id"],
            "warning": warning,
            "resolved_commit": resolved,
            "last_run": runs[0] if runs else None,
        }

    def runs(self, job, limit=50):
        return self.store.runs({"role": "admin"}, job["worktree"], limit=limit)

    def idle(self, job):
        with self.engine.lock:
            active = self.engine.active.get(job["worktree"])
            if active:
                raise Problem("This Job already has an active execution", 409, {"run": active["id"]})

    def update(self, slug, data):
        with self.projects.locked(self.get(slug)["worktree"]):
            job = self.get(slug)
            self.idle(job)
            if job["revision"] != data.revision:
                raise Problem("This Job changed; reload before saving", 409)
            self.validate(job["project"], self.current_commit(job), data.environment, data.scope)
            job.update(
                name=data.name.strip(),
                description=data.description,
                environment=data.environment,
                scope=data.scope,
                revision=uid(),
            )
            self.store.put("job", slug, job)
            return self.public(job)

    def compare(self, slug, kind, ref):
        with self.projects.locked(self.get(slug)["worktree"]):
            job = self.get(slug)
            target, commit = self.resolve(job["project"], kind, ref)
            self.validate(job["project"], commit, job["environment"], job["scope"])
            before = self.current_commit(job)
            return {
                "revision": job["revision"],
                "target": target,
                "commit": commit,
                "previous_commit": before,
                "comparison": self.projects.versioning.compare(job["worktree"], before, commit),
            }

    def promote(self, slug, data, actor):
        with self.projects.locked(self.get(slug)["worktree"]):
            job = self.get(slug)
            self.idle(job)
            review = self.compare(slug, data.target.kind, data.target.ref)
            if (
                review["revision"] != data.revision
                or review["commit"] != data.commit
                or review["previous_commit"] != data.previous_commit
            ):
                raise Problem("The Job or target changed; compare versions again", 409)
            job["versions"].append(
                self.event(
                    job["target"], review["target"], review["previous_commit"], review["commit"], actor
                )
            )
            self.retain_commit(job, review["commit"])
            job.update(target=review["target"], revision=uid())
            self.store.put("job", slug, job)
            # Keep the results checkout on its last run until the next launch.
            return self.public(job)

    def delete(self, slug):
        with self.projects.locked(self.get(slug)["worktree"]):
            job = self.get(slug)
            self.idle(job)
            # Retain the read-only worktree, runs and artifacts for History and results.
            self.store.delete("job", slug)

    def launch(self, slug, data, requester):
        job = self.get(slug)
        # Refuse an admitted run even while its launch capture holds the repository lock.
        self.idle(job)
        with self.projects.locked(job["worktree"]) as worktree:
            job = self.get(slug)
            self.idle(job)
            if data.entry_point == "ui" and data.revision != job["revision"]:
                raise Problem("This Job changed; review its environment and version before running", 409)
            settings = self.catalog.environment(job["environment"])
            if data.entry_point == "ui" and settings["confirm_before_run"] and not data.confirmed:
                raise Problem(
                    "Confirm this environment before running", 409, {"confirmation_required": settings}
                )
            target = job["target"]
            if target["kind"] == "tag":
                commit = target["commit"]
            else:
                _, commit = self.resolve(job["project"], "branch", target["branch"])
            self.validate(job["project"], commit, job["environment"], job["scope"])
            self.retain_commit(job, commit)
            self.projects.git(worktree["path"], "checkout", "--detach", "--force", commit)
            self.projects.on_change(worktree["id"])
            return self.engine.runs.launch(
                worktree["id"],
                job["environment"],
                job["scope"],
                data.entry_point,
                requester=requester,
                job={
                    "slug": slug,
                    "name": job["name"],
                    "tag": target.get("tag"),
                    "branch": target.get("branch"),
                    "commit": commit,
                },
            )
