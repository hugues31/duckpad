"""The administrator-owned Python policy shared by authoring and execution."""


def get_policy(store, project):
    saved = store.get("settings", "python:" + project, {})
    return {key: bool(saved.get(key, False)) for key in ("enabled", "allow_builds")}


def save_policy(engine, project, policy):
    with engine.exclusive(project):
        engine.reset_project(project)
        engine.store.put("settings", "python:" + project, policy)
    return policy
