// @vitest-environment happy-dom
import { act, cleanup, render, renderHook } from "@testing-library/react";
import {
  createRef,
  useImperativeHandle,
  type ReactNode,
  type Ref,
} from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DraftContext,
  useDraftRegistry,
  useRevisionDraft,
  type DraftRegistry,
  type DraftScope,
} from "./useRevisionDraft";

type Save = (draft: string, base: number) => Promise<number>;
type Draft = ReturnType<typeof useRevisionDraft<string, number>>;
type Options = Parameters<typeof useRevisionDraft<string, number>>[3];

interface SaveCall {
  draft: string;
  base: number;
  resolve: (revision: number) => void;
  reject: (error: unknown) => void;
}

/** A save endpoint whose answers the test settles one call at a time. */
function server() {
  const calls: SaveCall[] = [];
  const save = vi.fn<Save>(
    (draft, base) =>
      new Promise((resolve, reject) =>
        calls.push({ draft, base, resolve, reject }),
      ),
  );
  return { save, calls };
}

interface Props {
  value: string;
  revision: number;
}

/** An editor of the document whose saved value and revision are the props. */
function editor(save: Save, options?: Options) {
  return renderHook(
    ({ value, revision }: Props) =>
      useRevisionDraft(value, revision, save, options),
    { initialProps: { value: "v1", revision: 1 } },
  );
}

const edit = (draft: { current: Draft }, text: string) =>
  act(() => draft.current.update(() => text));

/** Request a save, wait until it reaches the server, and return its promise. */
async function persist(draft: { current: Draft }) {
  let saving!: Promise<void>;
  await act(async () => {
    saving = draft.current.persist();
  });
  // Wrapped, so that awaiting this helper does not wait for the save itself.
  return { saving };
}

afterEach(cleanup);

