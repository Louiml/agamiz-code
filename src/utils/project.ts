import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useProjectStore, useRunStore } from "../store";

export async function openProject(): Promise<string | null> {
  const selected = await openDialog({
    directory: true,
    multiple: false,
    title: "Open Project",
  });
  if (typeof selected !== "string") return null;
  try {
    await invoke("open_project", { path: selected });
  } catch (e) {
    console.warn("open_project failed", e);
  }
  useProjectStore.getState().openProject(selected);
  void useRunStore.getState().refresh();
  window.dispatchEvent(new CustomEvent("project:changed"));
  return selected;
}