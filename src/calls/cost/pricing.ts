import type { CostComponent, UsageEvent, UsageUnit } from './model.js';

/**
 * One line of the price book: what a unit of one product's metric costs, between two dates. Rates are only ever
 * added. A change of price is a new rate with a later `effectiveFrom` (and the old one's `effectiveTo`).
 */
export interface PriceRate {
  /** Stable identity, kept on every cost component priced with it. */
  id: string;
  provider: string;
  product: string;
  metric: string;
  /** Optional: a rate for one model only. A rate without a model applies to every model of the product. */
  model?: string;
  unit: UsageUnit;
  /** The amount charged per `per` units (`per` defaults to 1; token rates are usually per 1,000,000). */
  rate: number;
  per?: number;
  currency: string;
  effectiveFrom: Date;
  /** Exclusive. Absent: still in force. */
  effectiveTo?: Date;
  /** Where the number came from, for people. Not read by any logic. */
  note?: string;
}

export interface PriceQuery {
  provider: string;
  product: string;
  metric: string;
  model: string | null;
  at: Date;
}

export interface PriceBook {
  /** The rate in force for this usage at `at`, or `null`. A model-specific rate wins over a model-less one. */
  resolve(query: PriceQuery): PriceRate | null;
}

export class StaticPriceBook implements PriceBook {
  constructor(private readonly rates: readonly PriceRate[]) {
    for (const rate of rates) {
      if (!(rate.rate >= 0) || !(rate.per === undefined || rate.per > 0)) throw new Error(`Invalid price rate ${rate.id}`);
    }
  }

  resolve(query: PriceQuery): PriceRate | null {
    const candidates = this.rates.filter((rate) =>
      rate.provider === query.provider && rate.product === query.product && rate.metric === query.metric &&
      rate.effectiveFrom <= query.at && (!rate.effectiveTo || query.at < rate.effectiveTo) &&
      (rate.model === undefined || rate.model === query.model));
    // The most specific (model-bound) rate, then the most recent.
    candidates.sort((left, right) => Number(right.model !== undefined) - Number(left.model !== undefined) || right.effectiveFrom.getTime() - left.effectiveFrom.getTime());
    return candidates[0] ?? null;
  }
}

const SECONDS: Partial<Record<UsageUnit, number>> = { second: 1, minute: 60 };

/** Converts a quantity between units that are convertible (time); `null` when they are not (a call is not a minute). */
export function convertQuantity(quantity: number, from: UsageUnit, to: UsageUnit): number | null {
  if (from === to) return quantity;
  const fromSeconds = SECONDS[from];
  const toSeconds = SECONDS[to];
  return fromSeconds && toSeconds ? (quantity * fromSeconds) / toSeconds : null;
}

const round = (value: number): number => Math.round(value * 1e9) / 1e9;

/**
 * Prices one usage event. Pure: the same event and the same price book give the same component. A provider-stated
 * charge is used as it is; otherwise the rate in force when the usage occurred is applied; otherwise the usage is
 * left unpriced rather than guessed.
 */
export function priceUsage(event: UsageEvent, book: PriceBook, now: Date, id: string): CostComponent {
  const base = { id, usageEventId: event.id, callSessionId: event.callSessionId, accountId: event.accountId, pricedAt: now };
  if (event.reportedAmount !== null && event.reportedCurrency) {
    return { ...base, amount: round(event.reportedAmount), currency: event.reportedCurrency, rateSource: 'provider_reported', rateId: null, rate: null, ratePer: null, rateUnit: null, pricedQuantity: null };
  }
  const rate = book.resolve({ provider: event.provider, product: event.product, metric: event.metric, model: event.model, at: event.occurredAt });
  const quantity = rate ? convertQuantity(event.quantity, event.unit, rate.unit) : null;
  if (!rate || quantity === null) {
    return { ...base, amount: null, currency: null, rateSource: 'unpriced', rateId: null, rate: null, ratePer: null, rateUnit: null, pricedQuantity: null };
  }
  return {
    ...base, amount: round((quantity / (rate.per ?? 1)) * rate.rate), currency: rate.currency, rateSource: 'rate_card',
    rateId: rate.id, rate: rate.rate, ratePer: rate.per ?? 1, rateUnit: rate.unit, pricedQuantity: quantity,
  };
}
