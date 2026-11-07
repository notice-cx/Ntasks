/**
 * Which workspace the app opens. The browser keeps the one chosen last, so a
 * reload opens it again. Storage can be missing or refuse a write (a private
 * window, a blocked site), and then the app opens the first workspace.
 */
import type { Workspace } from '@/api/types';

const STORAGE_KEY = 'ntasks.workspace';

/** The workspace chosen last in this browser, or null when none is kept. */
export function storedWorkspace(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeWorkspace(workspaceId: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, workspaceId);
  } catch {
    // Kept for this page only; the next load opens the first workspace.
  }
}

/** The workspace to open: the one chosen when the sign-in still reaches it, else the first; null when it reaches none. */
export function openingWorkspace(workspaces: readonly Workspace[], chosen: string | null): Workspace | null {
  return workspaces.find((workspace) => workspace.workspaceId === chosen) ?? workspaces[0] ?? null;
}
