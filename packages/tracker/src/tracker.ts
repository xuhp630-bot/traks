(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  // Prevent double initialization (HMR, duplicate script tags)
  const w = window as any;
  if (w.__pb) return;

  const scriptEl = document.currentScript as HTMLScriptElement | null;
  if (!scriptEl) return;

  const siteKey = scriptEl.getAttribute('data-site');
  if (!siteKey) return;
  w.__pb = true;

  // Opt-in script attributes:
  //   data-hash - hash-based SPA routing: '#/route' becomes part of the page
  //                path and hashchange fires pageviews
  //   data-404  - put on the 404 template's snippet: fires a '404' event with
  //                the broken path as a prop (view it via the props breakdown)
  const useHash = scriptEl.hasAttribute('data-hash');
  const is404Page = scriptEl.hasAttribute('data-404');

  const endpoint = new URL(scriptEl.src).origin + '/api/event';
  let lastPage: string;

  function currentPath(): string {
    const path = useHash ? location.pathname + location.hash.split('?')[0] : location.pathname;
    return containsPrivateValue(path) ? '/[redacted]' : clip(path, 2048);
  }

  function ignored(): boolean {
    try {
      if (navigator.doNotTrack === '1' || navigator.doNotTrack === 'yes') return true;
    } catch {
      /* one unavailable signal must not hide another */
    }
    try {
      if (w.doNotTrack === '1' || w.doNotTrack === 'yes') return true;
    } catch {
      /* unavailable window privacy properties */
    }
    try {
      if ((navigator as any).globalPrivacyControl === true) return true;
    } catch {
      /* unavailable navigator privacy properties */
    }
    try {
      if (w.traks && w.traks.disabled === true) return true;
    } catch {
      /* unavailable API privacy properties */
    }
    try {
      const store = window.localStorage;
      if (
        store.getItem('traks_ignore') === 'true' ||
        store.getItem('plausible_ignore') === 'true'
      ) {
        return true;
      }
    } catch {
      /* blocked storage must not break the host page */
    }
    return false;
  }

  // Apply privacy controls before reading/writing analytics session storage.
  const initiallyIgnored = ignored();

  function containsPrivateValue(value: string): boolean {
    let decoded = value;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      /* malformed percent escapes are checked as supplied */
    }
    return /[^\s/@]+@[^\s/@]+\.[^\s/@]+|\bbearer\s+|[?&](?:email|token|password|user_id|order_id)=/i.test(
      decoded
    );
  }

  function campaignLabel(value: unknown): string {
    if (typeof value !== 'string' || containsPrivateValue(value) || /:\/\//.test(value)) return '';
    const label = clip(value, 256);
    return label;
  }

  // Automatic URLs never include credentials, query strings or fragments.
  function publicUrl(value: string): string {
    try {
      const url = new URL(value);
      if (!/^https?:$/.test(url.protocol) || containsPrivateValue(url.pathname)) return '';
      return clip(url.origin + url.pathname, 2048);
    } catch {
      return '';
    }
  }

  type Attribution = {
    r: string;
    us: string;
    um: string;
    uc: string;
    uct: string;
    ut: string;
  };
  type SessionState = Attribution & { id: string; at: number };
  const sessionKey = '_pb_s:' + siteKey;
  const sessionTimeout = 30 * 60 * 1000;
  let memorySession: SessionState | null = null;
  let mayCaptureEntry = true;

  function emptyAttribution(): Attribution {
    return { r: '', us: '', um: '', uc: '', uct: '', ut: '' };
  }

  function entryAttribution(): Attribution {
    const params = new URLSearchParams(location.search);
    const referrer = publicUrl(document.referrer);
    let externalReferrer = referrer;
    try {
      if (referrer && new URL(referrer).hostname === location.hostname) externalReferrer = '';
    } catch {
      externalReferrer = '';
    }
    return {
      r: externalReferrer,
      us: campaignLabel(params.get('utm_source')),
      um: campaignLabel(params.get('utm_medium')),
      uc: campaignLabel(params.get('utm_campaign')),
      uct: campaignLabel(params.get('utm_content')),
      ut: campaignLabel(params.get('utm_term')),
    };
  }

  // A short, site-scoped random activity session, not an account identifier.
  // First entry is locked for the session. Later URLs cannot overwrite it.
  // An expired session in a long-open document starts without the old UTM.
  function newSessionId(): string {
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }
  function getSession(): SessionState {
    const now = Date.now();
    let store: Storage | null = null;
    try {
      store = window.sessionStorage;
    } catch {
      store = null;
    }
    if (!memorySession && store) {
      try {
        const stored = JSON.parse(store.getItem(sessionKey) || 'null');
        if (
          stored &&
          typeof stored.id === 'string' &&
          /^[a-z0-9]{12,64}$/.test(stored.id) &&
          typeof stored.at === 'number' &&
          now >= stored.at &&
          now - stored.at < sessionTimeout
        ) {
          memorySession = {
            id: stored.id,
            at: stored.at,
            r: publicUrl(clip(stored.r, 2048)),
            us: campaignLabel(stored.us),
            um: campaignLabel(stored.um),
            uc: campaignLabel(stored.uc),
            uct: campaignLabel(stored.uct),
            ut: campaignLabel(stored.ut),
          };
        }
      } catch {
        /* malformed/blocked storage falls back to this document's memory */
      }
    }
    if (!memorySession || now < memorySession.at || now - memorySession.at >= sessionTimeout) {
      memorySession = {
        id: newSessionId(),
        at: now,
        ...(mayCaptureEntry ? entryAttribution() : emptyAttribution()),
      };
    }
    mayCaptureEntry = false;
    memorySession.at = now;
    try {
      if (store) store.setItem(sessionKey, JSON.stringify(memorySession));
    } catch {
      /* retain the same in-memory session when writes are blocked */
    }
    return memorySession;
  }

  // Send via fetch keepalive; on failure fall back to sendBeacon (survives
  // rapid navigations where the fetch is rejected before it's queued).
  // Clamp to the collector's field limits so an overlong value trims rather
  // than 400s the whole event (long ad-click referrers were dropping the
  // pageview they came with). Mirrors packages/shared/src/validation.ts.
  function clip(v: unknown, max: number): string {
    return (typeof v === 'string' ? v : '').slice(0, max);
  }

  function sendRequest(payload: Record<string, unknown>): void {
    if (ignored()) return;
    let body: string;
    try {
      body = JSON.stringify(payload);
    } catch {
      return;
    }
    function beaconFallback(): void {
      if (ignored()) return;
      try {
        if (navigator.sendBeacon) navigator.sendBeacon(endpoint, body);
      } catch {
        /* nothing left to try */
      }
    }
    try {
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        keepalive: true,
        body: body,
      }).catch(beaconFallback);
    } catch {
      beaconFallback();
    }
  }

  function sendEvent(payload: Record<string, unknown>): void {
    if (ignored()) return;
    try {
      const session = getSession();
      sendRequest({
        ...payload,
        s: siteKey,
        h: location.hostname,
        sid: session.id,
        r: session.r,
        us: session.us,
        um: session.um,
        uc: session.uc,
        uct: session.uct,
        ut: session.ut,
      });
    } catch {
      /* analytics must never surface in the host page */
    }
  }

  // ---- Engagement time ----
  // Accumulate wall-clock time while the page is visible; flush it as an
  // 'engagement' event (ev = engaged seconds) when the visitor hides the tab,
  // leaves the page, or SPA-navigates away. Powers the visit-duration metric.
  let engagedStart = 0; // epoch ms while accumulating, 0 while paused
  let engagedMs = 0;

  function pauseEngagement(): void {
    if (engagedStart) {
      engagedMs += Date.now() - engagedStart;
      engagedStart = 0;
    }
  }

  function flushEngagement(path: string): void {
    pauseEngagement();
    const seconds = Math.round(engagedMs / 1000);
    engagedMs = 0;
    // Skip sub-second blips and absurd values (suspended laptops etc.)
    if (seconds < 1 || seconds > 4 * 3600) return;
    sendEvent({
      t: 'engagement',
      p: path,
      ev: seconds,
    });
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      flushEngagement(lastPage || currentPath());
    } else if (lastPage) {
      engagedStart = Date.now();
    }
  });
  window.addEventListener('pagehide', function () {
    flushEngagement(lastPage || currentPath());
  });

  function page(isSPANavigation?: boolean): void {
    if (isSPANavigation && lastPage === currentPath()) return;
    // SPA navigation: credit accumulated time to the page being left.
    if (isSPANavigation && lastPage) flushEngagement(lastPage);
    lastPage = currentPath();
    engagedStart = document.visibilityState === 'hidden' ? 0 : Date.now();

    sendEvent({
      t: 'pageview',
      p: currentPath(),
      sw: screen.width,
    });
  }

  // Legacy API: window.traks('event_name', props, value).
  // Explicit options API: window.traks.event(name, { props, revenue }).
  // Do not guess an options envelope from ordinary legacy property names.
  // The install snippet ships a stub that queues calls made before this
  // script executes (window.traks.q) - capture and replay them in order,
  // so early CTA clicks and hydration-effect events are never lost.
  const pending: IArguments[] =
    typeof w.traks === 'function' && Array.isArray(w.traks.q) ? w.traks.q : [];
  const wasDisabled = typeof w.traks === 'function' && w.traks.disabled === true;

  function safeProperties(props: unknown): string {
    if (!props || typeof props !== 'object' || Array.isArray(props)) return '';
    const safe: Record<string, string | number | boolean> = Object.create(null);
    try {
      const keys = Object.keys(props);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const normalized = key
          .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
          .replace(/[.:-]/g, '_')
          .toLowerCase();
        if (
          key.length > 64 ||
          !/^[a-zA-Z0-9_.:-]+$/.test(key) ||
          /^__traks_/i.test(key) ||
          /(?:^|_)(?:email|phone|password|token|authorization|cookie|secret|user_id|account_id|customer_id|order_id|payment_id|device_id|session_id|ip_address)(?:_|$)/.test(
            normalized
          ) ||
          /^(?:input|message|query|search|body|text|prompt|content|__proto__|constructor|prototype)$/.test(
            normalized
          )
        ) {
          continue;
        }
        try {
          const value = (props as Record<string, unknown>)[key];
          if (typeof value === 'string') {
            const isUrl = /^https?:\/\//i.test(value);
            if (!isUrl && containsPrivateValue(value)) continue;
            const cleaned = isUrl ? publicUrl(value) : clip(value, 256);
            if (cleaned && !containsPrivateValue(cleaned)) safe[key] = cleaned;
          } else if (typeof value === 'number' && isFinite(value)) {
            safe[key] = value;
          } else if (typeof value === 'boolean') {
            safe[key] = value;
          }
        } catch {
          /* an individual throwing getter does not lose the event */
        }
      }
      const serialized = JSON.stringify(safe);
      return serialized === '{}' || serialized.length > 1024 ? '' : serialized;
    } catch {
      return '';
    }
  }

  type EventOptions = {
    props?: Record<string, unknown>;
    revenue?: { currency?: unknown; amount?: unknown };
  };
  type QueuedOptions = { __traksEventOptions?: boolean; revenue?: EventOptions['revenue'] };

  // Never throw into the customer's code: a circular props object or a bad
  // queued call must not break their click handler or router.
  w.traks = function (
    name: string,
    props?: Record<string, unknown>,
    value?: number,
    options?: QueuedOptions
  ): void {
    try {
      if (ignored() || (typeof name === 'string' && containsPrivateValue(name))) return;
      let ev = Number(value);
      let currency = '';
      if (options && options.__traksEventOptions === true && options.revenue) {
        const amount = options.revenue.amount;
        const candidate =
          typeof options.revenue.currency === 'string'
            ? options.revenue.currency.toUpperCase()
            : '';
        if (
          typeof amount === 'number' &&
          isFinite(amount) &&
          amount >= 0 &&
          amount <= 1000000 &&
          /^[A-Z]{3}$/.test(candidate)
        ) {
          ev = amount;
          currency = candidate;
        }
      }
      sendEvent({
        t: 'event',
        p: currentPath(),
        en: clip(name, 256),
        ep: safeProperties(props),
        ev: isFinite(ev) && ev >= 0 ? Math.min(ev, 1000000) : 0,
        ...(currency ? { rc: currency } : {}),
      });
    } catch {
      /* swallow - analytics must never surface in the host page */
    }
  };
  w.traks.disabled = wasDisabled;
  w.traks.event = function (name: string, options?: EventOptions): void {
    try {
      w.traks(name, options && options.props, undefined, {
        __traksEventOptions: true,
        revenue: options && options.revenue,
      });
    } catch {
      /* malformed options must not interfere with a business handler */
    }
  };
  for (let q = 0; q < pending.length; q++) {
    try {
      w.traks.apply(null, pending[q]);
    } catch {
      /* a foreign stub queued something odd - skip it */
    }
  }

  // ---- Outbound links + file downloads ----
  // Auto-fired as reserved custom events ("Outbound Link: Click" /
  // "File Download") with the target URL in props. The keepalive fetch in
  // sendRequest survives the navigation, so no click delay is needed.
  const FILE_RE =
    /\.(7z|avi|csv|dmg|docx?|dxf|eps|exe|gz|iso|key|midi?|mov|mp3|mp4|mpe?g|pdf|pkg|pps|ppt|pptx|rar|rtf|tgz|txt|wav|wma|wmv|xlsx?|zip)$/i;

  function handleLinkClick(event: MouseEvent): void {
    // auxclick fires for all non-primary buttons; only middle-click navigates.
    if (event.type === 'auxclick' && event.button !== 1) return;
    let el = event.target as Element | null;
    while (el && el.tagName !== 'A') el = el.parentElement;
    const link = el as HTMLAnchorElement | null;
    if (!link || !link.href || !/^https?:$/.test(link.protocol)) return;

    let name: string;
    if (link.hostname && link.hostname !== location.hostname) {
      name = 'Outbound Link: Click';
    } else if (FILE_RE.test(link.pathname) || link.hasAttribute('download')) {
      name = 'File Download';
    } else {
      return;
    }
    sendEvent({
      t: 'event',
      p: currentPath(),
      en: name,
      ep: JSON.stringify({ url: publicUrl(link.href).slice(0, 500) }),
      ev: 0,
    });
  }

  document.addEventListener('click', handleLinkClick, true);
  document.addEventListener('auxclick', handleLinkClick, true);

  // ---- WebMCP tool calls ----
  // Pages exposing tools to AI agents through the experimental WebMCP API
  // (Chrome 146+ early preview) get every agent invocation auto-tracked as a
  // reserved custom event: registerTool is patched so each tool's execute
  // callback reports its name, ok/error status, and duration (ev = ms). The
  // registry lives on document.modelContext; older drafts used
  // navigator.modelContext, so both are probed. No-ops everywhere else.
  function reportToolCall(tool: string, status: string, started: number): void {
    sendEvent({
      t: 'event',
      p: currentPath(),
      en: 'WebMCP: Tool Call',
      ep: safeProperties({ tool: tool, status: status }),
      ev: Math.min(Date.now() - started, 1000000),
    });
  }

  function wrapTool(tool: any): void {
    if (!tool || typeof tool.execute !== 'function') return;
    const toolName = clip(String(tool.name || ''), 200);
    const originalExecute = tool.execute;
    tool.execute = function (this: unknown, ...execArgs: unknown[]) {
      const started = Date.now();
      let result;
      try {
        result = originalExecute.apply(this, execArgs);
      } catch (err) {
        reportToolCall(toolName, 'error', started);
        throw err;
      }
      try {
        // Observing a promise/thenable must not change its return value.
        if (result && typeof result.then === 'function') {
          result.then(
            function () {
              reportToolCall(toolName, 'ok', started);
            },
            function () {
              reportToolCall(toolName, 'error', started);
            }
          );
        } else {
          reportToolCall(toolName, 'ok', started);
        }
      } catch {
        /* a throwing then getter is not a failure of the page's tool */
      }
      return result;
    };
  }

  let modelContext: any;
  try {
    modelContext = (document as any).modelContext;
  } catch {
    /* optional API can have an unavailable/throwing getter */
  }
  if (!modelContext) {
    try {
      modelContext = (navigator as any).modelContext;
    } catch {
      /* optional API */
    }
  }
  try {
    if (modelContext && typeof modelContext.registerTool === 'function') {
      const originalRegisterTool = modelContext.registerTool;
      modelContext.registerTool = function (tool: any, ...rest: unknown[]) {
        try {
          wrapTool(tool);
        } catch {
          /* never interfere with the page's tool registration */
        }
        return originalRegisterTool.call(this, tool, ...rest);
      };
    }
  } catch {
    /* frozen/throwing optional APIs must not stop native tracking */
  }
  try {
    if (modelContext && typeof modelContext.provideContext === 'function') {
      const originalProvideContext = modelContext.provideContext;
      modelContext.provideContext = function (context: any, ...rest: unknown[]) {
        try {
          if (context && Array.isArray(context.tools)) {
            for (let i = 0; i < context.tools.length; i++) wrapTool(context.tools[i]);
          }
        } catch {
          /* never interfere with the page's tool registration */
        }
        return originalProvideContext.call(this, context, ...rest);
      };
    }
  } catch {
    /* frozen/throwing optional APIs must not stop native tracking */
  }

  if (useHash) {
    window.addEventListener('hashchange', function () {
      page(true);
    });
  }

  // 404 template: report the broken path once per load, alongside the pageview.
  if (is404Page) {
    sendEvent({
      t: 'event',
      p: currentPath(),
      en: '404',
      ep: JSON.stringify({ path: currentPath().slice(0, 500) }),
      ev: 0,
    });
  }

  // SPA support - mirrors Plausible exactly:
  // - Intercept pushState only (NOT replaceState)
  // - Listen to popstate
  // - Pass isSPANavigation=true for dedup
  const his = history;
  if (his.pushState) {
    const originalPushState = his.pushState;
    his.pushState = function (...args: Parameters<typeof originalPushState>) {
      originalPushState.apply(this, args);
      page(true);
    };
    window.addEventListener('popstate', function () {
      page(true);
    });
  }

  // Prerendered documents (Chrome speculation rules / omnibox) may never be
  // shown - defer their initial pageview until activation, using the signal
  // designed for exactly this (prerenderingchange). Everything else - even a
  // load in a hidden background tab - counts immediately: the old
  // visibility-based deferral silently LOST pageviews for pages evaluated
  // hidden and left before ever becoming visible.
  const doc = document as Document & { prerendering?: boolean };
  if (doc.prerendering) {
    doc.addEventListener(
      'prerenderingchange',
      function () {
        page();
      },
      { once: true }
    );
  } else if (!initiallyIgnored) {
    page();
  }

  // Handle bfcache (back/forward navigation restoring cached page). Flagged as
  // an SPA navigation so the lastPage dedup applies: popstate can fire first on
  // a bfcache restore, and an unflagged call would then double-count the view.
  window.addEventListener('pageshow', function (event) {
    if (event.persisted) {
      page(true);
    }
  });
})();