describe("useRevisionDraft", () => {
  it("starts with the value as a clean draft", () => {
    const { result } = editor(server().save);
    expect(result.current).toMatchObject({
      draft: "v1",
      saved: "v1",
      dirty: false,
      pending: false,
    });
  });

  it("tracks edits as unsaved changes", () => {
    const { result } = editor(server().save);
    act(() => result.current.update((current) => current + "!"));
    expect(result.current).toMatchObject({
      draft: "v1!",
      saved: "v1",
      dirty: true,
    });
  });

  it("follows incoming values while it holds no unsaved edits", () => {
    const { result, rerender } = editor(server().save);
    rerender({ value: "v2", revision: 2 });
    expect(result.current).toMatchObject({
      draft: "v2",
      saved: "v2",
      dirty: false,
    });
  });

  it("keeps unsaved edits when another value arrives", () => {
    const { result, rerender } = editor(server().save);
    edit(result, "mine");
    rerender({ value: "theirs", revision: 2 });
    expect(result.current).toMatchObject({
      draft: "mine",
      saved: "v1",
      dirty: true,
    });
  });

  it("discards edits back to the latest incoming value", async () => {
    const { save, calls } = server();
    const { result, rerender } = editor(save);
    edit(result, "mine");
    rerender({ value: "theirs", revision: 2 });

    act(() => result.current.discard());
    expect(result.current).toMatchObject({
      draft: "theirs",
      saved: "theirs",
      dirty: false,
    });

    edit(result, "again");
    await persist(result);
    expect(calls.map(({ draft, base }) => [draft, base])).toEqual([
      ["again", 2],
    ]);
  });

  it("compares drafts with the equality option", async () => {
    const { save } = server();
    const { result } = editor(save, {
      equal: (a, b) => a.trim() === b.trim(),
    });
    edit(result, "v1  ");
    expect(result.current.dirty).toBe(false);
    await act(() => result.current.persist());
    expect(save).not.toHaveBeenCalled();
  });

  it("accepts options and callbacks created on every render", () => {
    const { save } = server();
    const { result, rerender } = renderHook(
      ({ value, revision }: Props) =>
        useRevisionDraft(value, revision, (draft, base) => save(draft, base), {
          scope: "page",
          equal: (a, b) => a.trim() === b.trim(),
        }),
      { initialProps: { value: "v1", revision: 1 } },
    );
    rerender({ value: "v1", revision: 1 });
    expect(result.current).toMatchObject({ draft: "v1", dirty: false });
    rerender({ value: "v2", revision: 2 });
    expect(result.current).toMatchObject({ draft: "v2", dirty: false });

    edit(result, "v3");
    rerender({ value: "theirs", revision: 3 });
    expect(result.current).toMatchObject({ draft: "v3", dirty: true });
  });

  describe("persist", () => {
    it("saves the draft against its base revision", async () => {
      const { save, calls } = server();
      const { result } = editor(save);
      edit(result, "first");
      const { saving } = await persist(result);
      expect(calls.map(({ draft, base }) => [draft, base])).toEqual([
        ["first", 1],
      ]);
      expect(result.current.pending).toBe(true);

      await act(async () => {
        calls[0].resolve(2);
        await saving;
      });
      expect(result.current).toMatchObject({
        draft: "first",
        saved: "first",
        dirty: false,
        pending: false,
      });

      // The next save builds on the revision returned by the previous one.
      edit(result, "second");
      await persist(result);
      expect(calls[1]).toMatchObject({ draft: "second", base: 2 });
    });

    it("uses the save callback of the latest render", async () => {
      const first = server();
      const second = server();
      const { result, rerender } = renderHook(
        ({ save }: { save: Save }) =>
          useRevisionDraft<string, number>("v1", 1, save),
        { initialProps: { save: first.save } },
      );
      edit(result, "a");
      rerender({ save: second.save });
      await persist(result);
      expect(first.save).not.toHaveBeenCalled();
      expect(second.save).toHaveBeenCalledWith("a", 1);
    });

    it("does not save a clean draft", async () => {
      const { save } = server();
      const { result } = editor(save);
      await act(() => result.current.persist());
      expect(save).not.toHaveBeenCalled();
    });

    it("keeps the edits typed while a save is in flight", async () => {
      const { save, calls } = server();
      const { result } = editor(save);
      edit(result, "a");
      const { saving } = await persist(result);
      edit(result, "ab");

      await act(async () => {
        calls[0].resolve(2);
        await saving;
      });
      expect(result.current).toMatchObject({
        draft: "ab",
        saved: "a",
        dirty: true,
      });

      await persist(result);
      expect(calls[1]).toMatchObject({ draft: "ab", base: 2 });
    });

    it("sends a single save for duplicate requests", async () => {
      const { save, calls } = server();
      const { result } = editor(save);
      edit(result, "a");
      // Blurring a field and clicking Save both request the same save.
      const { saving: first } = await persist(result);
      const { saving: second } = await persist(result);
      expect(save).toHaveBeenCalledTimes(1);

      await act(async () => {
        calls[0].resolve(2);
        await Promise.all([first, second]);
      });
      expect(save).toHaveBeenCalledTimes(1);
      expect(result.current.dirty).toBe(false);
    });

    it("saves edits typed after a pending save once it completes", async () => {
      const { save, calls } = server();
      const { result } = editor(save);
      edit(result, "a");
      const { saving: first } = await persist(result);
      edit(result, "ab");
      const { saving: second } = await persist(result);
      expect(save).toHaveBeenCalledTimes(1);

      await act(async () => {
        calls[0].resolve(2);
        await first;
      });
      expect(calls[1]).toMatchObject({ draft: "ab", base: 2 });

      await act(async () => {
        calls[1].resolve(3);
        await second;
      });
      expect(result.current).toMatchObject({
        draft: "ab",
        saved: "ab",
        dirty: false,
        pending: false,
      });
    });

    it("keeps the draft when the save fails", async () => {
      const { save, calls } = server();
      const { result } = editor(save);
      edit(result, "a");
      const { saving } = await persist(result);

      await act(async () => {
        calls[0].reject(new Error("Revision conflict"));
        await expect(saving).rejects.toThrow("Revision conflict");
      });
      expect(result.current).toMatchObject({
        draft: "a",
        saved: "v1",
        dirty: true,
        pending: false,
      });

      // An explicit retry sends the draft again.
      await persist(result);
      expect(calls[1]).toMatchObject({ draft: "a", base: 1 });
    });

    it("does not replace the draft with values arriving during a save", async () => {
      const { save, calls } = server();
      const { result, rerender } = editor(save);
      edit(result, "a");
      const { saving } = await persist(result);
      rerender({ value: "theirs", revision: 2 });
      expect(result.current.draft).toBe("a");

      await act(async () => {
        calls[0].resolve(3);
        await saving;
      });
      expect(result.current).toMatchObject({
        draft: "a",
        saved: "a",
        dirty: false,
      });
    });

    it("ignores the result of a save that was discarded meanwhile", async () => {
      const { save, calls } = server();
      const { result } = editor(save);
      edit(result, "a");
      const { saving } = await persist(result);

      act(() => result.current.discard());
      expect(result.current).toMatchObject({ draft: "v1", dirty: false });

      await act(async () => {
        calls[0].resolve(2);
        await saving;
      });
      expect(result.current).toMatchObject({
        draft: "v1",
        saved: "v1",
        dirty: false,
        pending: false,
      });
    });
  });

  describe("closing the editor", () => {
    /** Let a save requested on unmount reach the server. */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    it("drops unsaved edits by default", async () => {
      const { save } = server();
      const { result, unmount } = editor(save);
      edit(result, "a");
      unmount();
      await settle();
      expect(save).not.toHaveBeenCalled();
    });

    it("saves unsaved edits with autosave", async () => {
      const { save } = server();
      const { result, unmount } = editor(save, { autosave: true });
      edit(result, "a");
      unmount();
      await settle();
      expect(save).toHaveBeenCalledTimes(1);
      expect(save).toHaveBeenCalledWith("a", 1);
    });

    it("autosaves with the save callback of the latest render", async () => {
      const first = server();
      const second = server();
      const { result, rerender, unmount } = renderHook(
        ({ save }: { save: Save }) =>
          useRevisionDraft<string, number>("v1", 1, save, { autosave: true }),
        { initialProps: { save: first.save } },
      );
      edit(result, "a");
      rerender({ save: second.save });
      unmount();
      await settle();
      expect(first.save).not.toHaveBeenCalled();
      expect(second.save).toHaveBeenCalledWith("a", 1);
    });

    it("saves nothing with autosave when the draft is clean", async () => {
      const { save } = server();
      const { unmount } = editor(save, { autosave: true });
      unmount();
      await settle();
      expect(save).not.toHaveBeenCalled();
    });

    it("does not resend a draft whose save was rejected", async () => {
      const { save, calls } = server();
      const { result, unmount } = editor(save, { autosave: true });
      edit(result, "a");
      const { saving } = await persist(result);
      await act(async () => {
        calls[0].reject(new Error("Invalid template"));
        await saving.catch(() => undefined);
      });

      unmount();
      await settle();
      expect(save).toHaveBeenCalledTimes(1);
    });

    it("saves edits typed after a rejected save", async () => {
      const { save, calls } = server();
      const { result, unmount } = editor(save, { autosave: true });
      edit(result, "a");
      const { saving } = await persist(result);
      await act(async () => {
        calls[0].reject(new Error("Invalid template"));
        await saving.catch(() => undefined);
      });
      edit(result, "fixed");

      unmount();
      await settle();
      expect(save).toHaveBeenCalledTimes(2);
      expect(save).toHaveBeenLastCalledWith("fixed", 1);
    });
  });
});

