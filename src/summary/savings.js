'use strict';

/**
 * Piano di risparmio — algoritmo locale, deterministico, senza servizi esterni.
 *
 * Dai movimenti dei mesi completi passati stima entrate e uscite "necessarie"
 * previste, ne ricava il margine mensile e propone come ripartirlo tra
 * fondo sicurezza e fondo risparmio. La modalità è "solo percentuali": non
 * conosce i saldi accumulati, quindi l'obiettivo del fondo sicurezza è
 * espresso in mensilità di spesa e il tempo per riempirlo è calcolato da zero.
 */

const MIN_MONTHS = 3;

const round2 = (n) => Math.round(n * 100) / 100;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : 0);

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Mean after dropping the single lowest and highest value (needs n >= 4). */
function trimmedMean(xs) {
  if (xs.length < 4) return mean(xs);
  const s = [...xs].sort((a, b) => a - b).slice(1, -1);
  return mean(s);
}

function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1));
}

/** Least-squares slope of y against its own index 0..n-1. */
function slope(ys) {
  const n = ys.length;
  if (n < 2) return 0;
  const xm = (n - 1) / 2;
  const ym = mean(ys);
  let num = 0;
  let den = 0;
  ys.forEach((y, i) => {
    num += (i - xm) * (y - ym);
    den += (i - xm) ** 2;
  });
  return den ? num / den : 0;
}

const coeffVar = (xs) => {
  const m = mean(xs);
  return m ? stdev(xs) / m : 1;
};

/**
 * @param {object} opts
 * @param {Array<{month:string, income:number, expense:number}>} opts.months
 *        full calendar months, oldest first, current partial month EXCLUDED (euro)
 * @param {number} opts.committedMonthly  monthly-equivalent of active recurring
 *        expense rules (euro)
 * @param {{emergencyMonths:number, emergencySplit:number}} opts.settings
 */
function computeSavingsPlan({ months, committedMonthly = 0, settings = {} }) {
  const monthsAvailable = months.length;
  const cfg = {
    emergencyMonths: clamp(Math.round(settings.emergencyMonths ?? 3), 1, 24),
    emergencySplit: clamp(Math.round(settings.emergencySplit ?? 70), 0, 100),
  };

  if (monthsAvailable < MIN_MONTHS) {
    return { ready: false, monthsAvailable, monthsNeeded: MIN_MONTHS, settings: cfg };
  }

  const recent = months.slice(-12);
  const incomes = recent.map((m) => m.income);
  const expenses = recent.map((m) => m.expense);

  const predIncome = trimmedMean(incomes);
  const predExpense = trimmedMean(expenses);
  const committed = clamp(round2(committedMonthly), 0, predExpense);
  const variable = round2(Math.max(0, predExpense - committed));

  const trendPct =
    predIncome > 0 ? round2(((slope(incomes) * 12) / predIncome) * 100) : 0;

  // Keep a cushion against expense volatility: half the monthly std deviation.
  const buffer = round2(0.5 * stdev(expenses));
  const margin = round2(predIncome - predExpense);
  const allocatable = round2(Math.max(0, margin - buffer));

  const totalRate = predIncome > 0 ? clamp(allocatable / predIncome, 0, 0.6) : 0;
  const emergencyRate = totalRate * (cfg.emergencySplit / 100);
  const savingsRate = totalRate - emergencyRate;

  const emergencyEuro = round2(predIncome * emergencyRate);
  const savingsEuro = round2(predIncome * savingsRate);

  const emergencyTarget = round2(predExpense * cfg.emergencyMonths);
  const monthsToFillFromZero =
    emergencyEuro > 0 ? Math.ceil(emergencyTarget / emergencyEuro) : null;

  const historicalRates = recent
    .filter((m) => m.income > 0)
    .map((m) => (m.income - m.expense) / m.income);
  const historicalSavingsRate = historicalRates.length
    ? round2(median(historicalRates) * 100)
    : null;

  const instability = Math.max(coeffVar(incomes), coeffVar(expenses));
  let reliability = 'bassa';
  if (monthsAvailable >= 6 && instability < 0.35) reliability = 'media';
  if (monthsAvailable >= 12 && instability < 0.25) reliability = 'alta';

  return {
    ready: true,
    monthsAvailable,
    settings: cfg,
    income: { predicted: round2(predIncome), trendPct },
    expense: { predicted: round2(predExpense), committed, variable },
    margin,
    buffer,
    allocatable,
    rates: {
      total: round2(totalRate * 100),
      emergency: round2(emergencyRate * 100),
      savings: round2(savingsRate * 100),
    },
    monthly: { emergency: emergencyEuro, savings: savingsEuro },
    emergencyFund: {
      targetMonths: cfg.emergencyMonths,
      targetAmount: emergencyTarget,
      monthsToFillFromZero,
    },
    historicalSavingsRate,
    reliability,
  };
}

module.exports = { computeSavingsPlan, trimmedMean, median, MIN_MONTHS };
