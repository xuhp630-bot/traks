import type { ReactElement } from 'react';
import {
  resourceDiagnosticLines,
  resourceSignalLines,
  sanitizeResourceSignal,
  type ResourceDiagnostic,
  type ResourceSignal,
} from '@traks/shared';

/** Only shared finite-enum revalidation/labels supply resource details. */
export function ResourceDiagnosticDetails({
  diagnostic,
  signal,
  resourceKind,
}: {
  diagnostic?: ResourceDiagnostic;
  signal?: ResourceSignal;
  resourceKind?: string;
}): ReactElement {
  const resourceSignal =
    resourceKind === 'img' || resourceKind === 'script'
      ? sanitizeResourceSignal(signal)
      : undefined;
  if (!diagnostic && !resourceSignal) {
    return (
      <p className="mt-2 break-words text-xs text-[#6E6C7C]">
        资源明细未采集（历史或未识别记录，保持未知）。
      </p>
    );
  }

  return (
    <div
      aria-label={diagnostic ? '图片失败诊断明细' : '资源事件信号明细'}
      className="mt-2 space-y-1 text-xs text-[#6E6C7C]"
    >
      {diagnostic && (
        <>
          {resourceDiagnosticLines(diagnostic).map((line, index) => (
            <p key={index} className="break-words">
              {line}
            </p>
          ))}
          <p className="break-words">
            快照与同URL时序仅作线索，非该失败请求的已验证HTTP状态，也不能据此确定根因。
          </p>
        </>
      )}
      {resourceSignal &&
        resourceSignalLines(resourceSignal).map((line, index) => (
          <p key={`signal-${index}`} className="break-words">
            {line}
          </p>
        ))}
    </div>
  );
}
