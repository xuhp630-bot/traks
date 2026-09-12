import type { ReactElement } from 'react';
import { cn } from '@/lib/utils';
import type { Period } from '@traks/shared';

interface PeriodPickerProps {
  value: Period;
  onChange: (period: Period) => void;
}

const PERIOD_OPTIONS: { label: string; value: Period }[] = [
  { label: 'Today', value: 'today' },
  { label: 'Yesterday', value: 'yesterday' },
  { label: '7D', value: '7d' },
  { label: '30D', value: '30d' },
  { label: '90D', value: '90d' },
  { label: '6M', value: '6m' },
  { label: '1Y', value: '1y' },
  { label: 'All', value: 'all' },
];

/** Floating pill segmented control; the active segment fills with ink. */
export function PeriodPicker({ value, onChange }: PeriodPickerProps): ReactElement {
  return (
    <>
      <select
        aria-label="Date range"
        value={value}
        onChange={event => onChange(event.target.value as Period)}
        className="min-h-11 max-w-full rounded-full border border-[#E6E4DE] bg-white px-4 text-sm font-medium text-[#3D3B4F] sm:hidden"
      >
        {PERIOD_OPTIONS.map(option => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <div
        role="group"
        aria-label="Date range"
        className="hidden max-w-full flex-wrap gap-0.5 rounded-full border border-[#E6E4DE] bg-white p-1 sm:inline-flex"
      >
        {PERIOD_OPTIONS.map(option => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            className={cn(
              'rounded-full px-3.5 py-1.5 text-[12px] font-medium transition-all cursor-pointer',
              value === option.value
                ? 'bg-[#3D3B4F] text-white font-semibold'
                : 'text-[#9B9590] hover:text-[#6b6560]'
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </>
  );
}
