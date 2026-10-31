/**
 * Billing Service
 *
 * Bridges the TenantRegistry's metering to a billing provider (Stripe).
 *
 * It computes the DELTA between a tenant's lifetime usage and the watermark
 * already reported to Stripe, then pushes that delta as a usage record. The
 * watermark is advanced only after a successful push, so a failed push never
 * loses usage and a successful push is never double-billed.
 */

import { createLogger } from '../utils/logger.js';
import { TenantRegistry } from '../tenant/tenantRegistry.js';
import { UsageMeter } from '../tenant/types.js';
import { StripeClient } from './stripeClient.js';

const logger = createLogger('BILLING');

const METER_TO_KEY: Record<UsageMeter, 'agentCreated' | 'intentSubmitted' | 'apiRequest'> = {
  agent_created: 'agentCreated',
  intent_submitted: 'intentSubmitted',
  api_request: 'apiRequest',
};

export interface FlushResult {
  readonly tenantId: string;
  readonly dryRun: boolean;
  /** meter -> quantity billed on this flush. */
  readonly billed: Record<string, number>;
  readonly skipped: boolean;
  readonly reason?: string;
}

export class BillingService {
  constructor(
    private readonly tenants: TenantRegistry,
    private readonly stripe: StripeClient
  ) {}

  /**
   * Push any unreported usage for `tenantId` to Stripe.
   * No-op (skipped) if the tenant isn't linked to a Stripe subscription item.
   */
  async flushUsage(tenantId: string): Promise<FlushResult> {
    const tenantResult = this.tenants.getTenant(tenantId);
    if (!tenantResult.ok) {
      return {
        tenantId,
        dryRun: this.stripe.dryRun,
        billed: {},
        skipped: true,
        reason: tenantResult.error.message,
      };
    }

    const tenant = tenantResult.value;
    const itemId = tenant.stripeSubscriptionItemId;
    if (!itemId) {
      return {
        tenantId,
        dryRun: this.stripe.dryRun,
        billed: {},
        skipped: true,
        reason: 'Tenant has no stripeSubscriptionItemId; usage tracked locally only',
      };
    }

    const u = tenant.usage;
    const meters: UsageMeter[] = ['agent_created', 'intent_submitted', 'api_request'];
    const billed: Record<string, number> = {};

    for (const meter of meters) {
      const key = METER_TO_KEY[meter];
      const lifetime = u.lifetime[key];
      const reported = u.reported[key];
      const delta = lifetime - reported;
      if (delta <= 0) continue;

      const result = await this.stripe.createUsageRecord({
        subscriptionItemId: itemId,
        quantity: delta,
      });

      if (!result.ok) {
        // Stop at the first failure — do not advance watermarks, so nothing is
        // lost and nothing is double-billed on the next attempt.
        return {
          tenantId,
          dryRun: this.stripe.dryRun,
          billed,
          skipped: false,
          reason: `billing failed for ${meter}: ${result.error.message}`,
        };
      }

      // Advance the watermark only after a successful (or dry-run) push.
      this.tenants.markReported(tenantId, meter, lifetime);
      billed[key] = delta;
      logger.info('Usage billed', { tenantId, meter, quantity: delta });
    }

    return { tenantId, dryRun: this.stripe.dryRun, billed, skipped: false };
  }
}
