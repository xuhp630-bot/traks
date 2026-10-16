/** Reserved metadata keys; no new D1, DO or Pipeline columns are required. */
export const REVENUE_CURRENCY_KEY = '__traks_currency';
export const CAMPAIGN_CONTENT_KEY = '__traks_utm_content';
export const CAMPAIGN_TERM_KEY = '__traks_utm_term';

export interface RevenueAmount {
  currency: string;
  amount: number;
}

function containsPrivateValue(value: string): boolean {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    /* inspect as supplied */
  }
  return /[^\s/@]+@[^\s/@]+\.[^\s/@]+|\bbearer\s+|[?&](?:email|token|password|user_id|order_id)=/i.test(
    decoded
  );
}

/** Receiving boundary: native and compatible clients have the same privacy guard. */
export function sanitizeTrackingContext<
  T extends {
    p?: string;
    h?: string;
    r?: string;
    en?: string;
    us?: string;
    um?: string;
    uc?: string;
    uct?: string;
    ut?: string;
  },
>(event: T): T {
  const path = (event.p ?? '/').split('?')[0].slice(0, 2048);
  let referrer = '';
  try {
    const url = new URL(event.r ?? '');
    if (/^https?:$/.test(url.protocol) && !containsPrivateValue(url.pathname)) {
      referrer = (url.origin + url.pathname).slice(0, 2048);
    }
  } catch {
    /* an unknown referrer stays unknown */
  }
  const label = (value: string | undefined): string | undefined =>
    value && !containsPrivateValue(value) && !/:\/\//.test(value) ? value.slice(0, 256) : undefined;
  return {
    ...event,
    p: containsPrivateValue(path) ? '/[redacted]' : path.startsWith('/') ? path : '/',
    h: /^[a-z0-9.\-[\]:]+$/i.test(event.h ?? '') ? event.h : '',
    r: referrer,
    en: event.en && containsPrivateValue(event.en) ? '[redacted event]' : event.en,
    us: label(event.us),
    um: label(event.um),
    uc: label(event.uc),
    uct: label(event.uct),
    ut: label(event.ut),
  };
}

/** Bounded, declared currency amounts, not an authenticated order ledger. */
export function normalizeRevenue(value: unknown): RevenueAmount | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const currency = typeof raw.currency === 'string' ? raw.currency.toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(currency)) return undefined;
  if (
    typeof raw.amount !== 'number' &&
    !(typeof raw.amount === 'string' && /^\d+(?:\.\d+)?$/.test(raw.amount))
  )
    return undefined;
  const amount = Number(raw.amount);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) return undefined;
  return { currency, amount };
}

/** This blocks common mistakes; producers must still use a purpose-specific whitelist. */
export function sanitizeEventProps(raw: unknown): Record<string, string | number | boolean> {
  const safe: Record<string, string | number | boolean> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return safe;
  for (const [key, value] of Object.entries(raw)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (
      key.startsWith('__traks_') ||
      key.length > 128 ||
      /^\d+$/.test(key) ||
      /^(?:userid|username|email|emailaddress|phone|phonenumber|password|token|accesstoken|authorization|cookie|sessionid|deviceid|advertisingid|orderid|customerid|firstname|lastname|address|ip|ipaddress|message|input|query|prompt|stack|requestbody|responsebody)$/.test(
        normalized
      )
    )
      continue;
    if (typeof value === 'string') {
      if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(value)) continue;
      safe[key] = value.slice(0, 512);
    } else if (
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      safe[key] = value;
    }
    if (Object.keys(safe).length >= 30) break;
  }
  return safe;
}

/** Keep derived fields first and intact, then add safe scalar props within the budget. */
export function buildAttributionMeta(
  raw: unknown,
  context: { currency?: string; amount?: number; content?: string; term?: string }
): string {
  let props = raw;
  if (typeof raw === 'string') {
    try {
      props = JSON.parse(raw);
    } catch {
      props = undefined;
    }
  }
  const meta: Record<string, string | number | boolean> = {};
  const revenue = normalizeRevenue({ currency: context.currency, amount: context.amount });
  // Queries deliberately rely on this being the first key in compact JSON.
  if (revenue) meta[REVENUE_CURRENCY_KEY] = revenue.currency;
  for (const [key, value] of [
    [CAMPAIGN_CONTENT_KEY, context.content],
    [CAMPAIGN_TERM_KEY, context.term],
  ] as const) {
    if (typeof value === 'string' && value && !/[^\s@]+@[^\s@]+\.[^\s@]+/.test(value)) {
      const candidate = { ...meta, [key]: value.slice(0, 256) };
      if (JSON.stringify(candidate).length <= 1024) meta[key] = value.slice(0, 256);
    }
  }
  for (const [key, value] of Object.entries(sanitizeEventProps(props))) {
    const candidate = { ...meta, [key]: value };
    if (JSON.stringify(candidate).length <= 1024) meta[key] = value;
  }
  return Object.keys(meta).length ? JSON.stringify(meta) : '';
}

export function mergeEventRevenue<T extends { name: string }>(
  events: T[],
  rows: { name: string; currency: string; totalValue?: unknown; total_value?: unknown }[]
): (T & { revenues: RevenueAmount[] })[] {
  return events.map(event => {
    const amounts = new Map<string, number>();
    for (const row of rows) {
      if (row.name !== event.name) continue;
      const rawAmount = row.totalValue ?? row.total_value;
      const amount = Number(rawAmount);
      if (
        !/^[A-Z]{3}$/.test(row.currency) ||
        (typeof rawAmount !== 'number' && typeof rawAmount !== 'string') ||
        rawAmount === '' ||
        !Number.isFinite(amount) ||
        amount < 0
      )
        throw new Error('Invalid revenue response');
      const total = (amounts.get(row.currency) ?? 0) + amount;
      if (!Number.isFinite(total)) throw new Error('Invalid revenue total');
      amounts.set(row.currency, total);
    }
    return {
      ...event,
      revenues: [...amounts]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, amount]) => ({ currency, amount })),
    };
  });
}
