---
name: repository-conventions
description: Apply this repository's English-only writing and Conventional Commits rules whenever creating or editing files, reviewing changes, or preparing commit messages.
---

# Repository Conventions

## Write repository content in English

- Write all new or modified repository content in English, even when the user
  gives instructions in French.
- Use English for documentation, comments, identifiers, file names, test names,
  example text, user-facing strings, log messages, and error messages.
- Translate French wording into English before adding it to the repository.
- Keep conversational replies in the user's preferred language; text saved in
  the repository must always be in English.

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

Before finishing a change, review the diff for French text and check any proposed
commit message against the format above.