const registry = createRef<DraftRegistry>();

/** Provide a draft registry and expose it through `registry`. */
function Registry({ children }: { children?: ReactNode }) {
  const drafts = useDraftRegistry();
  useImperativeHandle(registry, () => drafts, [drafts]);
  return (
    <DraftContext.Provider value={drafts.register}>
      {children}
    </DraftContext.Provider>
  );
}

function Editor({
  handle,
  scope,
  save,
}: {
  handle: Ref<Draft>;
  scope: DraftScope;
  save: Save;
}) {
  const draft = useRevisionDraft<string, number>("v1", 1, save, { scope });
  useImperativeHandle(handle, () => draft);
  return null;
}

describe("useDraftRegistry", () => {
  it("reports no unsaved draft while every editor is clean", () => {
    const page = createRef<Draft>();
    render(
      <Registry>
        <Editor handle={page} scope="page" save={server().save} />
      </Registry>,
    );
    expect(registry.current!.dirty()).toBe(false);
    expect(registry.current!.dirty("page")).toBe(false);
  });

  it("reports unsaved drafts by scope", () => {
    const { save } = server();
    const page = createRef<Draft>();
    const branch = createRef<Draft>();
    render(
      <Registry>
        <Editor handle={page} scope="page" save={save} />
        <Editor handle={branch} scope="worktree" save={save} />
      </Registry>,
    );
    act(() => page.current!.update(() => "edited"));
    expect(registry.current!.dirty()).toBe(true);
    expect(registry.current!.dirty("page")).toBe(true);
    expect(registry.current!.dirty("worktree")).toBe(false);

    act(() => branch.current!.update(() => "edited"));
    expect(registry.current!.dirty("worktree")).toBe(true);
  });

  it("discards the drafts of one scope or of every scope", () => {
    const { save } = server();
    const page = createRef<Draft>();
    const branch = createRef<Draft>();
    render(
      <Registry>
        <Editor handle={page} scope="page" save={save} />
        <Editor handle={branch} scope="worktree" save={save} />
      </Registry>,
    );
    act(() => {
      page.current!.update(() => "page edit");
      branch.current!.update(() => "branch edit");
    });

    act(() => registry.current!.discard("page"));
    expect(page.current).toMatchObject({ draft: "v1", dirty: false });
    expect(branch.current).toMatchObject({ draft: "branch edit", dirty: true });
    expect(registry.current!.dirty("page")).toBe(false);
    expect(registry.current!.dirty()).toBe(true);

    act(() => registry.current!.discard());
    expect(branch.current).toMatchObject({ draft: "v1", dirty: false });
    expect(registry.current!.dirty()).toBe(false);
  });

  it("forgets a draft once it is saved", async () => {
    const save = vi.fn<Save>(async () => 2);
    const page = createRef<Draft>();
    render(
      <Registry>
        <Editor handle={page} scope="page" save={save} />
      </Registry>,
    );
    act(() => page.current!.update(() => "edited"));
    expect(registry.current!.dirty()).toBe(true);

    await act(() => page.current!.persist());
    expect(save).toHaveBeenCalledWith("edited", 1);
    expect(registry.current!.dirty()).toBe(false);
  });

  it("forgets a draft when its editor closes", () => {
    const { save } = server();
    const page = createRef<Draft>();
    const { rerender } = render(
      <Registry>
        <Editor handle={page} scope="page" save={save} />
      </Registry>,
    );
    act(() => page.current!.update(() => "edited"));
    expect(registry.current!.dirty()).toBe(true);

    rerender(<Registry />);
    expect(registry.current!.dirty()).toBe(false);
  });
});
