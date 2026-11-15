/// <reference types="vite/client" />

// The parts of Monaco's services that suggestionDetails.ts reads, which its
// public editor API does not declare.
declare module "monaco-editor/esm/vs/platform/storage/common/storage.js" {
  export interface StorageService {
    getBoolean(key: string, scope: number, fallback: boolean): boolean;
    store(key: string, value: boolean, scope: number, target: number): void;
  }
  export const IStorageService: { readonly _brand?: StorageService };
}
declare module "monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js" {
  import type { StorageService } from "monaco-editor/esm/vs/platform/storage/common/storage.js";
  export const StandaloneServices: {
    get(service: { readonly _brand?: StorageService }): StorageService;
  };
}
