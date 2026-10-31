/**
 * Stripe Client — metered usage billing
 *
 * A minimal, zero-dependency adapter over Stripe's REST API. It deliberately
 * does NOT use the `stripe` npm package so the project keeps its "zero extra
 * dependencies" ethos while still supporting production usage-based billing.
 *
 * Supported endpoint:
 *   POST /v1/subscription_items/{id}/usage_record   (classic metered billing)
 *
 * DRY-RUN MODE: when no STRIPE_SECRET_KEY is configured the client never
 * makes a network call — it returns a success result with `dryRun: true` and
 * the URL it WOULD have posted to. This lets the whole metering + flush flow
 * be exercised locally (devnet/demo) with zero Stripe account or cost.
 */

import { createLogger } from '../utils/logger.js';
import { Result, success, failure } from '../utils/types.js';

const logger = createLogger('STRIPE');

export interface StripeConfig {
  /** Stripe secret key (sk_...). Empty/absent => dry-run mode. */
  readonly secretKey: string;
  /** Override for tests/proxies. Defaults to the live Stripe API. */
  readonly baseUrl?: string;
  /** Stripe API version header. Defaults to a stable pinned version. */
  readonly apiVersion?: string;
}

export interface UsageRecordResult {
  readonly dryRun: boolean;
  readonly recordId?: string;
  readonly url?: string;
}

export interface UsageRecordInput {
  readonly subscriptionItemId: string;
  readonly quantity: number;
  readonly timestamp?: number; // Unix epoch seconds
  readonly action?: 'increment' | 'set';
}

export class StripeClient {
  readonly dryRun: boolean;
  private readonly baseUrl: string;
  private readonly secretKey: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: StripeConfig, fetchImpl?: typeof fetch) {
    this.secretKey = config.secretKey;
    this.baseUrl = (config.baseUrl ?? 'https://api.stripe.com/v1').replace(/\/$/, '');
    this.apiVersion = config.apiVersion ?? '2024-06-20';
    this.dryRun = !config.secretKey;
    this.fetchImpl = fetchImpl ?? (globalThis.fetch as typeof fetch);
  }

  /**
   * Record usage against a subscription item (metered billing).
   * `quantity` is the incremental amount to bill (action=increment).
   */
  async createUsageRecord(
    input: UsageRecordInput
  ): Promise<Result<UsageRecordResult, Error>> {
    const url = `${this.baseUrl}/subscription_items/${encodeURIComponent(
      input.subscriptionItemId
    )}/usage_record`;

    if (this.dryRun) {
      logger.info('STRIPE dry-run: would record usage', {
        subscriptionItemId: input.subscriptionItemId,
        quantity: input.quantity,
      });
      return success({ dryRun: true, url });
    }

    const body = new URLSearchParams({
      quantity: String(input.quantity),
      action: input.action ?? 'increment',
    });
    if (input.timestamp) {
      body.set('timestamp', String(input.timestamp));
    }

    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Stripe-Version': this.apiVersion,
        },
        body: body.toString(),
      });

      const text = await res.text();
      if (!res.ok) {
        logger.error('Stripe usage_record failed', {
          status: res.status,
          body: text.slice(0, 200),
        });
        return failure(
          new Error(`Stripe usage_record failed (${res.status}): ${text.slice(0, 200)}`)
        );
      }

      let recordId: string | undefined;
      try {
        recordId = (JSON.parse(text) as { id?: string })?.id;
      } catch {
        // Non-JSON success body — ignore.
      }

      return success({ dryRun: false, recordId, url });
    } catch (err) {
      logger.error('Stripe request threw', { error: String(err) });
      return failure(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
