"""The administrator-owned Python policy shared by authoring and execution."""


def get_policy(store, project):
    saved = store.get("settings", "python:" + project, {})
    return {key: bool(saved.get(key, False)) for key in ("enabled", "allow_builds")}
