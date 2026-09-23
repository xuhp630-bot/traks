import api from '../apps/platform/api/src/index';
import {
  captureCompetitor,
  extractSnapshot,
  CompetitorFetchError,
} from '../apps/platform/api/src/lib/competitor-fetch';

export default {
  async fetch(request, env, context) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/__fixture/')) return api.fetch(request, env, context);
    const input = await request.json();
    const calls = [];
    try {
      if (path === '/__fixture/extract') {
        return Response.json({
          snapshot: await extractSnapshot(input.html, new URL(input.url), input.selector),
        });
      }
      const fetcher = async (address, init) => {
        const url = new URL(String(address));
        calls.push({
          url: url.href,
          redirect: init.redirect,
          headers: Object.fromEntries(new Headers(init.headers)),
          hasSignal: !!init.signal,
        });
        if (url.hostname === 'cloudflare-dns.com') {
          return Response.json({
            Status: input.dnsStatus ?? 0,
            TC: input.truncated ?? false,
            Answer:
              input.addresses === null
                ? []
                : (input.addresses ?? ['93.184.216.34']).map(data => ({
                    type: data.includes(':') ? 28 : 1,
                    data,
                  })),
          });
        }
        if (url.pathname === '/robots.txt') {
          return new Response(input.robots ?? 'User-agent: *\nAllow: /', {
            status: input.robotsStatus ?? 200,
            headers: { 'content-type': input.robotsType ?? 'text/plain' },
          });
        }
        if (input.timeout) throw new DOMException('Fixture timeout', 'TimeoutError');
        return new Response(input.html ?? '<title>Fixture</title><main>Public plan</main>', {
          status: input.status ?? 200,
          headers: {
            'content-type': input.contentType ?? 'text/html',
            ...(input.contentLength ? { 'content-length': String(input.contentLength) } : {}),
          },
        });
      };
      const result = await captureCompetitor(
        { url: input.url, selector: input.selector ?? 'main' },
        input.allowed ?? ['fixture.example.com'],
        fetcher
      );
      return Response.json({ ...result, calls });
    } catch (error) {
      return Response.json({
        error: error instanceof CompetitorFetchError ? error.code : error.name,
        httpStatus: error instanceof CompetitorFetchError ? error.httpStatus : null,
        calls,
      });
    }
  },
};
