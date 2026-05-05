// scripts/fetch-pe.js
// Runs in GitHub Actions — fetches TTM PE (FMP) + enriched fundamentals (Finnhub) daily
// Also calculates true rolling PE history from quarterly EPS + daily prices
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

const FMP_KEY = process.env.FMP_API_KEY;
const FH_KEY  = process.env.FINNHUB_API_KEY;
const FMP_BASE = 'https://financialmodelingprep.com/stable';
const FH_BASE  = 'https://finnhub.io/api/v1';

const TICKERS = [
  'MSFT','NVDA','ADBE','CRM','AAPL','AMZN','TSM','ASML','GOOGL','WIX','DELL','PLAB','IFX','HPQ','HPE',
  'NEE','CEG','VST','SLB','NXE','TPL',
  'JPM','BCS',
  'COST','WMT','TGT','VFC','UAL',
  'VKTX','IVVD',
  'SPY','SCZ'
];

const DATA_DIR = './data';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = () => new Date().toISOString().split('T')[0];

const twoYearsAgo = () => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 2);
  return d.toISOString().split('T')[0];
};

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

async function getTTMPE(ticker) {
  const d = await apiFetch(`${FMP_BASE}/ratios-ttm?symbol=${ticker}&apikey=${FMP_KEY}`);
  if (!Array.isArray(d) || !d[0]) return null;
  const v = d[0].priceToEarningsRatioTTM;
  return (v && isFinite(v) && v > 0 && v < 500) ? +v.toFixed(2) : null;
}

async function getQuarterlyEPS(ticker) {
  const d = await apiFetch(`${FMP_BASE}/income-statement?symbol=${ticker}&period=quarter&limit=10&apikey=${FMP_KEY}`);
  if (!Array.isArray(d) || !d.length) return [];
  return d.map(q => ({
    date: q.date,
    eps: q.epsDiluted ?? q.eps ?? null,
  })).filter(q => q.eps !== null && isFinite(q.eps));
}

async function getDailyPrices(ticker) {
  const from = twoYearsAgo();
  const d = await apiFetch(`${FMP_BASE}/historical-price-eod/light?symbol=${ticker}&from=${from}&apikey=${FMP_KEY}`);
  if (!Array.isArray(d) || !d.length) return [];
  return d.map(p => ({ date: p.date, price: p.price }))
    .filter(p => p.price && isFinite(p.price) && p.price > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function calcRollingPE(quarters, prices) {
  if (!quarters.length || !prices.length) return [];
  const rollingPEs = [];
  for (const p of prices) {
    const trailing = quarters.filter(q => q.date <= p.date).slice(0, 4);
    if (trailing.length < 4) continue;
    const ttmEPS = trailing.reduce((a, q) => a + q.eps, 0);
    if (ttmEPS <= 0) continue;
    const pe = +(p.price / ttmEPS).toFixed(2);
    if (pe >= 3 && pe <= 200) {
      rollingPEs.push({ date: p.date, pe });
    }
  }
  return rollingPEs;
}

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
    fwdPE:               safe(m.forwardPE,            0, 500),
    fhTTMPE:             safe(m.peTTM,                0, 500),
    pegTTM:              safe(m.pegTTM,             -50,  50),
    evEbitdaTTM:         safe(m.evEbitdaTTM,          0, 1000),
    epsGrowthTTMYoy:     safe(m.epsGrowthTTMYoy,   -500, 2000),
    epsGrowth3Y:         safe(m.epsGrowth3Y,        -500, 2000),
    revenueGrowthTTM:    safe(m.revenueGrowthTTMYoy,-100, 2000),
    grossMarginTTM:      safe(m.grossMarginTTM,     -100,  100),
    netProfitMarginTTM:  safe(m.netProfitMarginTTM, -100,  100),
    roeTTM:              safe(m.roeTTM,             -500, 1000),
    beta:                safe(m.beta,                 -5,   10),
    week52High:          safe(m['52WeekHigh'],         0, 1e6),
    week52Low:           safe(m['52WeekLow'],          0, 1e6),
  };
}

