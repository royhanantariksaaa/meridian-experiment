import fs from "fs";
import path from "path";
import { config } from "../config.js";
import { isBlacklisted } from "../token-blacklist.js";

const RAYDIUM_BASE = "https://api-v3.raydium.io";
const CACHE_DIR = path.join(process.cwd(), "logs", "market-cache");
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = Number(process.env.RAYDIUM_FETCH_TIMEOUT_MS || 8_000);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function cachePath(key) {
  ensureDir(CACHE_DIR);
  return path.join(CACHE_DIR, `${String(key).replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 160)}.json`);
}

function readCache(key, ttlMs) {
  try {
    const file = cachePath(key);
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > ttlMs) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeCache(key, payload) {
  try {
    fs.writeFileSync(cachePath(key), JSON.stringify(payload));
  } catch { /* best effort */ }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`Raydium fetch timeout after ${timeoutMs}ms: ${url}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function numeric(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getPath(obj, pathSpec) {
  return String(pathSpec).split(".").reduce((acc, key) => (acc == null ? null : acc[key]), obj);
}

function firstNumber(obj, paths, fallback = null) {
  for (const p of paths) {
    const value = numeric(getPath(obj, p));
    if (value != null) return value;
  }
  return fallback;
}

function firstString(obj, paths, fallback = null) {
  for (const p of paths) {
    const value = getPath(obj, p);
    if (value != null && String(value).trim() !== "") return String(value);
  }
  return fallback;
}

function extractPoolList(payload) {
  const candidates = [
    payload?.data?.data,
    payload?.data?.list,
    payload?.data?.rows,
    payload?.data,
    payload?.list,
    payload?.rows,
  ];
  return candidates.find(Array.isArray) || [];
}

function buildPoolInfoUrl({ poolType, sortField, sortType, page, pageSize }) {
  const params = new URLSearchParams({
    poolType,
    poolSortField: sortField,
    sortType,
    page: String(page),
    pageSize: String(pageSize),
  });
  return `${RAYDIUM_BASE}/pools/info/list?${params.toString()}`;
}

async function fetchPoolInfoPage({ poolType, sortField, sortType, page, pageSize, ttlMs }) {
  const url = buildPoolInfoUrl({ poolType, sortField, sortType, page, pageSize });
  const cacheKey = `raydium-pools-${poolType}-${sortField}-${sortType}-${page}-${pageSize}`;
  const cached = readCache(cacheKey, ttlMs);
  if (cached) return { payload: cached, cache_hit: true, url };
  const res = await fetchWithTimeout(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Raydium pool list ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 160)}` : ""}`);
  }
  const payload = await res.json();
  writeCache(cacheKey, payload);
  return { payload, cache_hit: false, url };
}

function normalizeRaydiumPool(raw) {
  const poolId = firstString(raw, ["id", "address", "poolId", "ammId"]);
  const mintA = raw?.mintA || raw?.baseMint || raw?.mint0 || {};
  const mintB = raw?.mintB || raw?.quoteMint || raw?.mint1 || {};
  const baseMint = typeof mintA === "string" ? mintA : firstString(mintA, ["address", "mint", "id"]);
  const quoteMint = typeof mintB === "string" ? mintB : firstString(mintB, ["address", "mint", "id"]);
  const baseSymbol = typeof mintA === "string" ? null : firstString(mintA, ["symbol", "name"], "?");
  const quoteSymbol = typeof mintB === "string" ? null : firstString(mintB, ["symbol", "name"], "?");
  const tvl = firstNumber(raw, ["tvl", "liquidity", "totalLiquidity", "liquidityUsd"]);
  const volume24h = firstNumber(raw, ["day.volume", "volume24h", "volume_24h", "volume"]);
  const fee24h = firstNumber(raw, ["day.volumeFee", "day.fee", "fee24h", "fee_24h", "fees24h"]);
  const feeTvlRatio = firstNumber(raw, ["feeTvlRatio24h", "fee_tvl_ratio_24h"], tvl && fee24h != null ? (fee24h / tvl) * 100 : null);

  return {
    venue: "raydium",
    pool: poolId,
    name: firstString(raw, ["name"], `${baseSymbol || "?"}-${quoteSymbol || "?"}`),
    source_timeframe: "24h",
    source_category: "raydium-rest",
    source_api: "raydium-pools-info-list",
    base: { symbol: baseSymbol, mint: baseMint, organic: null, warnings: 0 },
    quote: { symbol: quoteSymbol, mint: quoteMint },
    pool_type: firstString(raw, ["type", "poolType", "programType"], "raydium"),
    tvl: tvl != null ? Math.round(tvl) : null,
    active_tvl: tvl != null ? Math.round(tvl) : null,
    volume_window: volume24h != null ? Math.round(volume24h) : null,
    fee_window: fee24h != null ? Math.round(fee24h) : null,
    fee_active_tvl_ratio: feeTvlRatio != null ? Number(feeTvlRatio.toFixed(4)) : null,
    volatility: null,
    holders: null,
    mcap: null,
    organic_score: null,
    price: firstNumber(raw, ["price", "currentPrice"]),
    raw,
  };
}

function localRaydiumFilter(pool) {
  const s = config.screening;
  if (!pool.pool) return "missing pool id";
  if (isBlacklisted(pool.base?.mint)) return "local token blacklist";
  const tvl = numeric(pool.active_tvl ?? pool.tvl);
  if (tvl == null || tvl < s.minTvl) return `TVL ${tvl ?? "unknown"} < ${s.minTvl}`;
  if (s.maxTvl != null && tvl > s.maxTvl) return `TVL ${tvl} > ${s.maxTvl}`;
  const volume = numeric(pool.volume_window);
  if (volume == null || volume < s.minVolume) return `volume ${volume ?? "unknown"} < ${s.minVolume}`;
  const feeRatio = numeric(pool.fee_active_tvl_ratio);
  if (feeRatio == null || feeRatio < s.minFeeActiveTvlRatio) return `fee/TVL ${feeRatio ?? "unknown"} < ${s.minFeeActiveTvlRatio}`;
  return null;
}

function scoreRaydiumPool(pool) {
  const fee = numeric(pool.fee_active_tvl_ratio, 0);
  const volume = numeric(pool.volume_window, 0);
  const tvl = numeric(pool.active_tvl ?? pool.tvl, 0);
  const volumeTvl = tvl > 0 ? volume / tvl : 0;
  return fee * 1000 + volumeTvl * 250 + Math.log10(Math.max(tvl, 1));
}

export async function scanRaydiumCandidates({
  limit = 10,
  poolType = "all",
  sortField = "volume24h",
  sortType = "desc",
  page = 1,
  pageSize = DEFAULT_PAGE_SIZE,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
} = {}) {
  const { payload, cache_hit, url } = await fetchPoolInfoPage({ poolType, sortField, sortType, page, pageSize, ttlMs: cacheTtlMs });
  const rawPools = extractPoolList(payload);
  const normalized = rawPools.map(normalizeRaydiumPool);
  const filtered = [];
  const rejected = [];
  for (const pool of normalized) {
    const reason = localRaydiumFilter(pool);
    if (reason) rejected.push({ name: pool.name, pool: pool.pool, reason });
    else filtered.push(pool);
  }
  const candidates = filtered.sort((a, b) => scoreRaydiumPool(b) - scoreRaydiumPool(a)).slice(0, limit);
  return {
    source: "raydium",
    candidates,
    filtered_examples: rejected.slice(0, 8),
    scan_summary: [{
      source: "raydium",
      endpoint: url,
      raw_count: rawPools.length,
      filtered_count: filtered.length,
      returned_count: candidates.length,
      cache_hit,
      poolType,
      sortField,
      sortType,
    }],
  };
}
