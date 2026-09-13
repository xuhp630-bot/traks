import { useState, type FormEvent, type ReactElement, type ReactNode } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, Copy, Download, KeyRound, Plus, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { useCollectUrl } from '@/lib/config';
import { skillMarkdown } from '@/lib/skill';

export const Route = createFileRoute('/portal/mcp')({
  component: McpPage,
});

/* ── clients ────────────────────────────────────────────────────── */

type ClientId = 'claude-code' | 'claude-desktop' | 'cursor' | 'vscode' | 'windsurf' | 'zed';

const CLIENTS: { id: ClientId; label: string; icon: string }[] = [
  { id: 'claude-code', label: 'Claude Code', icon: '/mcp-clients/claude.svg' },
  { id: 'claude-desktop', label: 'Claude Desktop', icon: '/mcp-clients/claude.svg' },
  { id: 'cursor', label: 'Cursor', icon: '/mcp-clients/cursor.svg' },
  { id: 'vscode', label: 'VS Code', icon: '/mcp-clients/vscode.svg' },
  { id: 'windsurf', label: 'Windsurf', icon: '/mcp-clients/windsurf.svg' },
  { id: 'zed', label: 'Zed', icon: '/mcp-clients/zed.svg' },
];

/** JSON-based clients embed the URL and token in a config file; mcp-remote
 *  bridges clients that only launch stdio servers. */
function buildConfig(
  client: ClientId,
  mcpUrl: string,
  token: string
): { title: string; snippet: string; hint: string } {
  const jsonHeaders = `"headers": { "Authorization": "Bearer ${token}" }`;
  switch (client) {
    case 'claude-code':
      return {
        title: 'Add Traks to Claude Code',
        snippet: `claude mcp add --transport http traks ${mcpUrl} \\
  --header "Authorization: Bearer ${token}"`,
        hint: 'Run once in any project, then ask Claude Code "what were my top pages yesterday?".',
      };
    case 'claude-desktop':
      return {
        title: 'Add Traks to Claude Desktop',
        snippet: `{
  "mcpServers": {
    "traks": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote", "${mcpUrl}",
        "--header", "Authorization: Bearer ${token}"
      ]
    }
  }
}`,
        hint: 'Settings → Developer → Edit Config (claude_desktop_config.json), then restart the app.',
      };
    case 'cursor':
      return {
        title: 'Add Traks to Cursor',
        snippet: `{
  "mcpServers": {
    "traks": {
      "url": "${mcpUrl}",
      ${jsonHeaders}
    }
  }
}`,
        hint: 'Add to .cursor/mcp.json in your project (or ~/.cursor/mcp.json for everywhere), then reload.',
      };
    case 'vscode':
      return {
        title: 'Add Traks to VS Code',
        snippet: `{
  "servers": {
    "traks": {
      "type": "http",
      "url": "${mcpUrl}",
      ${jsonHeaders}
    }
  }
}`,
        hint: 'Add to .vscode/mcp.json, then start the server from the Extensions → MCP Servers view.',
      };
    case 'windsurf':
      return {
        title: 'Add Traks to Windsurf',
        snippet: `{
  "mcpServers": {
    "traks": {
      "serverUrl": "${mcpUrl}",
      ${jsonHeaders}
    }
  }
}`,
        hint: 'Add to ~/.codeium/windsurf/mcp_config.json, then refresh plugins in Cascade.',
      };
    case 'zed':
      return {
        title: 'Add Traks to Zed',
        snippet: `{
  "context_servers": {
    "traks": {
      "command": {
        "path": "npx",
        "args": [
          "-y", "mcp-remote", "${mcpUrl}",
          "--header", "Authorization: Bearer ${token}"
        ]
      }
    }
  }
}`,
        hint: 'Add to Zed settings.json (cmd-,), then check the server under Agent Panel settings.',
      };
  }
}

/* ── tools ──────────────────────────────────────────────────────── */

