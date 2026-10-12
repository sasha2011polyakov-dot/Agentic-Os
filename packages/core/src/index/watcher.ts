import { watch, type FSWatcher } from 'node:fs';
import { relative, sep } from 'node:path';
import type { Logger } from '../log/logger.ts';
import { DEFAULT_EXCLUDED_DIRS } from '../fs/ignore-rules.ts';

const IGNORED_SEGMENTS = new Set(DEFAULT_EXCLUDED_DIRS);

/**
 * Debounced recursive watcher for one source root. Emits batches of changed relative paths; the indexer
 * decides (by size/mtime/hash) what really changed, so duplicate or self-caused events are harmless.
 * If native watching fails (e.g. inotify limit), falls back to periodic full rescans.
 */
export class SourceWatcher {
  private watcher: FSWatcher | null = null;
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private closed = false;
  mode: 'native' | 'polling' | 'off' = 'off';

  constructor(
    private readonly root: string,
    private readonly onChange: (relPaths: string[]) => void,
    private readonly onRescan: () => void,
    private readonly log: Logger,
    private readonly debounceMs = 300,
    private readonly pollMs = 60_000,
  ) {}

  start(): void {
    if (this.closed) return;
    try {
      this.watcher = watch(this.root, { recursive: true, persistent: false }, (_event, filename) => {
        if (!filename) {
          this.onRescan();
          return;
        }
        const rel = (typeof filename === 'string' ? filename : String(filename)).split(sep).join('/');
        if (rel.split('/').some((seg) => IGNORED_SEGMENTS.has(seg)) || rel.includes('.aos-tmp-')) return;
        this.pending.add(rel);
        this.schedule();
      });
      this.watcher.on('error', (e) => {
        this.log.warn('file watcher failed, switching to polling', { root: this.root, error: e });
        this.fallbackToPolling();
      });
      this.mode = 'native';
    } catch (e) {
      this.log.warn('file watcher unavailable, using polling', { root: this.root, error: e as Error });
      this.fallbackToPolling();
    }
  }

  private fallbackToPolling(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.closed || this.pollTimer) return;
    this.mode = 'polling';
    this.pollTimer = setInterval(() => this.onRescan(), this.pollMs);
    this.pollTimer.unref();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      const batch = [...this.pending];
      this.pending.clear();
      if (batch.length && !this.closed) this.onChange(batch);
    }, this.debounceMs);
    this.timer.unref();
  }

  stop(): void {
    this.closed = true;
    this.mode = 'off';
    if (this.timer) clearTimeout(this.timer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.watcher?.close();
    this.watcher = null;
  }

  static relativeTo(root: string, abs: string): string {
    return relative(root, abs).split(sep).join('/');
  }
}
