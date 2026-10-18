const TRUST = ['trusted', 'untrusted', 'unknown'] as const;
const DOCUMENT_PHASES = ['loading', 'interactive', 'complete', 'unknown'] as const;
const BUCKETS = ['known_img', 'clarity_tag', 'clarity_runtime', 'other', 'unknown'] as const;

export interface ResourceSignal {
  version: 'rs1';
  trust: (typeof TRUST)[number];
  documentPhase: (typeof DOCUMENT_PHASES)[number];
  bucket: (typeof BUCKETS)[number];
}

function fields(
  version: unknown,
  trust: unknown,
  documentPhase: unknown,
  bucket: unknown
): ResourceSignal | undefined {
  if (
    version !== 'rs1' ||
    typeof trust !== 'string' ||
    !TRUST.includes(trust as ResourceSignal['trust']) ||
    typeof documentPhase !== 'string' ||
    !DOCUMENT_PHASES.includes(documentPhase as ResourceSignal['documentPhase']) ||
    typeof bucket !== 'string' ||
    !BUCKETS.includes(bucket as ResourceSignal['bucket'])
  )
    return undefined;
  return {
    version,
    trust: trust as ResourceSignal['trust'],
    documentPhase: documentPhase as ResourceSignal['documentPhase'],
    bucket: bucket as ResourceSignal['bucket'],
  };
}

/** Bounded enum-only wire. The caller separately enforces eligible event/kind. */
export function decodeResourceSignal(value: unknown): ResourceSignal | undefined {
  if (typeof value !== 'string' || value.length > 128) return undefined;
  const tokens = value.split('|');
  if (tokens.length !== 4) return undefined;
  return fields(...(tokens as [string, string, string, string]));
}

/** Own data fields only: no inherited values, getters, toJSON or arbitrary metadata. */
export function sanitizeResourceSignal(value: unknown): ResourceSignal | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try {
    const own = ['version', 'trust', 'documentPhase', 'bucket'].map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    });
    return fields(...(own as [unknown, unknown, unknown, unknown]));
  } catch {
    return undefined;
  }
}

const TRUST_LABELS: Record<ResourceSignal['trust'], string> = {
  trusted: 'isTrusted=true；事件信任标志不证明真人或原生网络请求',
  untrusted: 'isTrusted=false；不等于已确认脚本或扩展，也不排除已观测错误',
  unknown: 'isTrusted 未知；不能补为真人、原生请求或自动化判断',
};
const PHASE_LABELS: Record<ResourceSignal['documentPhase'], string> = {
  loading: '加载中（loading）',
  interactive: '可交互（interactive）',
  complete: '文档完成（complete）',
  unknown: '未知',
};
const BUCKET_LABELS: Record<ResourceSignal['bucket'], string> = {
  known_img: '已登记图片',
  clarity_tag: 'Clarity 标签脚本',
  clarity_runtime: 'Clarity 运行脚本',
  other: '其他资源',
  unknown: '未知',
};

/** Pure finite labels, revalidated even when the value came from API JSON. */
export function resourceSignalLines(signal?: ResourceSignal): string[] {
  const value = sanitizeResourceSignal(signal);
  if (!value) return ['资源事件信号未采集或不可用，保持未知；不补为 0。'];
  return [
    `资源错误事件标志（客户端报告，未独立验证）：${TRUST_LABELS[value.trust]}；不能据此抹掉失败。`,
    `文档观测阶段：${PHASE_LABELS[value.documentPhase]}；是错误被观测时的阶段，不是请求开始或失败时刻。`,
    `受限资源桶：${BUCKET_LABELS[value.bucket]}；仅客户端本地分类线索，不含URL或ID，不是本次失败请求的已验证HTTP状态或根因。`,
  ];
}