/** Mirrors the tool list in api/src/routes/mcp.ts. Keep the two in step when
 *  a tool is added or renamed. */
const TOOLS: { name: string; desc: string; manage?: boolean }[] = [
  { name: 'list_sites', desc: 'sites in this workspace' },
  { name: 'get_tracking_snippet', desc: 'the script tag for a site' },
  { name: 'get_stats', desc: 'visitors, pageviews, breakdowns; today is live' },
  { name: 'get_goal_stats', desc: 'conversions per goal' },
  { name: 'get_funnel_stats', desc: 'step completion and drop-off' },
  { name: 'get_custom_events', desc: 'events fired, counts and totals' },
  { name: 'get_event_props', desc: 'property breakdown for one event' },
  { name: 'get_quality_evidence', desc: 'complete paginated quality evidence' },
  { name: 'get_quality_insights', desc: 'quality summary, issue cards and candidates' },
  { name: 'get_webmcp_stats', desc: 'which WebMCP tools agents call' },
  { name: 'get_bot_stats', desc: 'bot pageviews by name' },
  { name: 'list_goals', desc: 'goals defined for a site' },
  { name: 'list_funnels', desc: 'funnels, name and steps' },
  { name: 'create_goal', desc: 'match an event or a page', manage: true },
  { name: 'update_goal', desc: 'change a goal', manage: true },
  { name: 'delete_goal', desc: 'definition only, never data', manage: true },
  { name: 'create_funnel', desc: 'define ordered steps', manage: true },
  { name: 'update_funnel', desc: 'replace name and steps', manage: true },
  { name: 'delete_funnel', desc: 'remove a funnel', manage: true },
];

/* ── page ───────────────────────────────────────────────────────── */

interface TokenRow {
  id: string;
  name: string;
  suffix: string;
  scope: 'read' | 'manage';
  workspaceId: string | null;
  createdAt: string | null;
  lastUsedAt: string | null;
}

type Scope = 'read' | 'manage';

const CARD = 'rounded-[20px] bg-white shadow-float';
const EYEBROW = 'text-[10.5px] font-bold uppercase tracking-[0.1em] text-[#9B9590]';

/**
 * MCP server: the endpoint strip, a guided "connect a client" stepper (pick
 * a client, pick or mint a token, paste that client's config, add the skill)
 * beside the tool reference, over the table of tokens bound to the current
 * workspace.
 */
