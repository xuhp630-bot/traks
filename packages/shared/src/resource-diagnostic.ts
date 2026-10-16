const RESOURCE_KEYS = [
  'logo',
  'worksheet_png',
  'worksheet_webp_688',
  'worksheet_webp_1376',
  'other',
  'unknown',
] as const;
const RESOURCE_SLOTS = [
  'navbar',
  'mobile_navbar',
  'footer',
  'hero',
  'ssr_preview',
  'unknown',
] as const;

type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';
type ImageState =
  | `${'attached' | 'detached'}_${'complete' | 'pending'}_${'zero' | 'nonzero'}`
  | 'unknown';
type RenderContext =
  `${'box' | 'no_box' | 'unknown'}_${'narrow' | 'mid' | 'wide' | 'unknown'}_${'standard' | 'high' | 'unknown'}`;
type TimingHint =
  | 'unsupported'
  | 'none'
  | 'ambiguous'
  | 'zero_or_hidden'
  | 'unknown'
  | `status_${'1' | '2' | '3' | '4' | '5'}${Digit}${Digit}`;

export interface ResourceDiagnostic {
  version: 'rd1';
  key: (typeof RESOURCE_KEYS)[number];
  slot: (typeof RESOURCE_SLOTS)[number];
  imageState: ImageState;
  renderContext: RenderContext;
  capturePhase: 'live';
  timingHint: TimingHint;
}

function enumValue<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function diagnosticFields(
  version: unknown,
  key: unknown,
  slot: unknown,
  imageState: unknown,
  renderContext: unknown,
  capturePhase: unknown,
  timingHint: unknown
): ResourceDiagnostic | undefined {
  if (
    version !== 'rd1' ||
    !enumValue(key, RESOURCE_KEYS) ||
    !enumValue(slot, RESOURCE_SLOTS) ||
    typeof imageState !== 'string' ||
    !(
      imageState === 'unknown' ||
      /^(attached|detached)_(complete|pending)_(zero|nonzero)$/.test(imageState)
    ) ||
    typeof renderContext !== 'string' ||
    !/^(box|no_box|unknown)_(narrow|mid|wide|unknown)_(standard|high|unknown)$/.test(
      renderContext
    ) ||
    capturePhase !== 'live' ||
    typeof timingHint !== 'string' ||
    !(
      ['unsupported', 'none', 'ambiguous', 'zero_or_hidden', 'unknown'].includes(timingHint) ||
      /^status_[1-5][0-9]{2}$/.test(timingHint)
    )
  )
    return undefined;
  return {
    version,
    key,
    slot,
    imageState: imageState as ImageState,
    renderContext: renderContext as RenderContext,
    capturePhase,
    timingHint: timingHint as TimingHint,
  };
}

/** Decode the bounded wire value only; the caller must separately check event eligibility. */
export function decodeResourceDiagnostic(value: unknown): ResourceDiagnostic | undefined {
  if (typeof value !== 'string' || value.length > 128) return undefined;
  const tokens = value.split('|');
  if (tokens.length !== 7) return undefined;
  return diagnosticFields(...(tokens as [string, string, string, string, string, string, string]));
}

/** Revalidate API JSON and project only the seven safe fields, never arbitrary metadata. */
export function sanitizeResourceDiagnostic(value: unknown): ResourceDiagnostic | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try {
    const diagnostic = value as Record<string, unknown>;
    return diagnosticFields(
      diagnostic.version,
      diagnostic.key,
      diagnostic.slot,
      diagnostic.imageState,
      diagnostic.renderContext,
      diagnostic.capturePhase,
      diagnostic.timingHint
    );
  } catch {
    return undefined;
  }
}

const KEY_LABELS: Record<ResourceDiagnostic['key'], string> = {
  logo: '站点 Logo',
  worksheet_png: '估算表预览 PNG',
  worksheet_webp_688: '估算表预览 WebP 688',
  worksheet_webp_1376: '估算表预览 WebP 1376',
  other: '其他首方图片（未登记）',
  unknown: '图片身份未知',
};
const SLOT_LABELS: Record<ResourceDiagnostic['slot'], string> = {
  navbar: '桌面导航',
  mobile_navbar: '移动导航',
  footer: '页脚',
  hero: '主视觉',
  ssr_preview: 'SSR 预览',
  unknown: '位置未知',
};
const TIMING_LABELS = {
  unsupported: '浏览器不支持该状态观测',
  none: '未找到可用的同 URL 资源时序',
  ambiguous: '候选时序有歧义，未确定状态',
  zero_or_hidden: '状态为 0 或不可见；0 不是失败代码',
  unknown: '时序线索未知',
};

/** Presentation is pure, bounded and safe even for malformed JSON from an older/newer API. */
export function resourceDiagnosticLines(diagnostic?: ResourceDiagnostic): string[] {
  const value = sanitizeResourceDiagnostic(diagnostic);
  if (!value) return ['原生图片诊断不可用（历史、未识别或未采集；不是 0）。'];
  const state = value.imageState === 'unknown' ? null : value.imageState.split('_');
  const render = value.renderContext.match(
    /^(box|no_box|unknown)_(narrow|mid|wide|unknown)_(standard|high|unknown)$/
  )!;
  const box = { box: '非零布局框', no_box: '无非零布局框', unknown: '布局框未知' };
  const viewport = { narrow: '窄视口档', mid: '中视口档', wide: '宽视口档', unknown: '视口档未知' };
  const density = { standard: '标准 DPR 档', high: '高 DPR 档', unknown: 'DPR 档未知' };
  const timing = value.timingHint.startsWith('status_')
    ? `同 URL Resource Timing 候选 HTTP ${value.timingHint.slice(7)}`
    : `Resource Timing：${TIMING_LABELS[value.timingHint as keyof typeof TIMING_LABELS]}`;
  return [
    `图片资源：${KEY_LABELS[value.key]}；位置：${SLOT_LABELS[value.slot]}。`,
    state
      ? `图片状态快照：${state[0] === 'attached' ? '已连接 DOM' : '已脱离 DOM'} / complete=${state[1] === 'complete'} / naturalWidth ${state[2] === 'zero' ? '= 0' : '> 0'}；不是成功或解码判定。`
      : '图片状态快照未知；不能补为成功或失败原因。',
    `布局快照：${box[render[1] as keyof typeof box]} / ${viewport[render[2] as keyof typeof viewport]} / ${density[render[3] as keyof typeof density]}；布局框不证明用户可见。`,
    '采集阶段：初始化后实时错误（live）；不含早期错误回放。',
    `${timing}；不是本次失败 IMG 请求的已验证 HTTP 状态或根因，同 URL 可共享时序，200 也不能抹掉已观测错误。`,
  ];
}
