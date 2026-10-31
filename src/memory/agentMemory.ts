/**
 * Agent Memory Store
 *
 * A persistent, namespaced key-value store for agent state. Each agent (or
 * entity id) gets its own namespace, so state is fully isolated and survives
 * server restarts.
 *
 * Features:
 * - Namespaced by agentId (isolation between agents)
 * - Optional TTL per entry (expired entries are filtered on read)
 * - Persisted via the project's file store (survives restarts)
 * - Zero extra dependencies
 */

import { saveState, loadState } from '../utils/store.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('AGENT_MEMORY');
const STORE_KEY = 'agent-memory';

interface MemoryEntry {
  readonly value: unknown;
  readonly expiresAt?: number;
}

interface PersistedMemory {
  readonly data: Record<string, Record<string, MemoryEntry>>;
}

export class AgentMemoryStore {
  private store: Map<string, Map<string, MemoryEntry>> = new Map();

  constructor() {
    this.loadFromStore();
  }

  // ── Persistence ──────────────────────────

  private saveToStore(): void {
    const data: Record<string, Record<string, MemoryEntry>> = {};
    for (const [agentId, entries] of this.store) {
      data[agentId] = Object.fromEntries(entries);
    }
    saveState(STORE_KEY, { data } satisfies PersistedMemory);
  }

  private loadFromStore(): void {
    const saved = loadState<PersistedMemory>(STORE_KEY);
    if (!saved?.data) return;
    let count = 0;
    for (const [agentId, entries] of Object.entries(saved.data)) {
      const map = new Map<string, MemoryEntry>();
      for (const [key, value] of Object.entries(entries)) {
        map.set(key, value);
        count++;
      }
      this.store.set(agentId, map);
    }
    logger.info('Agent memory restored', { agents: this.store.size, entries: count });
  }

  // ── CRUD ─────────────────────────────────

  /**
   * Set a value for an agent's namespace.
   * @param ttlMs — optional time-to-live; entry expires after this many ms.
   */
  set(agentId: string, key: string, value: unknown, ttlMs?: number): void {
    if (!agentId) throw new Error('agentId is required');
    if (!key) throw new Error('key is required');
    const entries = this.store.get(agentId) ?? new Map<string, MemoryEntry>();
    entries.set(key, {
      value,
      expiresAt: ttlMs && ttlMs > 0 ? Date.now() + ttlMs : undefined,
    });
    this.store.set(agentId, entries);
    this.saveToStore();
  }

  /** Read a value; returns `undefined` if absent or expired. */
  get(agentId: string, key: string): unknown {
    const entries = this.store.get(agentId);
    if (!entries) return undefined;
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      entries.delete(key);
      this.saveToStore();
      return undefined;
    }
    return entry.value;
  }

  /** Delete a key. Returns true if it existed. */
  delete(agentId: string, key: string): boolean {
    const entries = this.store.get(agentId);
    if (!entries) return false;
    const existed = entries.delete(key);
    if (existed) this.saveToStore();
    return existed;
  }

  /** List all live (non-expired) values for an agent. */
  list(agentId: string): Record<string, unknown> {
    const entries = this.store.get(agentId);
    if (!entries) return {};
    const now = Date.now();
    const result: Record<string, unknown> = {};
    let pruned = false;
    for (const [key, entry] of entries) {
      if (entry.expiresAt && now > entry.expiresAt) {
        entries.delete(key);
        pruned = true;
        continue;
      }
      result[key] = entry.value;
    }
    if (pruned) this.saveToStore();
    return result;
  }

  /** List the live key names for an agent. */
  keys(agentId: string): string[] {
    return Object.keys(this.list(agentId));
  }

  /** Number of live entries for an agent. */
  size(agentId: string): number {
    return Object.keys(this.list(agentId)).length;
  }

  /** Clear all memory for an agent. */
  clearAgent(agentId: string): void {
    if (this.store.delete(agentId)) {
      this.saveToStore();
    }
  }

  /** Number of agents with stored memory. */
  agentCount(): number {
    return this.store.size;
  }
}
