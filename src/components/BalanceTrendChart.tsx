import React, { useState } from 'react';
import { MonthlyTrendPoint } from '../types';
import { fmtEur } from '../utils/calculations';

interface BalanceTrendChartProps {
  trendPoints: MonthlyTrendPoint[];
  currentTotalBalance: number;
}

export const BalanceTrendChart: React.FC<BalanceTrendChartProps> = ({
  trendPoints,
  currentTotalBalance,
}) => {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  if (trendPoints.length === 0) return null;

  // Reconstruct cumulative balance progression backwards from current balance
  // Let last point have currentTotalBalance
  const cumulativeBalances: number[] = [];
  let running = currentTotalBalance;

  // reverse loop
  for (let i = trendPoints.length - 1; i >= 0; i--) {
    cumulativeBalances[i] = running;
    running = running - trendPoints[i].net;
  }

  const width = 640;
  const height = 180;
  const pad = { top: 24, right: 20, bottom: 28, left: 20 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  const minVal = Math.min(...cumulativeBalances);
  const maxVal = Math.max(...cumulativeBalances);
  const span = Math.max(1, maxVal - minVal);

  const getX = (idx: number) => pad.left + (idx / (trendPoints.length - 1 || 1)) * innerW;
  const getY = (val: number) => pad.top + innerH - ((val - minVal) / span) * innerH;

  // Build SVG path
  const pointsCoords = cumulativeBalances.map((val, idx) => ({
    x: getX(idx),
    y: getY(val),
    val,
    label: trendPoints[idx].label,
    net: trendPoints[idx].net,
  }));

  const linePath = pointsCoords.reduce((acc, pt, idx) => {
    return idx === 0 ? `M ${pt.x} ${pt.y}` : `${acc} L ${pt.x} ${pt.y}`;
  }, '');

  const areaPath = `${linePath} L ${pointsCoords[pointsCoords.length - 1].x} ${pad.top + innerH} L ${pointsCoords[0].x} ${pad.top + innerH} Z`;

  const totalGrowth = cumulativeBalances[cumulativeBalances.length - 1] - cumulativeBalances[0];

  return (
    <div className="bg-white dark:bg-[#171a2b] border border-[#e2e5f0] dark:border-[#282d44] rounded-2xl p-5 shadow-sm transition-all duration-200">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div>
          <h3 className="text-base font-bold text-[#1c2030] dark:text-[#eef0f7] flex items-center gap-2">
            Evoluzione Patrimonio
            <span
              className={`text-xs font-semibold px-2 py-0.5 rounded-md ${
                totalGrowth >= 0
                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400'
                  : 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400'
              }`}
            >
              {totalGrowth >= 0 ? `+${fmtEur(totalGrowth)}` : fmtEur(totalGrowth)} nel periodo
            </span>
          </h3>
          <p className="text-xs text-[#5b6478] dark:text-[#aab2c8] mt-0.5">
            Curva del saldo totale cumulativo mese per mese
          </p>
        </div>

        <div className="text-right">
          <span className="text-[11px] text-[#8a92a6] dark:text-[#7b839a] block">
            Saldo fine periodo
          </span>
          <span className="text-sm font-bold text-[#1c2030] dark:text-[#eef0f7]">
            {fmtEur(currentTotalBalance)}
          </span>
        </div>
      </div>

      <div className="relative w-full overflow-hidden">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full h-auto overflow-visible select-none"
        >
          <defs>
            <linearGradient id="balanceAreaGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#5566ff" stopOpacity="0.25" />
              <stop offset="100%" stopColor="#5566ff" stopOpacity="0.0" />
            </linearGradient>
          </defs>

          {/* Area fill */}
          <path d={areaPath} fill="url(#balanceAreaGrad)" />

          {/* Trend line */}
          <path
            d={linePath}
            fill="none"
            stroke="#5566ff"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Base bottom axis */}
          <line
            x1={pad.left}
            y1={pad.top + innerH}
            x2={width - pad.right}
            y2={pad.top + innerH}
            stroke="currentColor"
            className="text-[#e2e5f0] dark:text-[#282d44]"
            strokeWidth="1"
          />

          {/* Points */}
          {pointsCoords.map((pt, idx) => {
            const isHovered = hoveredIdx === idx;
            return (
              <g
                key={idx}
                className="cursor-pointer"
                onMouseEnter={() => setHoveredIdx(idx)}
                onMouseLeave={() => setHoveredIdx(null)}
              >
                {/* Hit area */}
                <circle cx={pt.x} cy={pt.y} r="14" fill="transparent" />

                {/* Point dot */}
                <circle
                  cx={pt.x}
                  cy={pt.y}
                  r={isHovered ? 6 : 4}
                  fill={isHovered ? '#5566ff' : '#ffffff'}
                  stroke="#5566ff"
                  strokeWidth={isHovered ? 3 : 2}
                  className="transition-all duration-150 shadow-sm"
                />

                {/* Month label */}
                <text
                  x={pt.x}
                  y={height - 8}
                  textAnchor="middle"
                  className={`text-[10.5px] ${
                    isHovered
                      ? 'fill-[#5566ff] font-bold'
                      : 'fill-[#5b6478] dark:fill-[#aab2c8]'
                  }`}
                >
                  {pt.label}
                </text>
              </g>
            );
          })}
        </svg>

        {/* Hover Tooltip */}
        {hoveredIdx !== null && pointsCoords[hoveredIdx] && (
          <div
            className="absolute top-0 pointer-events-none z-20 bg-[#1c2030] text-white dark:bg-[#111422] dark:border dark:border-[#282d44] px-3 py-2 rounded-xl text-xs shadow-xl transition-all duration-150 transform -translate-x-1/2"
            style={{
              left: `${(pointsCoords[hoveredIdx].x / width) * 100}%`,
            }}
          >
            <div className="font-semibold text-slate-300 text-[11px] mb-0.5">
              {pointsCoords[hoveredIdx].label}
            </div>
            <div className="text-base font-bold text-white">
              {fmtEur(pointsCoords[hoveredIdx].val)}
            </div>
            <div
              className={`text-[11px] font-medium mt-0.5 ${
                pointsCoords[hoveredIdx].net >= 0 ? 'text-[#2dd4a7]' : 'text-[#ff6b83]'
              }`}
            >
              Flusso mese: {pointsCoords[hoveredIdx].net >= 0 ? '+' : ''}
              {fmtEur(pointsCoords[hoveredIdx].net)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
