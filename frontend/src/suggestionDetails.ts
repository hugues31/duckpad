/**
 * Whether the suggestion list shows the documentation of its current item
 * beside it. Monaco hides it until Ctrl+Space and keeps that choice in its
 * storage; the names of icons and colors mean little without their preview,
 * so their list opens it, and the next list gets the previous choice back.
 */
import { StandaloneServices } from "monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js";
import { IStorageService } from "monaco-editor/esm/vs/platform/storage/common/storage.js";

// Monaco's StorageScope.PROFILE and StorageTarget.USER.
const SCOPE = 0;
const TARGET = 0;
const KEY = "expandSuggestionDocs";

/** The choice made outside previewed lists, while one of them replaces it. */
let replaced: boolean | null = null;

export function showSuggestionDetails(previewed: boolean) {
  try {
    const storage = StandaloneServices.get(IStorageService);
    if (previewed) {
      // Once per list: Ctrl+Space still hides the previews while it shows.
      if (replaced !== null) return;
      replaced = storage.getBoolean(KEY, SCOPE, false);
      storage.store(KEY, true, SCOPE, TARGET);
    } else if (replaced !== null) {
      storage.store(KEY, replaced, SCOPE, TARGET);
      replaced = null;
    }
  } catch {
    // Without this storage the list keeps Monaco's behavior: Ctrl+Space shows the preview.
  }
}
