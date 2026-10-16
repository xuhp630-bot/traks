import type { ReactElement } from 'react';
import type { CustomEventItem } from '@traks/shared';

interface RevenuePanelProps {
  events: CustomEventItem[] | undefined;
  isLoading: boolean;
  isError?: boolean;
  onRetry?: () => void;
}

export function RevenuePanel({
  events,
  isLoading,
  isError,
  onRetry,
}: RevenuePanelProps): ReactElement {
  // A legacy backend without the currency field is unavailable, not a
  // successful zero-income response. The explorer retains its full 500 names.
  const selected = events?.slice(0, 20);
  const hasRevenueData =
    selected !== undefined && selected.every(event => Array.isArray(event.revenues));
  const rows = selected?.flatMap(event =>
    (event.revenues ?? []).map(revenue => ({ event: event.name, ...revenue }))
  );
  return (
    <section className="rounded-[20px] bg-white p-6 shadow-float" aria-labelledby="revenue-heading">
      <h3 id="revenue-heading" className="text-[15px] font-bold text-[#3D3B4F]">
        Declared revenue
      </h3>
      <p className="mt-2 text-[12px] leading-relaxed text-[#6E6C7C]">
        Income for the displayed top 20 event names, with the current channel and date filters.
        Currencies are kept separate; no exchange-rate conversion or order reconciliation.
      </p>
      <p className="mt-2 text-[12px] leading-relaxed text-[#6E6C7C]">
        原始混合收入：包含 QA、internal 与未分类事件，不是 production 经营收入；
        仅展示当前筛选下按事件次数排序的 Top 20 名称，不代表全量收入。
      </p>
      {isError ? (
        <div className="py-6 text-[13px]">
          <p role="alert" className="text-[#e07a5f]">
            Revenue could not be loaded. Refresh to retry.
          </p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              disabled={isLoading}
              className="mt-3 min-h-11 rounded-lg border border-[#E6E4DE] px-4 text-[#3D3B4F] disabled:opacity-50"
            >
              Retry revenue
            </button>
          )}
        </div>
      ) : isLoading ? (
        <p role="status" className="py-6 text-[13px] text-[#6E6C7C]">
          Loading revenue…
        </p>
      ) : !hasRevenueData ? (
        <p className="py-6 text-[13px] text-[#6E6C7C]">Revenue data is unavailable.</p>
      ) : !rows?.length ? (
        <p className="py-6 text-[13px] text-[#6E6C7C]">
          No declared income in the displayed events. Legacy event values are not assumed to be
          money.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="text-[11px] text-[#6E6C7C]">
              <tr>
                <th scope="col" className="pb-3">
                  Event
                </th>
                <th scope="col" className="pb-3">
                  Currency
                </th>
                <th scope="col" className="pb-3 text-right">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={`${row.event}:${row.currency}`} className="border-t border-[#F2F1ED]">
                  <th scope="row" className="py-3 pr-4 font-medium break-all">
                    {row.event}
                  </th>
                  <td className="py-3 pr-4 font-mono">{row.currency}</td>
                  <td className="py-3 text-right tabular-nums">
                    {new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(
                      row.amount
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-[12px] leading-relaxed text-[#6E6C7C]">
        Goals count anonymous visitors, not registered accounts. Account retention, ad spend, CAC
        and profit ROI require a separate business-data connection.
      </p>
    </section>
  );
}