function McpPage(): ReactElement {
  const queryClient = useQueryClient();
  const { current } = useWorkspace();
  const origin = window.location.origin;
  const collectUrl = useCollectUrl();
  const mcpUrl = `${origin}/api/mcp`;

  const [client, setClient] = useState<ClientId>('claude-code');
  const [tokenId, setTokenId] = useState('');
  /** Full secret of a token minted on this page - the only time a real token
   *  can be embedded in the snippet (stored tokens are hashed, suffix-only). */
  const [minted, setMinted] = useState<{ id: string; secret: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState('');

  // Only this workspace's tokens (plus legacy unscoped ones, which apply
  // everywhere and must stay revocable from somewhere).
  const tokensQ = useQuery({
    queryKey: ['api-tokens', current?.id],
    queryFn: () => api.getTokens(current!.id),
    enabled: Boolean(current),
    staleTime: 60_000,
  });
  const tokens = ((tokensQ.data as any)?.data ?? []) as TokenRow[];

  const invalidate = (): void => {
    queryClient.invalidateQueries({ queryKey: ['api-tokens'] });
  };

  const revokeToken = useMutation({
    mutationFn: (id: string) => api.revokeToken(id),
    onSuccess: (_res, id) => {
      if (tokenId === id) setTokenId('');
      if (minted?.id === id) setMinted(null);
      invalidate();
    },
    onError: (err: Error) => setError(err.message),
  });

  const copy = async (text: string, tag: string): Promise<void> => {
    await navigator.clipboard.writeText(text);
    setCopied(tag);
    setTimeout(() => setCopied(null), 2000);
  };

  const selected = tokens.find(t => t.id === tokenId);
  const tokenDone = Boolean(minted || selected);
  const snippetToken = minted
    ? minted.secret
    : selected
      ? `traks_pat_…${selected.suffix}  ⟵ paste the full token`
      : '<token>';
  const cfg = buildConfig(client, mcpUrl, snippetToken);

  const downloadSkill = (): void => {
    const blob = new Blob([skillMarkdown(origin, collectUrl ?? origin)], {
      type: 'text/markdown',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'SKILL.md';
    a.click();
    URL.revokeObjectURL(url);
  };

  const CopyButton = ({ text, tag }: { text: string; tag: string }): ReactElement => (
    <Button
      variant="outline"
      size="sm"
      onClick={() => void copy(text, tag)}
      className="h-8 shrink-0 rounded-full px-3 text-[12px] text-[#3D3B4F]"
    >
      {copied === tag ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied === tag ? 'Copied' : 'Copy'}
    </Button>
  );

  return (
    <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
      <div className="mb-6">
        <h1 className="text-[26px] font-bold text-[#3D3B4F] tracking-[-0.02em]">MCP server</h1>
        <p className="mt-1 max-w-[62ch] text-[14px] text-[#9B9590]">
          Give Claude Code and other agents their own analytics tools: read stats, set up goals and
          funnels, pull the tracking snippet.
        </p>
      </div>

      {/* Endpoint - always visible, independent of the steps below */}
      <div className={`${CARD} flex flex-wrap items-center justify-between gap-4 p-5`}>
        <div className="min-w-0 flex-1">
          <span className={`${EYEBROW} mb-2 block`}>Your MCP endpoint</span>
          <div className="flex items-center gap-2.5">
            <code className="min-w-0 flex-1 truncate rounded-[10px] bg-[#F2F1ED] px-3.5 py-2.5 font-mono text-[12.5px] text-[#3D3B4F]">
              {mcpUrl}
            </code>
            <CopyButton text={mcpUrl} tag="url" />
          </div>
        </div>
        <div className="text-right">
          <span className="inline-flex rounded-full bg-[#E3F6EE] px-2.5 py-0.5 text-[11.5px] font-bold text-[#123326]">
            {TOOLS.length} tools available
          </span>
          <p className="mt-1.5 text-[11.5px] text-[#9B9590]">Streamable HTTP · Bearer token auth</p>
        </div>
      </div>

      <div className="mt-4 grid items-start gap-4 lg:grid-cols-[7fr_5fr]">
        {/* Guided setup */}
        <div className={`${CARD} p-6`}>
          <h2 className="mb-5 text-[15px] font-semibold text-[#3D3B4F]">Connect a client</h2>

          <div className="grid grid-cols-[26px_1fr] gap-x-3.5">
            <Step n={1} done>
              <p className="pt-0.5 text-[13.5px] font-semibold text-[#3D3B4F]">
                Choose your client
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {CLIENTS.map(c => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setClient(c.id)}
                    className={cn(
                      'inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12px] transition-colors cursor-pointer',
                      client === c.id
                        ? 'bg-[#3D3B4F] font-semibold text-white'
                        : 'border border-[#E6E4DE] bg-white font-medium text-[#6E6C7C] hover:bg-[#F2F1ED] hover:text-[#3D3B4F]'
                    )}
                  >
                    <img
                      src={c.icon}
                      alt=""
                      className={cn('h-3.5 w-3.5', client === c.id && 'brightness-0 invert')}
                    />
                    {c.label}
                  </button>
                ))}
              </div>
            </Step>

            <Step n={2} done={tokenDone}>
              <p className="pt-0.5 text-[13.5px] font-semibold text-[#3D3B4F]">Pick a token</p>
              <div className="mt-2 flex items-center gap-2.5">
                <div className="relative flex-1">
                  <select
                    value={tokenId}
                    onChange={e => {
                      setTokenId(e.target.value);
                      if (minted && e.target.value !== minted.id) setMinted(null);
                    }}
                    disabled={!current}
                    className="h-10 w-full cursor-pointer appearance-none rounded-[10px] bg-[#F2F1ED] pl-4 pr-9 text-[13px] text-[#3D3B4F] outline-none focus:shadow-[inset_0_0_0_1.5px_var(--ring)] disabled:cursor-default"
                  >
                    <option value="">Select a token…</option>
                    {tokens.map(t => (
                      <option key={t.id} value={t.id}>
                        traks_pat_…{t.suffix} · {t.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9B9590]" />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCreating(true)}
                  disabled={!current}
                  className="h-10 rounded-full px-4 text-[12px] text-[#3D3B4F]"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Create token
                </Button>
              </div>
              {minted ? (
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <p className="text-[12px] font-medium text-[#1C9C6C]">
                    New token is filled into the config below. It is shown only until you leave this
                    page.
                  </p>
                  <button
                    type="button"
                    onClick={() => void copy(minted.secret, 'secret')}
                    className="text-[12px] text-[#6E6C7C] underline-offset-2 hover:underline cursor-pointer"
                  >
                    {copied === 'secret' ? 'Copied' : 'Copy token'}
                  </button>
                </div>
              ) : (
                <p className="mt-2 text-[12px] leading-relaxed text-[#9B9590]">
                  Stored tokens are hashed, so an existing token leaves a blank to fill in. Create
                  one here to get a paste-ready config.
                </p>
              )}
            </Step>

            <Step n={3} done={false}>
              <div className="flex items-center justify-between gap-3 pt-0.5">
                <p className="text-[13.5px] font-semibold text-[#3D3B4F]">{cfg.title}</p>
                <CopyButton text={cfg.snippet} tag="cmd" />
              </div>
              <pre className="mt-2 overflow-x-auto rounded-xl border border-[#E6E4DE] bg-white px-4 py-3.5 font-mono text-[12px] leading-[1.7] text-[#3D3B4F]">
                {cfg.snippet}
              </pre>
              <p className="mt-2 text-[12px] leading-relaxed text-[#9B9590]">{cfg.hint}</p>
            </Step>

            <Step n={4} done={false} last>
              <p className="pt-0.5 text-[13.5px] font-semibold text-[#3D3B4F]">Give it the skill</p>
              <p className="mt-1 text-[12px] leading-relaxed text-[#9B9590]">
                SKILL.md teaches the agent to instrument your site and use these tools well. Put it
                in{' '}
                <code className="rounded bg-[#F2F1ED] px-1.5 py-0.5 font-mono text-[11px] text-[#3D3B4F]">
                  .claude/skills/traks/
                </code>
                .
              </p>
              <div className="mt-2.5 flex items-center gap-2">
                <Button variant="dark" size="sm" onClick={downloadSkill} className="text-[12px]">
                  <Download className="h-3.5 w-3.5" />
                  Download SKILL.md
                </Button>
                <Button asChild variant="ghost" size="sm" className="text-[12px]">
                  <Link to="/portal/skill">View</Link>
                </Button>
              </div>
            </Step>
          </div>
        </div>

        {/* Tools reference */}
        <div className={`${CARD} p-6`}>
          <div className="flex items-center justify-between">
            <h2 className="text-[15px] font-semibold text-[#3D3B4F]">Tools</h2>
            <span className="rounded-full bg-[#E3F6EE] px-2.5 py-0.5 text-[11.5px] font-bold text-[#123326]">
              {TOOLS.length}
            </span>
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-[#9B9590]">
            What a connected agent can do, scoped by the token it authenticates with.
          </p>
          <div className="mt-3">
            {TOOLS.map((t, i) => (
              <div
                key={t.name}
                className={cn(
                  'flex items-baseline gap-2.5 py-2',
                  i > 0 && 'border-t border-[#F2F1ED]'
                )}
              >
                <code className="font-mono text-[12px] font-semibold text-[#3D3B4F]">{t.name}</code>
                <span className="min-w-0 flex-1 text-[12px] text-[#6E6C7C]">{t.desc}</span>
                {t.manage && (
                  <span className="inline-flex shrink-0 rounded-full bg-[#3D3B4F] px-2 py-0.5 text-[10px] font-medium leading-4 text-white">
                    Manage
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Tokens table */}
      <div className={`${CARD} mt-4 overflow-hidden`}>
        <div className="flex items-center justify-between gap-3 px-5 pb-2 pt-4">
          <p className="text-[14px] font-semibold text-[#3D3B4F]">
            Active tokens
            {current && (
              <span className="ml-2 text-[12px] font-normal text-[#9B9590]">{current.name}</span>
            )}
          </p>
          <p className="text-[12px] text-[#9B9590]">Revoking takes effect immediately</p>
        </div>
        {error && <p className="px-5 pb-2 text-[12px] text-[#e07a5f]">{error}</p>}

        {tokens.length === 0 ? (
          <p className="border-t border-[#F2F1ED] px-5 py-8 text-center text-[13px] text-[#9B9590]">
            {tokensQ.isPending ? 'Loading…' : 'No tokens in this workspace yet - create one above.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[720px]">
              <div
                className={`grid grid-cols-[minmax(0,2fr)_110px_140px_130px_40px] gap-3 px-4 py-2 ${EYEBROW}`}
              >
                <span>Name</span>
                <span>Scope</span>
                <span>Last used</span>
                <span>Created</span>
                <span />
              </div>
              {tokens.map(t => (
                <div
                  key={t.id}
                  className="grid grid-cols-[minmax(0,2fr)_110px_140px_130px_40px] items-center gap-3 border-t border-[#F2F1ED] px-4 py-3"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-[#F2F1ED] text-[#6E6C7C]">
                      <KeyRound className="h-3.5 w-3.5" strokeWidth={1.8} />
                    </span>
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-[13px] font-semibold text-[#3D3B4F]">
                        {t.name}
                      </span>
                      <span className="truncate font-mono text-[11px] text-[#9B9590]">
                        traks_pat_…{t.suffix}
                        {t.workspaceId === null && (
                          <span className="ml-2 font-sans">· all workspaces (legacy)</span>
                        )}
                      </span>
                    </div>
                  </div>
                  <span>
                    <ScopePill scope={t.scope} />
                  </span>
                  <span
                    className={`text-[12.5px] ${t.lastUsedAt ? 'text-[#6E6C7C]' : 'text-[#B5B0AA]'}`}
                  >
                    {t.lastUsedAt ? formatDate(t.lastUsedAt) : 'Never used'}
                  </span>
                  <span className="text-[12.5px] text-[#6E6C7C]">
                    {t.createdAt ? formatDate(t.createdAt) : '—'}
                  </span>
                  <button
                    onClick={() => revokeToken.mutate(t.id)}
                    disabled={revokeToken.isPending}
                    title="Revoke token"
                    className="flex h-7 w-7 items-center justify-center rounded-lg text-[#B5B0AA] transition-colors hover:bg-[#e07a5f]/10 hover:text-[#e07a5f] cursor-pointer"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {current && (
        <CreateTokenModal
          open={creating}
          onOpenChange={setCreating}
          workspaceId={current.id}
          workspaceName={current.name}
          defaultName={CLIENTS.find(c => c.id === client)?.label ?? ''}
          onCreated={(id, secret) => {
            setMinted({ id, secret });
            setTokenId(id);
            invalidate();
          }}
        />
      )}
    </main>
  );
}

/* ── pieces ─────────────────────────────────────────────────────── */

/** One stepper row: number disc (mint check when done) with a hairline rail
 *  down to the next step, and the step body. Rendered as two grid cells so
 *  every row shares the same rail column. */
function Step({
  n,
  done,
  last = false,
  children,
}: {
  n: number;
  done: boolean;
  last?: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <>
      <div className="flex flex-col items-center">
        <span
          className={cn(
            'flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-[11px] font-bold',
            done
              ? 'bg-mint text-[#123326]'
              : 'border-[1.5px] border-[#D9D6CF] bg-white text-[#9B9590]'
          )}
        >
          {done ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : n}
        </span>
        {!last && <span className="mt-1.5 w-px flex-1 bg-[#E6E4DE]" />}
      </div>
      <div className={cn('min-w-0', !last && 'pb-6')}>{children}</div>
    </>
  );
}

function CreateTokenModal({
  open,
  onOpenChange,
  workspaceId,
  workspaceName,
  defaultName,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  workspaceName: string;
  defaultName: string;
  onCreated: (id: string, secret: string) => void;
}): ReactElement {
  const [name, setName] = useState('');
  const [scope, setScope] = useState<Scope>('manage');

  const create = useMutation({
    mutationFn: () => api.createToken({ name: name.trim(), scope, workspaceId }),
    onSuccess: (result: any) => {
      onCreated(result.data?.id as string, result.secret as string);
      setName('');
      setScope('manage');
      onOpenChange(false);
    },
  });

  const close = (): void => {
    create.reset();
    onOpenChange(false);
  };

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (name.trim()) create.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={o => (o ? onOpenChange(true) : close())}>
      <DialogContent onClose={close} className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create a token</DialogTitle>
          <DialogDescription>
            Bound to {workspaceName}. Shown once, then only its suffix.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <DialogBody>
            <div className="space-y-4">
              <label className="block">
                <span className="mb-1.5 block text-[12px] font-semibold text-[#6E6C7C]">Name</span>
                <Input
                  autoFocus
                  placeholder={defaultName || 'e.g. Claude Code'}
                  value={name}
                  maxLength={100}
                  onChange={e => setName(e.target.value)}
                  className="h-10 bg-[#F2F1ED] px-4 text-[13px] focus:shadow-[inset_0_0_0_1.5px_var(--ring)]"
                />
              </label>
              <div>
                <span className="mb-1.5 block text-[12px] font-semibold text-[#6E6C7C]">Scope</span>
                <ScopeToggle value={scope} onChange={setScope} />
                <p className="mt-2 text-[12px] leading-relaxed text-[#9B9590]">
                  Manage can create and edit goals and funnels. Read-only sees stats. The new token
                  drops straight into step 2 and the config snippet.
                </p>
              </div>
              {create.error && (
                <p className="text-[12px] text-[#e07a5f]">{(create.error as Error).message}</p>
              )}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={name.trim().length === 0}
              isLoading={create.isPending}
              className="text-[12px] px-4"
            >
              <Plus className="h-3.5 w-3.5" />
              Create token
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Flat two-way switch: inset track, white active segment with a hairline. */
function ScopeToggle({
  value,
  onChange,
}: {
  value: Scope;
  onChange: (s: Scope) => void;
}): ReactElement {
  const seg = (s: Scope, label: string): ReactElement => (
    <button
      type="button"
      onClick={() => onChange(s)}
      className={`rounded-full px-3 py-[5px] text-[12px] transition-colors cursor-pointer ${
        value === s
          ? 'bg-white font-semibold text-[#3D3B4F] shadow-[inset_0_0_0_1px_#E6E4DE]'
          : 'text-[#6E6C7C] hover:text-[#3D3B4F]'
      }`}
    >
      {label}
    </button>
  );
  return (
    <div className="inline-flex rounded-full bg-[#F2F1ED] p-[3px]">
      {seg('manage', 'Manage')}
      {seg('read', 'Read-only')}
    </div>
  );
}

function ScopePill({ scope }: { scope: Scope }): ReactElement {
  return scope === 'manage' ? (
    <span className="inline-flex rounded-full bg-[#3D3B4F] px-2 py-0.5 text-[11px] font-medium text-white">
      Manage
    </span>
  ) : (
    <span className="inline-flex rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-[#6E6C7C] shadow-[inset_0_0_0_1px_#E6E4DE]">
      Read-only
    </span>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return `Today, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}
