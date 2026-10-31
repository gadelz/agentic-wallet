/**
 * Billing Tests
 *
 * Validates the zero-dep Stripe client (dry-run + real calls via mocked fetch)
 * and the BillingService delta/watermark logic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/utils/store.js', () => ({
  saveState: vi.fn(),
  loadState: vi.fn().mockReturnValue(null),
}));

import { StripeClient } from '../src/billing/stripeClient.js';
import { BillingService } from '../src/billing/usageBilling.js';
import { TenantRegistry } from '../src/tenant/tenantRegistry.js';

const SECRET = 'test-tenant-secret-32-chars-long!!';

describe('StripeClient', () => {
  describe('dry-run mode', () => {
    it('never calls fetch when no secret key is configured', async () => {
      const client = new StripeClient({ secretKey: '' });
      const r = await client.createUsageRecord({
        subscriptionItemId: 'si_123',
        quantity: 5,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.dryRun).toBe(true);
      expect(r.value.url).toContain('/subscription_items/si_123/usage_record');
    });
  });

  describe('live mode', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.unstubAllGlobals();
    });

    it('POSTs to the usage_record endpoint with bearer auth', async () => {
      const mockFetch = vi.fn(async (_url: string, init: RequestInit) => {
        const headers = (init.headers ?? {}) as Record<string, string>;
        expect(headers['Authorization']).toBe('Bearer sk_test_123');
        expect(headers['Stripe-Version']).toBe('2024-06-20');
        const body = String(init.body);
        expect(body).toContain('quantity=7');
        expect(body).toContain('action=increment');
        return new Response(JSON.stringify({ id: 'usage_rec_abc' }), { status: 200 });
      });

      const client = new StripeClient(
        { secretKey: 'sk_test_123', baseUrl: 'https://stripe.test/v1' },
        mockFetch as unknown as typeof fetch
      );
      const r = await client.createUsageRecord({ subscriptionItemId: 'si_1', quantity: 7 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.dryRun).toBe(false);
      expect(r.value.recordId).toBe('usage_rec_abc');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('returns a failure with the status code on a Stripe error', async () => {
      const mockFetch = vi.fn(async () => new Response('card_declined', { status: 402 }));
      const client = new StripeClient(
        { secretKey: 'sk_test_123', baseUrl: 'https://stripe.test/v1' },
        mockFetch as unknown as typeof fetch
      );
      const r = await client.createUsageRecord({ subscriptionItemId: 'si_1', quantity: 1 });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.message).toContain('402');
    });
  });
});

describe('BillingService', () => {
  let reg: TenantRegistry;
  let billing: BillingService;

  beforeEach(() => {
    reg = new TenantRegistry(SECRET);
  });

  it('skips tenants without a Stripe subscription item', async () => {
    const c = reg.createTenant('NoStripe', 'pro');
    if (!c.ok) return;
    billing = new BillingService(reg, new StripeClient({ secretKey: '' }));
    const r = await billing.flushUsage(c.value.tenantId);
    expect(r.skipped).toBe(true);
    expect(r.reason).toContain('no stripeSubscriptionItemId');
  });

  it('bills only the delta since the last flush (no double-billing)', async () => {
    const c = reg.createTenant('Billed', 'pro', {
      stripeSubscriptionItemId: 'si_billed',
    });
    if (!c.ok) return;
    const tid = c.value.tenantId;

    // 5 intents submitted
    for (let i = 0; i < 5; i++) reg.recordUsage(tid, 'intent_submitted');

    billing = new BillingService(reg, new StripeClient({ secretKey: '' }));
    const first = await billing.flushUsage(tid);
    expect(first.skipped).toBe(false);
    expect(first.billed['intentSubmitted']).toBe(5);

    // No new usage -> second flush bills nothing.
    const second = await billing.flushUsage(tid);
    expect(second.billed['intentSubmitted']).toBeUndefined();

    // 3 more intents -> only the delta (3) is billed.
    for (let i = 0; i < 3; i++) reg.recordUsage(tid, 'intent_submitted');
    const third = await billing.flushUsage(tid);
    expect(third.billed['intentSubmitted']).toBe(3);
  });

  it('advances watermarks in dry-run so repeated flushes stay idempotent', async () => {
    const c = reg.createTenant('Idem', 'pro', {
      stripeSubscriptionItemId: 'si_idem',
    });
    if (!c.ok) return;
    const tid = c.value.tenantId;
    for (let i = 0; i < 10; i++) reg.recordUsage(tid, 'api_request');

    billing = new BillingService(reg, new StripeClient({ secretKey: '' }));
    const r1 = await billing.flushUsage(tid);
    expect(r1.billed['apiRequest']).toBe(10);
    const r2 = await billing.flushUsage(tid);
    expect(r2.billed['apiRequest']).toBeUndefined();
  });
});
