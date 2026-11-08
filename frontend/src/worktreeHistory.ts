import { ApiError } from "./api";
export interface History {
  undo: string[];
  redo: string[];
}
/** Save at most 100 undo entries; a new edit invalidates redo. */
export function rememberChange(history: History, change: string) {
  history.undo.push(change);
  history.undo.splice(0, Math.max(0, history.undo.length - 100));
  history.redo.length = 0;
}
/** A conflict retains the rejected change on the server; other failures restore its place. */
export async function revertChange(
  history: History,
  direction: keyof History,
  request: (commit: string) => Promise<{ change?: string | null }>,
  change?: string,
) {
  const commits = history[direction];
  const index = change ? commits.lastIndexOf(change) : commits.length - 1;
  if (index < 0) return false;
  const [commit] = commits.splice(index, 1);
  try {
    const result = await request(commit);
    if (result.change)
      history[direction === "undo" ? "redo" : "undo"].push(result.change);
    return true;
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 409))
      commits.splice(index, 0, commit);
    throw error;
  }
}