function loadTickerFile(ticker) {
  const fp = path.join(DATA_DIR, `${ticker}.json`);
  if (!fs.existsSync(fp)) return { ticker, daily: [], rollingPE: [] };
  try {
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (!data.rollingPE) data.rollingPE = [];
    return data;
  } catch { return { ticker, daily: [], rollingPE: [] }; }
}

function saveTickerFile(ticker, data) {
  const fp = path.join(DATA_DIR, `${ticker}.json`);
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
}

async function processTicker(ticker) {
  console.log(`  ${ticker}...`);
  const [ttmPE, fhData, quarters, prices] = await Promise.all([
    getTTMPE(ticker),
    getFinnhubData(ticker),
    getQuarterlyEPS(ticker),
    getDailyPrices(ticker),
  ]);

  const fwdPE              = fhData?.fwdPE              ?? null;
  const fhTTMPE            = fhData?.fhTTMPE            ?? null;
  const pegTTM             = fhData?.pegTTM             ?? null;
  const evEbitdaTTM        = fhData?.evEbitdaTTM        ?? null;
  const epsGrowthTTMYoy    = fhData?.epsGrowthTTMYoy    ?? null;
  const epsGrowth3Y        = fhData?.epsGrowth3Y        ?? null;
  const revenueGrowthTTM   = fhData?.revenueGrowthTTM   ?? null;
  const grossMarginTTM     = fhData?.grossMarginTTM     ?? null;
  const netProfitMarginTTM = fhData?.netProfitMarginTTM ?? null;
  const roeTTM             = fhData?.roeTTM             ?? null;
  const beta               = fhData?.beta               ?? null;
  const week52High         = fhData?.week52High         ?? null;
  const week52Low          = fhData?.week52Low          ?? null;

  let peCrossCheck = null;
  if (ttmPE && fhTTMPE && ttmPE > 0 && fhTTMPE > 0) {
    const divergence = Math.abs(ttmPE - fhTTMPE) / ttmPE;
    peCrossCheck = {
      fhTTMPE,
      divergence: +divergence.toFixed(3),
      flagged: divergence > 0.15,
    };
  }

  const rollingPE = calcRollingPE(quarters, prices);
  const sorted = [...rollingPE].sort((a,b) => b.date.localeCompare(a.date));
  const avg1Y = sorted.slice(0,252).reduce((a,p)=>a+p.pe,0) / Math.min(sorted.length,252);
  const avg2Y = sorted.reduce((a,p)=>a+p.pe,0) / (sorted.length||1);

  const entry = {
    date: today(), ttmPE, fwdPE, pegTTM, evEbitdaTTM,
    epsGrowthTTMYoy, epsGrowth3Y, revenueGrowthTTM,
    grossMarginTTM, netProfitMarginTTM, roeTTM,
    beta, week52High, week52Low, peCrossCheck,
  };

  console.log(`    TTM: ${ttmPE??'N/A'}  Fwd: ${fwdPE??'N/A'}  Rolling PE days: ${rollingPE.length}  1Y avg: ${avg1Y.toFixed(1)}  2Y avg: ${avg2Y.toFixed(1)}`);
  if (peCrossCheck?.flagged) console.warn(`    ⚠ PE cross-check: FMP=${ttmPE} FH=${fhTTMPE}`);

  const file = loadTickerFile(ticker);
  file.daily = file.daily.filter(x => x.date !== today());
  file.daily.push(entry);
  file.daily.sort((a,b) => a.date.localeCompare(b.date));
  if (file.daily.length > 365) file.daily = file.daily.slice(-365);
  file.rollingPE = rollingPE;
  saveTickerFile(ticker, file);
  return entry;
}

async function main() {
  if (!FMP_KEY) { console.error('FMP_API_KEY not set'); process.exit(1); }
  if (!FH_KEY)  { console.error('FINNHUB_API_KEY not set'); process.exit(1); }
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  console.log(`\nFetching PE + fundamentals + rolling history for ${TICKERS.length} tickers — ${today()}\n`);
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
    if (i < TICKERS.length - 1) await sleep(600);
  }
  console.log(`\nDone. ${ok} succeeded, ${fail} missing/failed, ${flagged} PE cross-check flags.`);
}

main();
