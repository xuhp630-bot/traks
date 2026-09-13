import { z } from 'zod';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const counts = z.object({
  requests: count,
  replyAuthorized: count,
  ownerQualified: count,
  ownerConfirmedReplies: count,
  followupAccepted: count,
  deliveredFollowups: count.nullable(),
  failedFollowups: count.nullable(),
  unresolvedSends: count,
});
const report = z.object({
  format: z.literal('crm-quality/v1'),
  from: z.string().datetime(),
  to: z.string().datetime(),
  generatedAt: z.string().datetime(),
  crmConnected: z.literal(true),
  followupSendingEnabled: z.boolean(),
  population: z.literal('production_labeled_requests_not_verified_humans'),
  counts,
  deliveryCoverage: z.enum(['configured_not_proof_of_receipt', 'not_configured']),
  automaticCustomerReplies: z.null(),
  retention: z.object({
    definition: z.literal(
      'verified_account_project_save_on_exact_UTC_day_since_first_retained_save'
    ),
    cohortWindow: z.literal('first_retained_save_day_in_requested_window'),
    rows: z
      .array(
        z.object({
          offset: z.union([z.literal(1), z.literal(7), z.literal(30)]),
          eligible: count,
          returned: count,
          rate: z.number().min(0).max(1).nullable(),
        })
      )
      .length(3),
    observationHistoryDays: z.literal(90),
  }),
});
const integrations = z.record(
  z.string(),
  z.object({ origin: z.string().url(), token: z.string().min(32).max(256) })
);

export async function readCrmQuality(
  config: string | undefined,
  site: { siteId: string; domain: string },
  window: { from: string; to: string },
  fetcher: typeof fetch = fetch
) {
  if (!config) return { status: 'not_connected' as const, crmConnected: false };
  const parsed = integrations.safeParse(JSON.parse(config));
  if (!parsed.success) throw new Error('Invalid CRM integration configuration');
  const binding = parsed.data[site.siteId];
  if (!binding) return { status: 'not_connected' as const, crmConnected: false };
  const origin = new URL(binding.origin);
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.port ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    origin.hostname !== site.domain ||
    !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(origin.hostname)
  ) {
    throw new Error('CRM origin must match the authorized public site domain');
  }
  const url = new URL('/api/crm/quality', origin);
  const canonicalWindow = {
    from: new Date(window.from).toISOString(),
    to: new Date(window.to).toISOString(),
  };
  url.search = new URLSearchParams(canonicalWindow).toString();
  const response = await fetcher(url, {
    headers: { authorization: `Bearer ${binding.token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('CRM read failed');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty CRM response');
  let size = 0;
  let body = '';
  const decoder = new TextDecoder();
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > 32_768) {
      await reader.cancel();
      throw new Error('CRM response too large');
    }
    body += decoder.decode(part.value, { stream: true });
  }
  const result = report.parse(JSON.parse(body + decoder.decode()));
  if (result.from !== canonicalWindow.from || result.to !== canonicalWindow.to)
    throw new Error('CRM window mismatch');
  if (
    new Set(result.retention.rows.map(row => row.offset)).size !== 3 ||
    result.retention.rows.some(
      row =>
        row.returned > row.eligible ||
        row.rate !== (row.eligible ? row.returned / row.eligible : null)
    )
  ) {
    throw new Error('Invalid CRM retention denominator');
  }
  return {
    status: 'connected' as const,
    ...result,
    limitations: [
      'Independent server-side business aggregate, not a join with anonymous Traks sessions or UTM attribution.',
      'Production labels are not proof of humans. QA/internal/unknown are excluded.',
      'Qualification and customer replies are owner-confirmed; automatic inbound email matching is not connected.',
      'Provider acceptance is not delivery; delivery is not reading, customer reply or a sale.',
      'Retention is verified-account project saves on completed UTC days, not all visitors or contact leads.',
      'The first retained save within rolling 90-day history is not lifetime acquisition. Activity recording is best-effort.',
      'Late evidence, manual reclassification and deletions can revise historical reports; save dated baselines.',
    ],
  };
}
