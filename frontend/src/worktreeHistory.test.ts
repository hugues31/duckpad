import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { rememberChange, revertChange } from "./worktreeHistory";

describe("worktree history", () => {
  it("caps undo, clears redo on an edit, and transfers inverse commits in both directions", async () => {
    const history = {
      undo: Array.from({ length: 100 }, (_, i) => String(i)),
      redo: ["old"],
    };
    rememberChange(history, "new");
    expect(history.undo).toHaveLength(100);
    expect(history.undo[0]).toBe("1");
    expect(history.redo).toEqual([]);
    await revertChange(history, "undo", async () => ({ change: "inverse" }));
    expect(history.redo).toEqual(["inverse"]);
    await revertChange(history, "redo", async () => ({ change: "reapplied" }));
    expect(history.undo.at(-1)).toBe("reapplied");
    expect(history.redo).toEqual([]);
  });
  it.each([409, 503])(
    "handles a rejected selected undo (%s) without disturbing later edits",
    async (status) => {
      const history = { undo: ["first", "second"], redo: [] };
      const error = new ApiError("Rejected", status);
      await expect(
        revertChange(
          history,
          "undo",
          async () => {
            throw error;
          },
          "first",
        ),
      ).rejects.toBe(error);
      expect(history.undo).toEqual(
        status === 409 ? ["second"] : ["first", "second"],
      );
      expect(history.redo).toEqual([]);
    },
  );
  it("does not request a missing undo", async () => {
    const request = vi.fn();
    expect(await revertChange({ undo: [], redo: [] }, "undo", request)).toBe(
      false,
    );
    expect(request).not.toHaveBeenCalled();
  });
});
