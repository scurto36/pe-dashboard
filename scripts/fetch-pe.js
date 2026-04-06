// scripts/fetch-pe.js
// Runs in GitHub Actions — fetches TTM + Fwd PE for all tickers and appends to data/*.json

import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

const API_KEY = process.env.FMP_API_KEY;
const BASE = 'https://financialmodelingprep.com/stable';

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

async function getTTMPE(ticker) {
  const d = await apiFetch(`${BASE}/ratios-ttm?symbol=${ticker}&apikey=${API_KEY}`);
  if (!Array.isArray(d) || !d[0]) return null;
  const v = d[0].priceToEarningsRatioTTM;
  return (v && isFinite(v) && v > 0 && v < 500) ? +v.toFixed(2) : null;
}

async function getPrice(ticker) {
  const d = await apiFetch(`${BASE}/quote?symbol=${ticker}&apikey=${API_KEY}`);
  if (!Array.isArray(d) || !d[0]) return null;
  return d[0].price ?? null;
}

async function getFwdPE(ticker, price) {
  if (!price) return null;
  const d = await apiFetch(`${BASE}/analyst-estimates?symbol=${ticker}&period=annual&limit=3&apikey=${API_KEY}`);
  if (!Array.isArray(d) || !d[0]) return null;
  const now = new Date();
  const est = d.find(x => new Date(x.date) > now) || d[0];
  const eps = est.estimatedEpsAvg || est.estimatedEps || est.epsAvg || est.eps;
  if (!eps || eps <= 0) return null;
  const fpe = +(price / eps).toFixed(2);
  return (fpe > 0 && fpe < 500) ? fpe : null;
}

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

async function processTicker(ticker) {
  console.log(`  ${ticker}...`);
  const [ttmPE, price] = await Promise.all([getTTMPE(ticker), getPrice(ticker)]);
  const fwdPE = await getFwdPE(ticker, price);

  const result = { date: today(), ttmPE, fwdPE };
  console.log(`    TTM: ${ttmPE ?? 'N/A'}  Fwd: ${fwdPE ?? 'N/A'}`);

  const file = loadTickerFile(ticker);
  file.daily = file.daily.filter(x => x.date !== today());
  file.daily.push(result);
  file.daily.sort((a, b) => a.date.localeCompare(b.date));
  if (file.daily.length > 365) file.daily = file.daily.slice(-365);

  saveTickerFile(ticker, file);
  return result;
}

async function main() {
  if (!API_KEY) { console.error('FMP_API_KEY not set'); process.exit(1); }
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

  console.log(`\nFetching PE data for ${TICKERS.length} tickers — ${today()}\n`);
  let ok = 0, fail = 0;

  for (let i = 0; i < TICKERS.length; i++) {
    const t = TICKERS[i];
    try {
      const r = await processTicker(t);
      if (r.ttmPE) ok++; else fail++;
    } catch (e) {
      console.warn(`  ERROR ${t}: ${e.message}`);
      fail++;
    }
    if (i < TICKERS.length - 1) await sleep(300);
  }

  console.log(`\nDone. ${ok} succeeded, ${fail} missing/failed.`);
}

main();
