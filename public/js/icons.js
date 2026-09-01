// Minimal inline icon set (stroke-based, 24x24).
const wrap = (p) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;

export const icons = {
  dashboard: wrap('<rect x="3" y="3" width="8" height="10" rx="1.5"/><rect x="3" y="17" width="8" height="4" rx="1.5"/><rect x="13" y="3" width="8" height="4" rx="1.5"/><rect x="13" y="11" width="8" height="10" rx="1.5"/>'),
  list: wrap('<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3.5" cy="6" r="1.4"/><circle cx="3.5" cy="12" r="1.4"/><circle cx="3.5" cy="18" r="1.4"/>'),
  tag: wrap('<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V4a1 1 0 0 1 1-1h9l7.6 7.6a2 2 0 0 1 0 2.8Z"/><circle cx="8" cy="8" r="1.6"/>'),
  archive: wrap('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><line x1="10" y1="12" x2="14" y2="12"/>'),
  logout: wrap('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>'),
  plus: wrap('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  chevronL: wrap('<polyline points="15 18 9 12 15 6"/>'),
  chevronR: wrap('<polyline points="9 18 15 12 9 6"/>'),
  edit: wrap('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  trash: wrap('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
  download: wrap('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
  wallet: wrap('<path d="M20 7H5a2 2 0 0 1 0-4h13v4Z"/><path d="M4 7v11a2 2 0 0 0 2 2h13a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1"/><circle cx="16" cy="13" r="1.3"/>'),
  bank: wrap('<path d="M3 10 12 4l9 6"/><path d="M5 10v9M19 10v9M9 10v9M15 10v9"/><line x1="3" y1="21" x2="21" y2="21"/>'),
  home: wrap('<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/>'),
  person: wrap('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-7 8-7s8 3 8 7"/>'),
  repeat: wrap('<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'),
  play: wrap('<polygon points="6 4 20 12 6 20 6 4"/>'),
  target: wrap('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4"/>'),
};

export const logoMark = `
<svg viewBox="0 0 40 40" aria-hidden="true">
  <defs>
    <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6c8cff"/><stop offset="1" stop-color="#12b886"/>
    </linearGradient>
  </defs>
  <rect width="40" height="40" rx="11" fill="url(#lg)"/>
  <path d="M8 26c4 0 4-6 8-6s4 8 8 8 4-12 10-12" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/>
  <circle cx="28" cy="14" r="3.4" fill="#fff"/>
</svg>`;
