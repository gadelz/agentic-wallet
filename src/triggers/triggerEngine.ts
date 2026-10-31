/**
 * Trigger Engine
 *
 * Event-driven automation. The engine subscribes to the system event bus and
 * dispatches matching triggers. Each trigger fires on a specific event type
 * (optionally scoped to one agent and/or filtered by a condition) and runs a
 * handler that receives the event plus the agent's persistent memory store.
 *
 * Persistence model: rule LOGIC is code (re-registered on startup), but rule
 * STATE (enabled/disabled, last-fired timestamp, fire count) is persisted by id
 * so automation state survives restarts. This is the standard pattern for
 * event systems — handlers are code, not data.
 */

import { eventBus } from '../orchestrator/event-emitter.js';
import { SystemEvent } from '../utils/types.js';
import { Result, success, failure } from '../utils/types.js';
import { AgentMemoryStore } from '../memory/agentMemory.js';
import { saveState, loadState } from '../utils/store.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TRIGGER');
const STORE_KEY = 'triggers';

export type SystemEventType = SystemEvent['type'];

export interface TriggerContext {
  readonly event: SystemEvent;
  /** The agent the event belongs to (empty string if the event is global). */
  readonly agentId: string;
  readonly memory: AgentMemoryStore;
}

export interface TriggerRule {
  readonly id: string;
  /** If set, the trigger only fires for events belonging to this agent. */
  readonly agentId?: string;
  readonly eventType: SystemEventType;
  /** Optional predicate on the event; must return true to fire. */
  readonly condition?: (event: SystemEvent) => boolean;
  /** The action to run. May be async; may use the memory store to persist. */
  readonly handler: (ctx: TriggerContext) => void | Promise<void>;
}

/** Public metadata (no handler/condition — those are code, not data). */
export interface TriggerMeta {
  readonly id: string;
  readonly agentId?: string;
  readonly eventType: SystemEventType;
  readonly enabled: boolean;
  readonly lastFiredAt?: Date;
  readonly fireCount: number;
}

interface PersistedRuleState {
  readonly enabled: boolean;
  readonly lastFiredAt?: string;
  readonly fireCount: number;
}

interface InternalRule extends TriggerRule {
  enabled: boolean;
  lastFiredAt?: Date;
  fireCount: number;
}

function agentIdFromEvent(event: SystemEvent): string {
  if ('agentId' in event && event.agentId) return event.agentId as string;
  if ('agent' in event && event.agent) return event.agent.id;
  if ('transaction' in event) return event.transaction.walletId;
  return '';
}

export class TriggerEngine {
  private rules: Map<string, InternalRule> = new Map();
  private readonly memory: AgentMemoryStore;
  private readonly unsubscribe: () => void;

  constructor(memory: AgentMemoryStore) {
    this.memory = memory;
    this.unsubscribe = eventBus.subscribe((event) => {
      // Fire-and-forget; errors are caught inside dispatch.
      void this.dispatch(event);
    });
  }

  /** Stop listening. Call on shutdown or in tests. */
  dispose(): void {
    this.unsubscribe();
  }

  // ── Registration ─────────────────────────

  register(rule: TriggerRule): Result<true, Error> {
    if (!rule.id) return failure(new Error('Trigger id is required'));
    if (this.rules.has(rule.id)) {
      return failure(new Error(`Trigger "${rule.id}" already registered`));
    }
    // Rehydrate persisted state (enabled / lastFiredAt / fireCount) if any.
    const persisted = this.loadRuleState(rule.id);
    this.rules.set(rule.id, {
      ...rule,
      enabled: persisted?.enabled ?? true,
      lastFiredAt: persisted?.lastFiredAt ? new Date(persisted.lastFiredAt) : undefined,
      fireCount: persisted?.fireCount ?? 0,
    });
    logger.info('Trigger registered', { id: rule.id, eventType: rule.eventType });
    return success(true);
  }

  unregister(id: string): Result<true, Error> {
    const existed = this.rules.delete(id);
    if (!existed) return failure(new Error(`Trigger "${id}" not found`));
    this.persistAll();
    logger.info('Trigger unregistered', { id });
    return success(true);
  }

