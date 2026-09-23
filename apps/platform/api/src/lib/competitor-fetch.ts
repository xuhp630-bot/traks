import robotsParser from 'robots-parser';
import ipaddr from 'ipaddr.js';
import type { CompetitorSnapshot } from '@traks/shared';

export class CompetitorFetchError extends Error {
  constructor(
    public code: string,
    public httpStatus: number | null = null
  ) {
    super(code);
  }
}

export const MONITOR_AGENT = 'TraksCompetitorMonitor';
export const HTML_LIMIT = 512 * 1024;

export function approvedHosts(value?: string): string[] {
  return [
    ...new Set(
      (value ?? '')
        .split(',')
        .map(host => host.trim().toLowerCase())
        .filter(Boolean)
    ),
  ];
}

export function publicPageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CompetitorFetchError('invalid_url');
  }
  const host = url.hostname;
  let path: string;
  try {
    path = decodeURIComponent(decodeURIComponent(url.pathname));
  } catch {
    throw new CompetitorFetchError('invalid_url');
  }
  if (
    /[\\\s]/.test(value) ||
    [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    host.length > 253 ||
    ipaddr.isValid(host) ||
    host.includes(':') ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/.test(host) ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion|lan|home|arpa)$/.test(host) ||
    /(?:^|\/)(?:api|login|signin|sign-in|logout|signout|account|admin|dashboard|checkout|cart|payment|oauth|auth|users?|profile)(?:\/|$)/i.test(
      path
    )
  )
    throw new CompetitorFetchError('public_https_page_required');
  return url;
}

