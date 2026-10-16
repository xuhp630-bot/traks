import type { ReactElement } from 'react';
import { resourceDiagnosticLines, type ResourceDiagnostic } from '@traks/shared';

/** Only the shared finite-enum decoder/labels supply image details. */
export function ResourceDiagnosticDetails({
  diagnostic,
}: {
  diagnostic?: ResourceDiagnostic;
}): ReactElement {
  if (!diagnostic) {
    return (
      <p className="mt-2 break-words text-xs text-[#6E6C7C]">
        资源明细未采集（历史或未识别记录，保持未知）。
      </p>
    );
  }

  return (
    <div aria-label="图片失败诊断明细" className="mt-2 space-y-1 text-xs text-[#6E6C7C]">
      {resourceDiagnosticLines(diagnostic).map((line, index) => (
        <p key={index} className="break-words">
          {line}
        </p>
      ))}
      <p className="break-words">
        快照与同URL时序仅作线索，非该失败请求的已验证HTTP状态，也不能据此确定根因。
      </p>
    </div>
  );
}
