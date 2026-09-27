import { createHmac, timingSafeEqual } from 'node:crypto';

const API = 'https://api.stripe.com/v1';

export interface StripeBilling {
  secretKey: string;
  productId: string;
  publishableKey?: string;
  baseUrl: string;
}

async function stripe<T>(billing: StripeBilling, path: string, body?: Record<string, string>): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + billing.secretKey, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: body ? new URLSearchParams(body) : undefined,
  });
  if (!response.ok) throw new Error(`Stripe request failed (${response.status})`);
  return response.json() as Promise<T>;
}

export async function checkout(billing: StripeBilling, input: { accountId: string; email: string }): Promise<{ url: string; customer: string }> {
  const customer = await stripe<{ id: string }>(billing, '/customers', { email: input.email, 'metadata[account_id]': input.accountId });
  const product = await stripe<{ default_price?: { id: string } | string }>(billing, `/products/${encodeURIComponent(billing.productId)}`);
  const price = typeof product.default_price === 'string' ? product.default_price : product.default_price?.id;
  if (!price) throw new Error('The Stripe product has no recurring price configured');
  const session = await stripe<{ url: string }>(billing, '/checkout/sessions', {
    mode: 'subscription', 'line_items[0][price]': price, 'line_items[0][quantity]': '1',
    customer: customer.id, success_url: `${billing.baseUrl}/?checkout=success`, cancel_url: `${billing.baseUrl}/?checkout=canceled`,
  });
  return { url: session.url, customer: customer.id };
}

export async function portal(billing: StripeBilling, customer: string): Promise<string> {
  const session = await stripe<{ url: string }>(billing, '/billing_portal/sessions', { customer, return_url: billing.baseUrl });
  return session.url;
}

export function verifyWebhook(payload: string, signature: string, secret: string, toleranceSeconds = 300): Record<string, unknown> {
  const parts = Object.fromEntries(signature.split(',').map((part) => part.split('='))) as { t?: string; v1?: string };
  if (!parts.t || !parts.v1 || Math.abs(Date.now() / 1000 - Number(parts.t)) > toleranceSeconds) throw new Error('Invalid Stripe webhook signature');
  const expected = createHmac('sha256', secret).update(`${parts.t}.${payload}`).digest('hex');
  if (expected.length !== parts.v1.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1))) throw new Error('Invalid Stripe webhook signature');
  return JSON.parse(payload) as Record<string, unknown>;
}