  setEnabled(id: string, enabled: boolean): Result<true, Error> {
    const rule = this.rules.get(id);
    if (!rule) return failure(new Error(`Trigger "${id}" not found`));
    this.rules.set(id, { ...rule, enabled });
    this.saveRuleState(id);
    logger.info('Trigger state changed', { id, enabled });
    return success(true);
  }

  // ── Queries ──────────────────────────────

  list(): TriggerMeta[] {
    return Array.from(this.rules.values()).map((r) => this.toMeta(r));
  }

  getByAgent(agentId: string): TriggerMeta[] {
    return this.list().filter((t) => t.agentId === agentId);
  }

  // ── Dispatch ─────────────────────────────

  async dispatch(event: SystemEvent): Promise<void> {
    for (const rule of [...this.rules.values()]) {
      if (!rule.enabled) continue;
      if (rule.eventType !== event.type) continue;
      const eventAgentId = agentIdFromEvent(event);
      if (rule.agentId && rule.agentId !== eventAgentId) continue;
      if (rule.condition && !rule.condition(event)) continue;

      // Update fire stats synchronously so callers observing right after an
      // emit see consistent state (handlers may be async).
      this.rules.set(rule.id, {
        ...rule,
        lastFiredAt: new Date(),
        fireCount: rule.fireCount + 1,
      });
      this.saveRuleState(rule.id);

      try {
        await rule.handler({
          event,
          agentId: eventAgentId,
          memory: this.memory,
        });
      } catch (error) {
        logger.error('Trigger handler failed', { id: rule.id, error: String(error) });
      }
    }
  }

  // ── Persistence (rule state only) ────────

  private saveRuleState(id: string): void {
    const rule = this.rules.get(id);
    if (!rule) return;
    const all = this.loadAll();
    all[id] = {
      enabled: rule.enabled,
      lastFiredAt: rule.lastFiredAt ? rule.lastFiredAt.toISOString() : undefined,
      fireCount: rule.fireCount,
    };
    saveState(STORE_KEY, { rules: all });
  }

  private persistAll(): void {
    const all: Record<string, PersistedRuleState> = {};
    for (const rule of this.rules.values()) {
      all[rule.id] = {
        enabled: rule.enabled,
        lastFiredAt: rule.lastFiredAt ? rule.lastFiredAt.toISOString() : undefined,
        fireCount: rule.fireCount,
      };
    }
    saveState(STORE_KEY, { rules: all });
  }

  private loadRuleState(id: string): PersistedRuleState | undefined {
    return this.loadAll()[id];
  }

  private loadAll(): Record<string, PersistedRuleState> {
    const saved = loadState<{ rules: Record<string, PersistedRuleState> }>(STORE_KEY);
    return saved?.rules ?? {};
  }

  private toMeta(rule: InternalRule): TriggerMeta {
    return {
      id: rule.id,
      agentId: rule.agentId,
      eventType: rule.eventType,
      enabled: rule.enabled,
      lastFiredAt: rule.lastFiredAt,
      fireCount: rule.fireCount,
    };
  }
}

// ── Singletons ─────────────────────────────

let memoryInstance: AgentMemoryStore | null = null;
export function getAgentMemory(): AgentMemoryStore {
  if (!memoryInstance) memoryInstance = new AgentMemoryStore();
  return memoryInstance;
}

let triggerInstance: TriggerEngine | null = null;
export function getTriggerEngine(): TriggerEngine {
  if (!triggerInstance) {
    triggerInstance = new TriggerEngine(getAgentMemory());
    registerBuiltinTriggers(triggerInstance);
  }
  return triggerInstance;
}

/**
 * Built-in automation demonstrated by the platform: whenever a transaction is
 * recorded, persist the latest transaction summary into that wallet's memory.
 * This shows the event→memory pipeline working end-to-end.
 */
export function registerBuiltinTriggers(engine: TriggerEngine): void {
  const result = engine.register({
    id: 'builtin:tx-log',
    eventType: 'transaction',
    handler: ({ event, memory, agentId }) => {
      if (event.type !== 'transaction') return;
      const tx = event.transaction;
      memory.set(agentId || tx.walletId, 'lastTransaction', {
        id: tx.id,
        signature: tx.signature,
        type: tx.type,
        status: tx.status,
        amount: tx.amount,
        timestamp: tx.createdAt,
      });
    },
  });
  if (!result.ok) {
    logger.warn('Built-in trigger registration failed', { error: result.error.message });
  }
}
