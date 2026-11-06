import React, { useState } from 'react';
import { MonthlyTrendPoint } from '../types';
import { fmtEur, fmtEur0 } from '../utils/calculations';

interface MonthlyTrendChartProps {
  trendPoints: MonthlyTrendPoint[];
  avgExpense: number;
  activeMonthKey: string;
  onSelectMonth: (monthKey: string) => void;
  monthsCount: 6 | 12;
  onChangeMonthsCount: (count: 6 | 12) => void;
}

export const MonthlyTrendChart: React.FC<MonthlyTrendChartProps> = ({
  trendPoints,
  avgExpense,
  activeMonthKey,
  onSelectMonth,
  monthsCount,
  onChangeMonthsCount,
}) => {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  // SVG Dimensions
  const width = 640;
  const height = 240;
  const pad = { top: 32, right: 16, bottom: 36, left: 16 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  // Maximum value for scaling
  const maxVal = Math.max(
    1,
    avgExpense,
    ...trendPoints.map((d) => Math.max(d.income, d.expense))
  );

  const n = trendPoints.length || 1;
  const slotW = innerW / n;
  const barW = Math.max(10, Math.min(22, slotW * 0.3));
  const barGap = 4;

  // Y coordinate calculation (from top)
  const getY = (val: number) => {
    return pad.top + innerH - (val / maxVal) * innerH;
  };

  const avgY = getY(avgExpense);

  return (
    <div className="bg-white dark:bg-[#171a2b] border border-[#e2e5f0] dark:border-[#282d44] rounded-2xl p-5 shadow-sm transition-all duration-200">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h3 className="text-base font-bold text-[#1c2030] dark:text-[#eef0f7] flex items-center gap-2">
            Andamento Mensile
            <span className="text-xs font-normal text-[#8a92a6] dark:text-[#7b839a]">
              (Entrate vs Uscite)
            </span>
          </h3>
          <p className="text-xs text-[#5b6478] dark:text-[#aab2c8] mt-0.5">
            Tocca un mese per esplorare le spese relative
          </p>
        </div>

        <div className="flex items-center gap-1.5 bg-[#eef0f7] dark:bg-[#1e2236] p-1 rounded-xl">
          <button
            type="button"
            onClick={() => onChangeMonthsCount(6)}
            className={`px-3 py-1 text-xs font-medium rounded-lg transition-all ${
              monthsCount === 6
                ? 'bg-white dark:bg-[#282d44] text-[#5566ff] dark:text-[#7c8dff] shadow-xs'
                : 'text-[#5b6478] dark:text-[#aab2c8] hover:text-[#1c2030] dark:hover:text-[#eef0f7]'
            }`}
          >
            6 Mesi
          </button>
          <button
            type="button"
            onClick={() => onChangeMonthsCount(12)}
            className={`px-3 py-1 text-xs font-medium rounded-lg transition-all ${
              monthsCount === 12
                ? 'bg-white dark:bg-[#282d44] text-[#5566ff] dark:text-[#7c8dff] shadow-xs'
                : 'text-[#5b6478] dark:text-[#aab2c8] hover:text-[#1c2030] dark:hover:text-[#eef0f7]'
            }`}
          >
            12 Mesi
          </button>
        </div>
      </div>

      {/* Interactive Chart Container */}
      <div className="relative w-full overflow-hidden">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full h-auto overflow-visible select-none"
          role="img"
          aria-label="Grafico a barre entrate e uscite mensili"
        >
          {/* Subtle grid lines */}
          <line
            x1={pad.left}
            y1={pad.top}
            x2={width - pad.right}
            y2={pad.top}
            stroke="currentColor"
            className="text-[#e2e5f0] dark:text-[#282d44]"
            strokeDasharray="4 4"
            strokeWidth="1"
          />
          <line
            x1={pad.left}
            y1={pad.top + innerH / 2}
            x2={width - pad.right}
            y2={pad.top + innerH / 2}
            stroke="currentColor"
            className="text-[#e2e5f0] dark:text-[#282d44]"
            strokeDasharray="4 4"
            strokeWidth="1"
          />
          <line
            x1={pad.left}
            y1={pad.top + innerH}
            x2={width - pad.right}
            y2={pad.top + innerH}
            stroke="currentColor"
            className="text-[#e2e5f0] dark:text-[#282d44]"
            strokeWidth="1.5"
          />

          {/* Average expense reference line */}
          {avgExpense > 0 && (
            <g className="transition-all duration-300">
              <line
                x1={pad.left}
                y1={avgY}
                x2={width - pad.right}
                y2={avgY}
                stroke="#e8546b"
                strokeWidth="1.5"
                strokeDasharray="6 4"
                opacity="0.65"
              />
              <text
                x={width - pad.right}
                y={avgY - 6}
                textAnchor="end"
                className="fill-[#e8546b] text-[10px] font-semibold"
              >
                Media uscite: {fmtEur0(avgExpense)}
              </text>
            </g>
          )}

          {/* Bars per month */}
          {trendPoints.map((pt, i) => {
            const centerX = pad.left + i * slotW + slotW / 2;
            const incH = (pt.income / maxVal) * innerH;
            const expH = (pt.expense / maxVal) * innerH;
            const incX = centerX - barW - barGap / 2;
            const expX = centerX + barGap / 2;
            const isSelected = pt.monthKey === activeMonthKey;
            const isHovered = hoveredIdx === i;

            return (
              <g
                key={pt.monthKey}
                className="cursor-pointer group"
                onClick={() => onSelectMonth(pt.monthKey)}
                onMouseEnter={() => setHoveredIdx(i)}
                onMouseLeave={() => setHoveredIdx(null)}
              >
                {/* Background column highlight on hover / selected */}
                <rect
                  x={pad.left + i * slotW}
                  y={pad.top - 8}
                  width={slotW}
                  height={innerH + 16}
                  rx="6"
                  className={`transition-colors duration-150 ${
                    isSelected
                      ? 'fill-[#5566ff]/10 dark:fill-[#7c8dff]/15'
                      : isHovered
                      ? 'fill-black/3 dark:fill-white/5'
                      : 'fill-transparent'
                  }`}
                />

                {/* Income Bar (Verde #12b886) */}
                <rect
                  x={incX}
                  y={pad.top + innerH - incH}
                  width={barW}
                  height={Math.max(incH, 2)}
                  rx={barW / 2}
                  fill="#12b886"
                  className={`transition-all duration-200 ${
                    isHovered ? 'filter brightness-110 drop-shadow-sm' : ''
                  }`}
                />

                {/* Expense Bar (Rosso #e8546b) */}
                <rect
                  x={expX}
                  y={pad.top + innerH - expH}
                  width={barW}
                  height={Math.max(expH, 2)}
                  rx={barW / 2}
                  fill="#e8546b"
                  className={`transition-all duration-200 ${
                    isHovered ? 'filter brightness-110 drop-shadow-sm' : ''
                  }`}
                />

                {/* Month Label below */}
                <text
                  x={centerX}
                  y={height - 12}
                  textAnchor="middle"
                  className={`text-[11px] font-medium transition-colors ${
                    isSelected
                      ? 'fill-[#5566ff] dark:fill-[#7c8dff] font-bold'
                      : 'fill-[#5b6478] dark:fill-[#aab2c8]'
                  }`}
                >
                  {pt.label}
                </text>

                {/* Top indicator dot for selected month */}
                {isSelected && (
                  <circle
                    cx={centerX}
                    cy={pad.top - 12}
                    r="3.5"
                    fill="#5566ff"
                    className="animate-pulse"
                  />
                )}
              </g>
            );
          })}
        </svg>

        {/* Floating Tooltip when hovering over a month */}
        {hoveredIdx !== null && trendPoints[hoveredIdx] && (
          <div
            className="absolute top-1 pointer-events-none z-20 bg-[#1c2030] text-white dark:bg-[#111422] dark:border dark:border-[#282d44] px-3 py-2 rounded-xl text-xs shadow-xl transition-all duration-150 transform -translate-x-1/2"
            style={{
              left: `${
                ((pad.left + hoveredIdx * slotW + slotW / 2) / width) * 100
              }%`,
            }}
          >
            <div className="font-semibold text-white/90 mb-1 border-b border-white/10 pb-1 flex justify-between items-center gap-4">
              <span>{trendPoints[hoveredIdx].label}</span>
              <span
                className={`font-mono text-[11px] ${
                  trendPoints[hoveredIdx].net >= 0
                    ? 'text-[#2dd4a7]'
                    : 'text-[#ff6b83]'
                }`}
              >
                {trendPoints[hoveredIdx].net >= 0 ? '+' : ''}
                {fmtEur(trendPoints[hoveredIdx].net)}
              </span>
            </div>
            <div className="space-y-0.5 text-[11px]">
              <div className="flex justify-between gap-3 text-emerald-400">
                <span>Entrate:</span>
                <span className="font-semibold">
                  {fmtEur(trendPoints[hoveredIdx].income)}
                </span>
              </div>
              <div className="flex justify-between gap-3 text-rose-400">
                <span>Uscite:</span>
                <span className="font-semibold">
                  {fmtEur(trendPoints[hoveredIdx].expense)}
                </span>
              </div>
              <div className="flex justify-between gap-3 text-slate-300 pt-0.5">
                <span>Movimenti:</span>
                <span>{trendPoints[hoveredIdx].txCount}</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Chart Legend */}
      <div className="flex items-center justify-between border-t border-[#e2e5f0] dark:border-[#282d44] pt-3 mt-2 text-xs text-[#5b6478] dark:text-[#aab2c8]">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-[#12b886]" />
            <span>Entrate</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-[#e8546b]" />
            <span>Uscite</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 border-b border-dashed border-[#e8546b]" />
            <span>Media uscite</span>
          </div>
        </div>

        <div className="text-[11px] text-[#8a92a6] dark:text-[#7b839a]">
          Mese attivo:{' '}
          <span className="font-semibold text-[#1c2030] dark:text-[#eef0f7]">
            {trendPoints.find((p) => p.monthKey === activeMonthKey)?.label || activeMonthKey}
          </span>
        </div>
      </div>
    </div>
  );
};
