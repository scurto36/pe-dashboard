// scripts/fetch-pe.js
// Runs in GitHub Actions — fetches TTM PE (FMP) + enriched fundamentals (Finnhub) daily
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

const FMP_KEY = process.env.FMP_API_KEY;
const FH_KEY  = process.env.FINNHUB_API_KEY;
const FMP_BASE = 'https://financialmodelingprep.com/stable';
const FH_BASE  = 'https://finnhub.io/api/v1';

const TICKERS = [
  'MSFT','NVDA','ADBE','CRM','AAPL','AMZN','TSM','ASML','GOOGL','WIX','DELL','PLAB','IFX',
  'NEE','CEG','VST','SLB','NXE',
  'JPM','BCS',
  'COST','WMT','TGT','VFC','UAL',
  'VKTX','IVVD',
  'SPY','SCZ'
];

const DATA_DIR = './data';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = () => new Date().toISOString().split('T')[0];

async function apiFetch(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) { console.warn(`  HTTP ${r.status}: ${url}`); return null; }
    return await r.json();
  } catch (e) {
    console.warn(`  Fetch error: ${e.message}`);
    return null;
  }
}

// ── FMP: TTM PE ────────────────────────────────────────────
async function getTTMPE(ticker) {
  const d = await apiFetch(`${FMP_BASE}/ratios-ttm?symbol=${ticker}&apikey=${FMP_KEY}`);
  if (!Array.isArray(d) || !d[0]) return null;
  const v = d[0].priceToEarningsRatioTTM;
  return (v && isFinite(v) && v > 0 && v < 500) ? +v.toFixed(2) : null;
}

// ── Finnhub: all enrichment in one call ───────────────────
async function getFinnhubData(ticker) {
  const d = await apiFetch(`${FH_BASE}/stock/metric?symbol=${ticker}&metric=all&token=${FH_KEY}`);
  if (!d || !d.metric) return null;
  const m = d.metric;

  const safe = (v, min = -9999, max = 9999) => {
    if (v === null || v === undefined || !isFinite(v)) return null;
    if (v < min || v > max) return null;
    return +v;
  };

  return {
    // Core valuation
    fwdPE:        safe(m.forwardPE,       0, 500),
    fhTTMPE:      safe(m.peTTM,           0, 500),   // for cross-check vs FMP
    pegTTM:       safe(m.pegTTM,          -50, 50),
    evEbitdaTTM:  safe(m.evEbitdaTTM,     0, 1000),

    // Growth
    epsGrowthTTMYoy:  safe(m.epsGrowthTTMYoy,       -500, 2000),
    epsGrowth3Y:      safe(m.epsGrowth3Y,            -500, 2000),
    revenueGrowthTTM: safe(m.revenueGrowthTTMYoy,   -100, 2000),

    // Quality / margins
    grossMarginTTM:      safe(m.grossMarginTTM,      -100, 100),
    netProfitMarginTTM:  safe(m.netProfitMarginTTM,  -100, 100),
    roeTTM:              safe(m.roeTTM,              -500, 1000),

    // Risk
    beta: safe(m.beta, -5, 10),

    // 52-week range (for analysis text only)
    week52High: safe(m['52WeekHigh'], 0, 1000000),
    week52Low:  safe(m['52WeekLow'],  0, 1000000),
  };
}

// ── File helpers ───────────────────────────────────────────
function loadTickerFile(ticker) {
  const fp = path.join(DATA_DIR, `${ticker}.json`);
  if (!fs.existsSync(fp)) return { ticker, daily: [] };
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch { return { ticker, daily: [] }; }
}

function saveTickerFile(ticker, data) {
  const fp = path.join(DATA_DIR, `${ticker}.json`);
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
}

