---
name: repository-conventions
description: Apply this repository's English writing rules, UI translation exception, Conventional Commits rules, and branch names whenever creating or editing files, reviewing changes, preparing commit messages, or publishing branches.
---

# Repository Conventions

## Write repository content in English

- Write all new or modified repository content in English, even when the user
  gives instructions in French, except for the UI translation resources below.
- Use English for documentation, comments, identifiers, file names, test names,
  example text, default user-facing strings, log messages, and error messages.
- Allow French and Portuguese only in localized UI values stored in dedicated
  translation resource files, including translations of user-facing error
  messages. Keep translation keys, file names, and comments in English. Use
  translation keys from application code instead of embedding translated strings
  there.
- Translate French wording into English before adding it elsewhere in the
  repository.
- Keep conversational replies in the user's preferred language.

## Use Conventional Commits

Every commit message must follow this structure:

```text
<type>[optional scope][optional !]: <English summary>

[optional English body]

[optional footers]
```

- Use a lowercase type that describes the change: `feat`, `fix`, `docs`, `style`,
  `refactor`, `perf`, `test`, `build`, `ci`, `chore`, or `revert`.
- Add a short English scope when it helps identify the affected component.
- Write a concise English summary in the imperative, such as `add`, `fix`, or
  `update`. Keep body text and footer descriptions in English as well.
- Mark breaking changes with `!` before the colon or a
  `BREAKING CHANGE: <English explanation>` footer.
- Apply the same format to merge, squash, revert, and amended commit messages;
  replace generated messages when necessary.

Examples:

```text
docs(agents): add repository conventions
fix(editor): preserve selection when saving
feat(api)!: require authentication for note updates
```

## Name branches

Name every pull request branch `<type>/<issue-key>-<short-description>`:

- Start with the Conventional Commit type of the main change, the one used in the
  pull request title: `feat`, `fix`, `docs`, `refactor`, and so on.
- Add the issue tracker key in lowercase when the change comes from an issue. The
  tracker links the pull request to its issue through the branch name, so the
  title does not need the key. Omit it when there is no issue.
- End with a few English words in kebab-case that describe the change.
- Leave tool and agent names out: no `agent/`, `codex/`, or `claude/` prefixes.
- Keep the same branch for review follow-ups.

Examples:

```text
feat/general-432-assistant-chat
fix/general-431-node-status-badges
docs/readme-badges
```

Before finishing a change, verify that any French or Portuguese text is limited
to localized UI values in dedicated translation resources, and check any proposed commit
message and branch name against the formats above.
