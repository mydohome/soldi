// Original hand-built SVG charts — no external libraries.

const fmtEur = (n) =>
  new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(n || 0);

/**
 * Donut chart for a category breakdown.
 * data: [{ name, color, total }]  (already sorted desc)
 */
export function donut(data, { size = 168, thickness = 26 } = {}) {
  const total = data.reduce((s, d) => s + d.total, 0);
  const r = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;

  if (total <= 0) {
    return `
      <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Nessun dato">
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--line)" stroke-width="${thickness}" />
        <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central"
              fill="var(--ink-faint)" font-size="12">nessuna spesa</text>
      </svg>`;
  }

  let offset = 0;
  const arcs = data
    .filter((d) => d.total > 0)
    .map((d) => {
      const frac = d.total / total;
      const dash = frac * circ;
      const seg = `
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none"
          stroke="${d.color}" stroke-width="${thickness}"
          stroke-dasharray="${dash} ${circ - dash}"
          stroke-dashoffset="${-offset}"
          transform="rotate(-90 ${cx} ${cy})"
          stroke-linecap="butt">
          <title>${escapeHtml(d.name)} — ${fmtEur(d.total)}</title>
        </circle>`;
      offset += dash;
      return seg;
    })
    .join('');

  return `
    <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Spese per categoria">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--bg-sunken)" stroke-width="${thickness}" />
      ${arcs}
      <text x="${cx}" y="${cy - 6}" text-anchor="middle" fill="var(--ink-faint)" font-size="10.5"
            letter-spacing="0.08em">USCITE</text>
      <text x="${cx}" y="${cy + 12}" text-anchor="middle" fill="var(--ink)" font-size="15" font-weight="700">
        ${fmtEur(total)}
      </text>
    </svg>`;
}

/**
 * Grouped income/expense bars over time.
 * series: [{ label, income, expense }]
 */
export function bars(series, { width = 640, height = 200 } = {}) {
  const pad = { top: 12, right: 8, bottom: 26, left: 8 };
  const iw = width - pad.left - pad.right;
  const ih = height - pad.top - pad.bottom;
  const max = Math.max(1, ...series.map((d) => Math.max(d.income, d.expense)));
  const n = series.length || 1;
  const slot = iw / n;
  const barW = Math.min(14, slot * 0.32);
  const gap = 3;

  const cols = series
    .map((d, i) => {
      const x = pad.left + i * slot + slot / 2;
      const ih1 = (d.income / max) * ih;
      const eh1 = (d.expense / max) * ih;
      const showLabel = n <= 12 || i % Math.ceil(n / 12) === 0;
      return `
        <g>
          <rect x="${x - barW - gap / 2}" y="${pad.top + ih - ih1}" width="${barW}" height="${Math.max(0, ih1)}"
                rx="3" fill="var(--income)"><title>${d.label}: entrate ${fmtEur(d.income)}</title></rect>
          <rect x="${x + gap / 2}" y="${pad.top + ih - eh1}" width="${barW}" height="${Math.max(0, eh1)}"
                rx="3" fill="var(--expense)"><title>${d.label}: uscite ${fmtEur(d.expense)}</title></rect>
          ${
            showLabel
              ? `<text x="${x}" y="${height - 8}" text-anchor="middle" fill="var(--ink-faint)" font-size="9.5">${escapeHtml(
                  d.label
                )}</text>`
              : ''
          }
        </g>`;
    })
    .join('');

  return `
    <svg class="bars" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet"
         role="img" aria-label="Andamento entrate e uscite">
      <line x1="${pad.left}" y1="${pad.top + ih}" x2="${width - pad.right}" y2="${pad.top + ih}"
            stroke="var(--line)" stroke-width="1" />
      ${cols}
    </svg>`;
}

/**
 * Budget bars: planned (outline) vs actual (filled) per month.
 * series: [{ label, planned, actual }]
 */
export function budgetBars(series, { width = 660, height = 210 } = {}) {
  const pad = { top: 12, right: 8, bottom: 26, left: 8 };
  const iw = width - pad.left - pad.right;
  const ih = height - pad.top - pad.bottom;
  const max = Math.max(1, ...series.map((d) => Math.max(d.planned, d.actual)));
  const n = series.length || 1;
  const slot = iw / n;
  const barW = Math.min(16, slot * 0.34);
  const gap = 3;

  const cols = series
    .map((d, i) => {
      const x = pad.left + i * slot + slot / 2;
      const ph = (d.planned / max) * ih;
      const ah = (d.actual / max) * ih;
      const over = d.actual > d.planned + 0.005;
      return `
        <g>
          <rect x="${x - barW - gap / 2}" y="${pad.top + ih - ph}" width="${barW}" height="${Math.max(0, ph)}"
                rx="3" fill="none" stroke="var(--brand)" stroke-width="1.5" opacity="0.8">
            <title>${escapeHtml(d.label)}: previsto ${fmtEur(d.planned)}</title></rect>
          <rect x="${x + gap / 2}" y="${pad.top + ih - ah}" width="${barW}" height="${Math.max(0, ah)}"
                rx="3" fill="${over ? 'var(--expense)' : 'var(--accent)'}">
            <title>${escapeHtml(d.label)}: speso ${fmtEur(d.actual)}</title></rect>
          <text x="${x}" y="${height - 8}" text-anchor="middle" fill="var(--ink-faint)" font-size="9.5">${escapeHtml(
            d.label
          )}</text>
        </g>`;
    })
    .join('');

  return `
    <svg class="bars" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet"
         role="img" aria-label="Previsto contro speso, per mese">
      <line x1="${pad.left}" y1="${pad.top + ih}" x2="${width - pad.right}" y2="${pad.top + ih}"
            stroke="var(--line)" stroke-width="1" />
      ${cols}
    </svg>`;
}

/** Tiny sparkline for stat cards. values: number[] */
export function spark(values, { width = 120, height = 42, color = 'var(--brand)' } = {}) {
  if (!values.length) return '';
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const step = width / Math.max(1, values.length - 1);
  const pts = values.map((v, i) => `${i * step},${height - ((v - min) / span) * (height - 4) - 2}`);
  return `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">
      <polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round" opacity="0.85" />
    </svg>`;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export { fmtEur };