export async function limitedText(response: Response, maximum: number): Promise<string> {
  if (Number(response.headers.get('content-length') ?? 0) > maximum) {
    await response.body?.cancel();
    throw new CompetitorFetchError('response_too_large', response.status);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    let result = await reader.read();
    while (!result.done) {
      size += result.value.byteLength;
      if (size > maximum) throw new CompetitorFetchError('response_too_large', response.status);
      chunks.push(result.value);
      result = await reader.read();
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

export function isPublicAddress(value: string): boolean {
  try {
    return ipaddr.parse(value).range() === 'unicast';
  } catch {
    return false;
  }
}

async function checkDns(
  hostname: string,
  fetcher: typeof fetch,
  signal: AbortSignal
): Promise<void> {
  let addressCount = 0;
  for (const type of ['A', 'AAAA']) {
    const response = await fetcher(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
      {
        headers: { Accept: 'application/dns-json' },
        redirect: 'manual',
        signal,
      }
    );
    if (!response.ok) throw new CompetitorFetchError('dns_unavailable');
    const result = JSON.parse(await limitedText(response, 64 * 1024)) as {
      Status?: number;
      TC?: boolean;
      Answer?: { type: number; data: string }[];
    };
    if (result.Status !== 0 || result.TC) throw new CompetitorFetchError('dns_unavailable');
    for (const answer of result.Answer ?? []) {
      if (answer.type !== 1 && answer.type !== 28) continue;
      if (!isPublicAddress(answer.data)) throw new CompetitorFetchError('dns_non_public');
      addressCount++;
    }
  }
  if (!addressCount) throw new CompetitorFetchError('dns_unavailable');
}

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

export async function extractSnapshot(
  html: string,
  url: URL,
  selector: string
): Promise<CompetitorSnapshot> {
  let title = '';
  let h1 = '';
  let description = '';
  let canonical = '';
  let robots = '';
  let content = '';
  let matches = 0;
  const cleaned = new HTMLRewriter()
    .on('script, style, noscript, svg, template, [hidden], [aria-hidden="true"]', {
      element(element) {
        element.remove();
      },
    })
    .transform(new Response(html, { headers: { 'content-type': 'text/html' } }));
  const parsed = new HTMLRewriter()
    .on('title', {
      text(chunk) {
        title += chunk.text;
      },
    })
    .on('h1', {
      text(chunk) {
        h1 += chunk.text;
      },
    })
    .on('meta', {
      element(element) {
        const name = element.getAttribute('name')?.toLowerCase();
        if (name === 'description') description = element.getAttribute('content') ?? '';
        if (name === 'robots') robots = element.getAttribute('content') ?? '';
      },
    })
    .on('link', {
      element(element) {
        if (element.getAttribute('rel')?.toLowerCase().split(/\s+/).includes('canonical')) {
          try {
            const target = new URL(element.getAttribute('href') ?? '', url);
            canonical =
              target.protocol === 'https:' || target.protocol === 'http:'
                ? target.origin + target.pathname
                : '';
          } catch {
            canonical = '';
          }
        }
      },
    })
    .on(selector, {
      element() {
        matches++;
      },
      text(chunk) {
        content += chunk.text;
      },
    })
    .transform(cleaned);
  await parsed.arrayBuffer();
  if (!matches || !normalize(content))
    throw new CompetitorFetchError('selector_missing_or_empty', 200);
  const text = normalize(content);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return {
    title: normalize(title).slice(0, 300),
    h1: normalize(h1).slice(0, 400),
    description: normalize(description).slice(0, 600),
    canonical: canonical.slice(0, 500),
    robots: normalize(robots).slice(0, 240),
    regionText: text.slice(0, 600),
    contentHash: [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join(''),
    contentCharacters: text.length,
  };
}

export async function captureCompetitor(
  target: { url: string; selector: string },
  allowed: string[],
  fetcher: typeof fetch = fetch
): Promise<{ snapshot: CompetitorSnapshot; httpStatus: number }> {
  const url = publicPageUrl(target.url);
  if (!allowed.includes(url.hostname)) throw new CompetitorFetchError('host_not_approved');
  const signal = AbortSignal.timeout(20_000);
  await checkDns(url.hostname, fetcher, signal);
  const request = {
    redirect: 'manual' as const,
    signal,
    headers: { 'User-Agent': `${MONITOR_AGENT}/1.0`, Accept: 'text/html,text/plain;q=0.8' },
  };
  const robotsUrl = new URL('/robots.txt', url).href;
  const robotsResponse = await fetcher(robotsUrl, request);
  if (robotsResponse.status !== 404) {
    if (!robotsResponse.ok) {
      await robotsResponse.body?.cancel();
      throw new CompetitorFetchError('robots_unavailable', robotsResponse.status);
    }
    if (!/^text\/plain(?:;|$)/i.test(robotsResponse.headers.get('content-type') ?? '')) {
      await robotsResponse.body?.cancel();
      throw new CompetitorFetchError('robots_unavailable', robotsResponse.status);
    }
    const policy = robotsParser(robotsUrl, await limitedText(robotsResponse, 128 * 1024));
    if (policy.isAllowed(url.href, MONITOR_AGENT) !== true)
      throw new CompetitorFetchError('robots_denied');
    if ((policy.getCrawlDelay(MONITOR_AGENT) ?? 0) > 0)
      throw new CompetitorFetchError('crawl_delay_requires_external_service');
  } else await robotsResponse.body?.cancel();
  const response = await fetcher(url.href, request);
  if (!response.ok) {
    await response.body?.cancel();
    throw new CompetitorFetchError(
      response.status >= 300 && response.status < 400
        ? 'redirect_not_followed'
        : response.status === 429
          ? 'rate_limited'
          : 'http_error',
      response.status
    );
  }
  if (!/^text\/html(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel();
    throw new CompetitorFetchError('html_required', response.status);
  }
  const snapshot = await extractSnapshot(
    await limitedText(response, HTML_LIMIT),
    url,
    target.selector
  );
  return { snapshot, httpStatus: response.status };
}

export function snapshotChanges(
  previous: CompetitorSnapshot | null,
  current: CompetitorSnapshot
): (keyof CompetitorSnapshot)[] {
  if (!previous) return [];
  return (Object.keys(current) as (keyof CompetitorSnapshot)[]).filter(
    key => previous[key] !== current[key]
  );
}
