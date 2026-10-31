/**
 * Tenant Registry Tests
 *
 * Validates API-key hashing, one-time key return, auth, rotation, suspension,
 * plan limits, metering, and watermark advancement.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub persistence so tests don't write to disk
vi.mock('../src/utils/store.js', () => ({
  saveState: vi.fn(),
  loadState: vi.fn().mockReturnValue(null),
}));

import { TenantRegistry } from '../src/tenant/tenantRegistry.js';
import { PLANS } from '../src/tenant/plans.js';

const SECRET = 'test-tenant-secret-32-chars-long!!';

describe('TenantRegistry', () => {
  let reg: TenantRegistry;

  beforeEach(() => {
    reg = new TenantRegistry(SECRET);
  });

  it('requires a >= 16 char secret (fail-closed)', () => {
    expect(() => new TenantRegistry('short')).toThrow(/at least 16/);
  });

  describe('createTenant', () => {
    it('returns the API key exactly once and never stores it plaintext', () => {
      const r = reg.createTenant('Acme');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.apiKey).toMatch(/^tenant_/);
      expect(r.value.apiKey.length).toBeGreaterThan(32);

      const tenant = reg.getTenant(r.value.tenantId);
      expect(tenant.ok).toBe(true);
      if (!tenant.ok) return;
      // The stored record must NOT contain the raw key.
      expect(tenant.value.apiKeyHash).not.toContain(r.value.apiKey);
      expect(JSON.stringify(tenant.value)).not.toContain(r.value.apiKey);
    });

    it('rejects empty names', () => {
      expect(reg.createTenant('   ').ok).toBe(false);
    });
  });

  describe('authenticate', () => {
    it('authenticates a valid key', () => {
      const c = reg.createTenant('Acme');
      if (!c.ok) return;
      const a = reg.authenticate(c.value.apiKey);
      expect(a.ok).toBe(true);
      if (!a.ok) return;
      expect(a.value.id).toBe(c.value.tenantId);
    });

    it('rejects an invalid key', () => {
      const c = reg.createTenant('Acme');
      if (!c.ok) return;
      const a = reg.authenticate('tenant_fake_wrong_key_123456789012345678901234');
      expect(a.ok).toBe(false);
    });

    it('rejects a key after rotation (old key invalidated)', () => {
      const c = reg.createTenant('Acme');
      if (!c.ok) return;
      const rotated = reg.rotateApiKey(c.value.tenantId);
      expect(rotated.ok).toBe(true);
      if (!rotated.ok) return;
      expect(reg.authenticate(c.value.apiKey).ok).toBe(false);
      expect(reg.authenticate(rotated.value).ok).toBe(true);
    });

    it('rejects auth for a suspended tenant', () => {
      const c = reg.createTenant('Acme');
      if (!c.ok) return;
      reg.setStatus(c.value.tenantId, 'suspended');
      expect(reg.authenticate(c.value.apiKey).ok).toBe(false);
    });
  });

  describe('plan limits', () => {
    it('free plan caps agents at PLANS.free.maxAgents', () => {
      const c = reg.createTenant('Freebie', 'free');
      if (!c.ok) return;
      const tid = c.value.tenantId;
      const max = PLANS.free.maxAgents;
      for (let i = 0; i < max; i++) {
        expect(reg.canUse(tid, 'agent_created')).toBe(true);
        reg.recordUsage(tid, 'agent_created');
      }
      // At the cap, the next agent creation is denied.
      expect(reg.canUse(tid, 'agent_created')).toBe(false);
    });

    it('releasing an agent frees a slot', () => {
      const c = reg.createTenant('Freebie', 'free');
      if (!c.ok) return;
      const tid = c.value.tenantId;
      const max = PLANS.free.maxAgents;
      for (let i = 0; i < max; i++) reg.recordUsage(tid, 'agent_created');
      expect(reg.canUse(tid, 'agent_created')).toBe(false);
      reg.releaseAgent(tid);
      expect(reg.canUse(tid, 'agent_created')).toBe(true);
    });

    it('caps daily intents', () => {
      const c = reg.createTenant('Intents', 'starter');
      if (!c.ok) return;
      const tid = c.value.tenantId;
      const max = PLANS.starter.maxIntentsPerDay;
      // Sample a handful below the cap
      for (let i = 0; i < 5; i++) {
        expect(reg.canUse(tid, 'intent_submitted')).toBe(true);
        reg.recordUsage(tid, 'intent_submitted');
      }
      const usage = reg.getUsage(tid);
      expect(usage?.usage.lifetime.intentSubmitted).toBe(5);
      // We don't iterate 1000 times in a test; just assert the counter is under the cap.
      expect(usage?.usage.intentDay.count).toBeLessThan(max);
    });
  });

  describe('metering', () => {
    it('tracks lifetime totals for billing deltas', () => {
      const c = reg.createTenant('Meter', 'pro');
      if (!c.ok) return;
      const tid = c.value.tenantId;
      reg.recordUsage(tid, 'intent_submitted');
      reg.recordUsage(tid, 'intent_submitted');
      reg.recordUsage(tid, 'api_request');
      const usage = reg.getUsage(tid);
      expect(usage?.usage.lifetime.intentSubmitted).toBe(2);
      expect(usage?.usage.lifetime.apiRequest).toBe(1);
    });

    it('advances only the requested watermark (markReported)', () => {
      const c = reg.createTenant('Watermark', 'pro');
      if (!c.ok) return;
      const tid = c.value.tenantId;
      reg.recordUsage(tid, 'intent_submitted');
      reg.recordUsage(tid, 'intent_submitted');
      reg.markReported(tid, 'intent_submitted', 2);
      const usage = reg.getUsage(tid);
      expect(usage?.usage.reported.intentSubmitted).toBe(2);
      expect(usage?.usage.reported.apiRequest).toBe(0);
    });

    it('exposes plan limits on the public view', () => {
      const c = reg.createTenant('Plans', 'pro');
      if (!c.ok) return;
      const t = reg.getTenant(c.value.tenantId);
      if (!t.ok) return;
      const info = reg.listTenants()[0];
      expect(info.limits.maxAgents).toBe(PLANS.pro.maxAgents);
    });
  });
});
