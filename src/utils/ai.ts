import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AiSearchResult,
  AiContextBundle,
  AiIndexProgress,
} from "../types";

/** Build or rebuild the workspace vector index. */
export const ai = {
  buildIndex: () => invoke<number>("ai_build_index"),
  rebuildIndex: () => invoke<number>("ai_rebuild_index"),
  search: (query: string, limit: number = 10) =>
    invoke<AiSearchResult[]>("ai_search", { query, limit }),
  contextForFile: (file: string) =>
    invoke<AiContextBundle>("ai_context", { file }),
  complete: (prefix: string) =>
    invoke<string | null>("ai_complete", { prefix }),
  indexStatus: () => invoke<number>("ai_index_status"),
};

/** Subscribe to `ai:index-progress` events emitted by the Rust indexer. */
export async function onAiIndexProgress(
  cb: (p: AiIndexProgress) => void,
): Promise<UnlistenFn> {
  return listen<AiIndexProgress>("ai:index-progress", (e) => cb(e.payload));
}

/** Subscribe to `ai:index-done` (payload = chunk count). */
export async function onAiIndexDone(
  cb: (count: number) => void,
): Promise<UnlistenFn> {
  return listen<number>("ai:index-done", (e) => cb(e.payload));
}