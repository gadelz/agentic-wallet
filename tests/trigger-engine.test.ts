/**
 * Trigger Engine Tests
 *
 * Validates event dispatch, agent scoping, condition filtering, enable/disable,
 * fire statistics, and the event→memory pipeline.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const memStore = new Map<string, unknown>();
vi.mock('../src/utils/store.js', () => ({
  saveState: vi.fn((key: string, data: unknown) => memStore.set(key, data)),
  loadState: vi.fn((key: string) => memStore.get(key) ?? null),
}));

import { eventBus } from '../src/orchestrator/event-emitter.js';
import { TriggerEngine } from '../src/triggers/triggerEngine.js';
import { AgentMemoryStore } from '../src/memory/agentMemory.js';
import { SystemEvent } from '../src/utils/types.js';

function makeAgentEvent(agentId: string, status: string): SystemEvent {
  return {
    id: `evt-${Math.random()}`,
    timestamp: new Date(),
    type: 'agent_status_changed',
    agentId,
    previousStatus: 'idle',
    newStatus: status,
  } as unknown as SystemEvent;
}

function makeTxEvent(walletId: string): SystemEvent {
  return {
    id: `evt-${Math.random()}`,
    timestamp: new Date(),
    type: 'transaction',
    transaction: {
      id: 'tx-1',
      walletId,
      type: 'transfer_sol',
      status: 'confirmed',
      createdAt: new Date(),
    },
  } as unknown as SystemEvent;
}

describe('TriggerEngine', () => {
  let mem: AgentMemoryStore;
  let engine: TriggerEngine;

  beforeEach(() => {
    memStore.clear();
    mem = new AgentMemoryStore();
    engine = new TriggerEngine(mem);
  });

  it('fires the handler on a matching event type', async () => {
    let fired = 0;
    engine.register({
      id: 't1',
      eventType: 'agent_status_changed',
      handler: () => {
        fired++;
      },
    });
    eventBus.emit(makeAgentEvent('agent-1', 'thinking'));
    expect(fired).toBe(1);
  });

  it('ignores events of a different type', async () => {
    let fired = 0;
    engine.register({
      id: 't2',
      eventType: 'transaction',
      handler: () => {
        fired++;
      },
    });
    eventBus.emit(makeAgentEvent('agent-1', 'thinking'));
    expect(fired).toBe(0);
  });

  it('scopes to a single agent', async () => {
    let fired = 0;
    engine.register({
      id: 't3',
      agentId: 'agent-1',
      eventType: 'agent_status_changed',
      handler: () => {
        fired++;
      },
    });
    eventBus.emit(makeAgentEvent('agent-1', 'thinking'));
    eventBus.emit(makeAgentEvent('agent-2', 'thinking'));
    expect(fired).toBe(1);
  });

  it('filters with a condition', async () => {
    let fired = 0;
    engine.register({
      id: 't4',
      eventType: 'agent_status_changed',
      condition: (e) => e.type === 'agent_status_changed' && e.newStatus === 'error',
      handler: () => {
        fired++;
      },
    });
    eventBus.emit(makeAgentEvent('agent-1', 'thinking')); // not error
    eventBus.emit(makeAgentEvent('agent-1', 'error')); // error
    expect(fired).toBe(1);
  });

  it('does not fire when disabled', async () => {
    let fired = 0;
    engine.register({
      id: 't5',
      eventType: 'agent_status_changed',
      handler: () => {
        fired++;
      },
    });
    engine.setEnabled('t5', false);
    eventBus.emit(makeAgentEvent('agent-1', 'thinking'));
    expect(fired).toBe(0);
  });

  it('tracks fire count and last-fired timestamp', async () => {
    engine.register({
      id: 't6',
      eventType: 'agent_status_changed',
      handler: () => {},
    });
    eventBus.emit(makeAgentEvent('agent-1', 'thinking'));
    eventBus.emit(makeAgentEvent('agent-1', 'executing'));
    const meta = engine.list().find((m) => m.id === 't6');
    expect(meta?.fireCount).toBe(2);
    expect(meta?.lastFiredAt).toBeInstanceOf(Date);
  });

  it('persists event state to agent memory (event→memory pipeline)', async () => {
    engine.register({
      id: 't7',
      eventType: 'transaction',
      handler: ({ event, memory, agentId }) => {
        if (event.type !== 'transaction') return;
        memory.set(agentId || event.transaction.walletId, 'lastTx', {
          signature: event.transaction.signature,
          status: event.transaction.status,
        });
      },
    });
    eventBus.emit(makeTxEvent('wallet-9'));
    const saved = mem.get('wallet-9', 'lastTx') as { status: string } | undefined;
    expect(saved?.status).toBe('confirmed');
  });

  it('rejects duplicate trigger ids', () => {
    engine.register({ id: 'dup', eventType: 'transaction', handler: () => {} });
    const second = engine.register({ id: 'dup', eventType: 'transaction', handler: () => {} });
    expect(second.ok).toBe(false);
  });

  it('unsubscribes on dispose', async () => {
    let fired = 0;
    engine.register({
      id: 't8',
      eventType: 'agent_status_changed',
      handler: () => {
        fired++;
      },
    });
    engine.dispose();
    eventBus.emit(makeAgentEvent('agent-1', 'thinking'));
    expect(fired).toBe(0);
  });
});
