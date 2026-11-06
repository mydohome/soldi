import React, { useState } from 'react';
import { CategoryBreakdownItem } from '../types';
import { fmtEur } from '../utils/calculations';

interface CategoryDonutChartProps {
  categoriesData: CategoryBreakdownItem[];
  personalExpense: number;
  homeExpense: number;
  onSelectCategory?: (categoryId: string) => void;
  selectedCategoryId?: string | null;
}

export const CategoryDonutChart: React.FC<CategoryDonutChartProps> = ({
  categoriesData,
  personalExpense,
  homeExpense,
  onSelectCategory,
  selectedCategoryId,
}) => {
  const [hoveredCatId, setHoveredCatId] = useState<string | null>(null);

  const totalExpense = categoriesData.reduce((s, c) => s + c.total, 0);

  // SVG parameters
  const size = 190;
  const thickness = 26;
  const r = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;

  // Compute donut slices
  let cumulativeOffset = 0;
  const slices = categoriesData
    .filter((c) => c.total > 0)
    .map((c) => {
      const frac = totalExpense > 0 ? c.total / totalExpense : 0;
      const dash = frac * circ;
      const strokeDashoffset = -cumulativeOffset;
      cumulativeOffset += dash;
      return {
        ...c,
        dash,
        strokeDashoffset,
      };
    });

  const activeCategory = hoveredCatId
    ? categoriesData.find((c) => c.categoryId === hoveredCatId)
    : selectedCategoryId
    ? categoriesData.find((c) => c.categoryId === selectedCategoryId)
    : null;

  // Personale vs Casa calculation
  const totalScopeExp = personalExpense + homeExpense;
  const personalPct = totalScopeExp > 0 ? Math.round((personalExpense / totalScopeExp) * 100) : 50;
  const homePct = 100 - personalPct;

  return (
    <div className="bg-white dark:bg-[#171a2b] border border-[#e2e5f0] dark:border-[#282d44] rounded-2xl p-5 shadow-sm transition-all duration-200">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-base font-bold text-[#1c2030] dark:text-[#eef0f7]">
            Spese per Categoria
          </h3>
          <p className="text-xs text-[#5b6478] dark:text-[#aab2c8] mt-0.5">
            Ripartizione e confronto ▲▼ vs media 3 mesi
          </p>
        </div>
        {selectedCategoryId && (
          <button
            type="button"
            onClick={() => onSelectCategory && onSelectCategory('')}
            className="text-xs text-[#5566ff] hover:underline"
          >
            Azzera filtro
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-center">
        {/* Interactive SVG Donut */}
        <div className="md:col-span-5 flex justify-center items-center">
          <div className="relative w-[190px] h-[190px] shrink-0 mx-auto flex items-center justify-center">
            <svg
              viewBox={`0 0 ${size} ${size}`}
              width={size}
              height={size}
              className="select-none transform -rotate-90 block"
              role="img"
              aria-label="Grafico a ciambella spese per categoria"
            >
              {/* Background ring */}
              <circle
                cx={cx}
                cy={cy}
                r={r}
                fill="none"
                stroke="currentColor"
                className="text-[#eef0f7] dark:text-[#1e2236]"
                strokeWidth={thickness}
              />

              {totalExpense === 0 ? (
                <text
                  x={cx}
                  y={cy}
                  textAnchor="middle"
                  dominantBaseline="central"
                  className="fill-[#8a92a6] dark:fill-[#7b839a] text-xs transform rotate-90"
                  style={{ transformOrigin: `${cx}px ${cy}px` }}
                >
                  Nessuna spesa
                </text>
              ) : (
                slices.map((slice) => {
                  const isHovered = hoveredCatId === slice.categoryId;
                  const isSelected = selectedCategoryId === slice.categoryId;
                  const effectiveThickness = isHovered || isSelected ? thickness + 4 : thickness;

                  return (
                    <circle
                      key={slice.categoryId}
                      cx={cx}
                      cy={cy}
                      r={r}
                      fill="none"
                      stroke={slice.color}
                      strokeWidth={effectiveThickness}
                      strokeDasharray={`${slice.dash} ${circ - slice.dash}`}
                      strokeDashoffset={slice.strokeDashoffset}
                      className="cursor-pointer transition-all duration-200 hover:opacity-90"
                      onMouseEnter={() => setHoveredCatId(slice.categoryId)}
                      onMouseLeave={() => setHoveredCatId(null)}
                      onClick={() => onSelectCategory && onSelectCategory(slice.categoryId)}
                    />
                  );
                })
              )}
            </svg>

            {/* Central Information Overlay perfectly centered */}
            {totalExpense > 0 && (
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none text-center px-2 select-none">
                <span className="text-[10px] uppercase tracking-wider font-semibold text-[#8a92a6] dark:text-[#7b839a] truncate max-w-[125px]">
                  {activeCategory ? activeCategory.name : 'USCITE MESE'}
                </span>
                <span className="text-sm sm:text-base font-bold text-[#1c2030] dark:text-[#eef0f7] leading-tight mt-0.5 truncate max-w-[130px]">
                  {activeCategory ? fmtEur(activeCategory.total) : fmtEur(totalExpense)}
                </span>
                <span className="text-[10.5px] text-[#5b6478] dark:text-[#aab2c8] mt-0.5">
                  {activeCategory
                    ? `${activeCategory.sharePercent}% del totale`
                    : `${categoriesData.filter((c) => c.total > 0).length} categorie`}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Categories Legend with Share & 3-month Delta */}
        <div className="md:col-span-7 space-y-1.5 max-h-[220px] overflow-y-auto pr-1">
          {categoriesData.length === 0 ? (
            <div className="text-xs text-[#8a92a6] dark:text-[#7b839a] py-6 text-center">
              Nessuna spesa registrata in questo periodo.
            </div>
          ) : (
            categoriesData.map((cat) => {
              const isHovered = hoveredCatId === cat.categoryId;
              const isSelected = selectedCategoryId === cat.categoryId;

              return (
                <div
                  key={cat.categoryId}
                  onClick={() => onSelectCategory && onSelectCategory(cat.categoryId)}
                  onMouseEnter={() => setHoveredCatId(cat.categoryId)}
                  onMouseLeave={() => setHoveredCatId(null)}
                  className={`flex items-center justify-between p-1.5 px-2.5 rounded-xl cursor-pointer transition-all text-xs ${
                    isSelected
                      ? 'bg-[#5566ff]/10 dark:bg-[#7c8dff]/15 font-semibold'
                      : isHovered
                      ? 'bg-[#f5f6fb] dark:bg-[#1e2236]'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: cat.color }}
                    />
                    <span className="truncate text-[#1c2030] dark:text-[#eef0f7]">
                      {cat.name}
                    </span>
                    {cat.deltaPercent !== null && (
                      <span
                        className={`text-[10px] font-medium shrink-0 ${
                          cat.deltaPercent > 0
                            ? 'text-[#e8546b]'
                            : cat.deltaPercent < 0
                            ? 'text-[#12b886]'
                            : 'text-[#8a92a6]'
                        }`}
                        title={`Media 3 mesi: ${fmtEur(cat.avg3Months)}`}
                      >
                        {cat.deltaPercent > 0 ? `▲ +${cat.deltaPercent}%` : `▼ ${cat.deltaPercent}%`}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[10px] text-[#8a92a6] dark:text-[#7b839a] font-mono">
                      {cat.sharePercent}%
                    </span>
                    <span className="font-semibold text-[#1c2030] dark:text-[#eef0f7]">
                      {fmtEur(cat.total)}
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Scope breakdown bar (Personale vs Casa) */}
      <div className="mt-5 pt-4 border-t border-[#e2e5f0] dark:border-[#282d44]">
        <div className="flex justify-between items-center text-xs text-[#5b6478] dark:text-[#aab2c8] mb-1.5">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-[#5566ff]" />
            <span>Personale: <strong className="text-[#1c2030] dark:text-[#eef0f7]">{fmtEur(personalExpense)}</strong> ({personalPct}%)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-[#f4a259]" />
            <span>Casa: <strong className="text-[#1c2030] dark:text-[#eef0f7]">{fmtEur(homeExpense)}</strong> ({homePct}%)</span>
          </div>
        </div>

        <div className="w-full h-2.5 bg-[#eef0f7] dark:bg-[#1e2236] rounded-full overflow-hidden flex">
          <div
            className="h-full bg-[#5566ff] transition-all duration-500"
            style={{ width: `${personalPct}%` }}
            title={`Personale: ${personalPct}%`}
          />
          <div
            className="h-full bg-[#f4a259] transition-all duration-500"
            style={{ width: `${homePct}%` }}
            title={`Casa: ${homePct}%`}
          />
        </div>
      </div>
    </div>
  );
};
