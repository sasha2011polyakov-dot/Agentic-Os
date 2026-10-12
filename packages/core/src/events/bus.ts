import { nowIso } from '../util/time.ts';

export type EventType =
  | 'systems.changed'
  | 'system.updated'
  | 'source.updated'
  | 'index.progress'
  | 'index.done'
  | 'docs.changed'
  | 'graph.changed'
  | 'tasks.changed'
  | 'agents.changed'
  | 'run.updated'
  | 'run.step'
  | 'run.event'
  | 'model.pull'
  | 'settings.changed'
  | 'error';

export interface AppEvent<T = unknown> {
  type: EventType;
  /** Set for every event that concerns a system; the UI uses it to route events to the right context. */
  systemId?: string;
  data: T;
  ts: string;
}

export type EventListener = (event: AppEvent) => void;

export class EventBus {
  private readonly listeners = new Set<EventListener>();

  on(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit<T>(type: EventType, data: T, systemId?: string): void {
    const event: AppEvent<T> = systemId ? { type, systemId, data, ts: nowIso() } : { type, data, ts: nowIso() };
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // A faulty subscriber (e.g. a closed SSE stream) must never break the emitter.
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}