// ── Main ticker processor ──────────────────────────────────
async function processTicker(ticker) {
  console.log(`  ${ticker}...`);

  const [ttmPE, fhData] = await Promise.all([
    getTTMPE(ticker),
    getFinnhubData(ticker),
  ]);

  const fwdPE       = fhData?.fwdPE       ?? null;
  const fhTTMPE     = fhData?.fhTTMPE     ?? null;
  const pegTTM      = fhData?.pegTTM      ?? null;
  const evEbitdaTTM = fhData?.evEbitdaTTM ?? null;
  const epsGrowthTTMYoy  = fhData?.epsGrowthTTMYoy  ?? null;
  const epsGrowth3Y      = fhData?.epsGrowth3Y      ?? null;
  const revenueGrowthTTM = fhData?.revenueGrowthTTM ?? null;
  const grossMarginTTM   = fhData?.grossMarginTTM   ?? null;
  const netProfitMarginTTM = fhData?.netProfitMarginTTM ?? null;
  const roeTTM           = fhData?.roeTTM           ?? null;
  const beta             = fhData?.beta             ?? null;
  const week52High       = fhData?.week52High       ?? null;
  const week52Low        = fhData?.week52Low        ?? null;

  // Cross-check: flag if FMP and Finnhub TTM PE diverge > 15%
  let peCrossCheck = null;
  if (ttmPE && fhTTMPE && ttmPE > 0 && fhTTMPE > 0) {
    const divergence = Math.abs(ttmPE - fhTTMPE) / ttmPE;
    peCrossCheck = {
      fhTTMPE,
      divergence: +divergence.toFixed(3),
      flagged: divergence > 0.15,
    };
  }

  const entry = {
    date: today(),
    ttmPE,
    fwdPE,
    pegTTM,
    evEbitdaTTM,
    epsGrowthTTMYoy,
    epsGrowth3Y,
    revenueGrowthTTM,
    grossMarginTTM,
    netProfitMarginTTM,
    roeTTM,
    beta,
    week52High,
    week52Low,
    peCrossCheck,
  };

  console.log(`    TTM: ${ttmPE ?? 'N/A'}  Fwd: ${fwdPE ?? 'N/A'}  PEG: ${pegTTM ?? 'N/A'}  Beta: ${beta ?? 'N/A'}  EPS g: ${epsGrowthTTMYoy ?? 'N/A'}%`);
  if (peCrossCheck?.flagged) {
    console.warn(`    ⚠ PE cross-check: FMP=${ttmPE} FH=${fhTTMPE} divergence=${(peCrossCheck.divergence*100).toFixed(1)}%`);
  }

  const file = loadTickerFile(ticker);
  file.daily = file.daily.filter(x => x.date !== today());
  file.daily.push(entry);
  file.daily.sort((a, b) => a.date.localeCompare(b.date));
  if (file.daily.length > 365) file.daily = file.daily.slice(-365);
  saveTickerFile(ticker, file);

  return entry;
}

// ── Main ───────────────────────────────────────────────────
async function main() {
  if (!FMP_KEY) { console.error('FMP_API_KEY not set'); process.exit(1); }
  if (!FH_KEY)  { console.error('FINNHUB_API_KEY not set'); process.exit(1); }
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

  console.log(`\nFetching PE + fundamentals for ${TICKERS.length} tickers — ${today()}\n`);
  let ok = 0, fail = 0, flagged = 0;

  for (let i = 0; i < TICKERS.length; i++) {
    const t = TICKERS[i];
    try {
      const r = await processTicker(t);
      if (r.ttmPE) ok++; else fail++;
      if (r.peCrossCheck?.flagged) flagged++;
    } catch (e) {
      console.warn(`  ERROR ${t}: ${e.message}`);
      fail++;
    }
    // Slightly longer sleep — two APIs in parallel, be respectful
    if (i < TICKERS.length - 1) await sleep(400);
  }

  console.log(`\nDone. ${ok} succeeded, ${fail} missing/failed, ${flagged} PE cross-check flags.`);
}

main();
