import { createContext, useContext } from 'react';
import type { AppInfo, SystemInfo } from './types.ts';

export type Theme = 'light' | 'dark';

export interface AppState {
  app: AppInfo;
  systems: SystemInfo[];
  reloadSystems: () => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  openPalette: () => void;
  /** Bumped on docs.changed / index.done of the current system: lists and the open note refresh. */
  docsVersion: number;
}

export const AppCtx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(AppCtx);
  if (!v) throw new Error('AppCtx missing');
  return v;
}

export function sysApi(sid: string): string {
  return `/api/systems/${encodeURIComponent(sid)}`;
}
