const express = require('express');

const router = express.Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SUPPORTED_PAIRS = new Set(['USD/TRY', 'EUR/TRY', 'GBP/TRY', 'XAU/TRY']);
const GRAMS_PER_TROY_OUNCE = 31.1034768;
const MAX_HISTORY_YEARS = 10;
const HISTORY_CHUNK_DAYS = 365;
const MAX_CACHE_ENTRIES = 120;

const referenceCache = new Map();
const bankCache = new Map();

const CANLIDOVIZ_API = 'https://a.canlidoviz.com/items/history';
const CANLIDOVIZ_HEADERS = {
  Accept: '*/*',
  Origin: 'https://canlidoviz.com',
  Referer: 'https://canlidoviz.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36'
};

const BANKS = [
  { id: 'garanti', name: 'Garanti BBVA' },
  { id: 'kuveyt', name: 'Kuveyt Türk' },
  { id: 'yapi', name: 'Yapı Kredi' }
];

const BANK_ITEM_IDS = {
  'USD/TRY': { garanti: 805, kuveyt: 1021, yapi: 819 },
  'EUR/TRY': { garanti: 807, kuveyt: 1031, yapi: 820 },
  'GBP/TRY': { garanti: 809, kuveyt: 841, yapi: 1475 },
  'XAU/TRY': { garanti: 806, kuveyt: 826, yapi: 821 }
};

function toDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function parseDateOnly(value) {
  if (!DATE_RE.test(value || '')) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  if (toDateOnly(date) !== value) return null;
  return date;
}

function todayInIstanbul() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function oldestAllowedDate() {
  const today = parseDateOnly(todayInIstanbul());
  const oldest = new Date(today);
  oldest.setUTCFullYear(oldest.getUTCFullYear() - MAX_HISTORY_YEARS);
  return oldest;
}

function validateRange(start, end, pair) {
  const startDate = parseDateOnly(start);
  const endDate = parseDateOnly(end);

  if (!startDate || !endDate || startDate > endDate) {
    return 'Geçersiz tarih aralığı.';
  }

  if (!SUPPORTED_PAIRS.has(pair)) {
    return 'Desteklenmeyen parite.';
  }

  const today = parseDateOnly(todayInIstanbul());
  if (today && endDate > today) {
    return 'Gelecek tarih için geçmiş veri sorgulanamaz.';
  }

  const oldest = oldestAllowedDate();
  if (oldest && startDate < oldest) {
    return `En fazla son ${MAX_HISTORY_YEARS} yıllık geçmiş sorgulanabilir.`;
  }

  const maxEnd = new Date(startDate);
  maxEnd.setUTCFullYear(maxEnd.getUTCFullYear() + MAX_HISTORY_YEARS);
  if (endDate > maxEnd) {
    return `Tek sorguda en fazla ${MAX_HISTORY_YEARS} yıllık aralık seçilebilir.`;
  }

  return null;
}

function rangeDays(start, end) {
  const startDate = parseDateOnly(start);
  const endDate = parseDateOnly(end);
  if (!startDate || !endDate) return 1;
  return Math.max(1, Math.floor((endDate - startDate) / 86400000) + 1);
}

function timeoutForRange(start, end) {
  const days = rangeDays(start, end);
  if (days > 2500) return 120000;
  if (days > 1000) return 90000;
  if (days > 366) return 60000;
  return 30000;
}

function cacheTtlMs(end) {
  return end >= todayInIstanbul()
    ? 5 * 60 * 1000
    : 6 * 60 * 60 * 1000;
}

function getCached(cache, key) {
  const entry = cache.get(key);
  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }

  return entry.value;
}

function setCached(cache, key, value, ttlMs) {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }

  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs
  });
}

function splitDateRange(start, end, maxDays = HISTORY_CHUNK_DAYS) {
  const chunks = [];
  let cursor = parseDateOnly(start);
  const finalDate = parseDateOnly(end);

  if (!cursor || !finalDate) return chunks;

  while (cursor <= finalDate) {
    const chunkStart = new Date(cursor);
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + maxDays - 1);

    if (chunkEnd > finalDate) {
      chunkEnd.setTime(finalDate.getTime());
    }

    chunks.push({
      start: toDateOnly(chunkStart),
      end: toDateOnly(chunkEnd)
    });

    cursor = new Date(chunkEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return chunks;
}

function timestampToIstanbulDate(timestampSeconds) {
  const date = new Date(timestampSeconds * 1000);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (!values.year || !values.month || !values.day) return null;

  return `${values.year}-${values.month}-${values.day}`;
}

function parseCanliDovizHistory(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];

  const byDate = new Map();

  for (const [timestampText, ohlcText] of Object.entries(payload)) {
    const timestamp = Number(timestampText);
    if (!Number.isFinite(timestamp) || typeof ohlcText !== 'string') continue;

    const values = ohlcText.split('|').map(Number);
    if (values.length < 4 || !values.slice(0, 4).every(Number.isFinite)) continue;

    const date = timestampToIstanbulDate(timestamp);
    if (!date) continue;

    byDate.set(date, {
      date,
      open: values[0],
      high: values[1],
      low: values[2],
      close: values[3],
      value: values[3]
    });
  }

  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function dedupePoints(points) {
  const byDate = new Map();

  for (const point of points) {
    if (!DATE_RE.test(point?.date || '') || !Number.isFinite(Number(point?.value))) continue;
    byDate.set(point.date, point);
  }

  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchCanliDovizChunk(itemId, start, end, signal) {
  const url = new URL(CANLIDOVIZ_API);
  url.searchParams.set('period', 'DAILY');
  url.searchParams.set('itemDataId', String(itemId));
  url.searchParams.set('startDate', `${start}T00:00:00`);
  url.searchParams.set('endDate', `${end}T23:59:59`);

  const response = await fetch(url, {
    headers: CANLIDOVIZ_HEADERS,
    signal
  });

  if (!response.ok) {
    const details = (await response.text()).slice(0, 200);
    throw new Error(`HTTP ${response.status}${details ? ` - ${details}` : ''}`);
  }

  return parseCanliDovizHistory(await response.json());
}

async function fetchCanliDovizChunkWithRetry(itemId, start, end, signal) {
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fetchCanliDovizChunk(itemId, start, end, signal);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      lastError = error;

      if (attempt === 0) {
        await wait(350);
      }
    }
  }

  throw lastError || new Error('Geçmiş veri alınamadı.');
}

async function fetchBankSeries(bank, pair, start, end, signal) {
  const itemId = BANK_ITEM_IDS[pair]?.[bank.id];
  if (!itemId) {
    return {
      id: bank.id,
      name: bank.name,
      points: [],
      error: 'Bu parite için tarihsel seri yok.'
    };
  }

  const chunks = splitDateRange(start, end);
  const allPoints = [];
  const failedChunks = [];

  for (const chunk of chunks) {
    try {
      const points = await fetchCanliDovizChunkWithRetry(
        itemId,
        chunk.start,
        chunk.end,
        signal
      );
      allPoints.push(...points);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      failedChunks.push({
        start: chunk.start,
        end: chunk.end,
        error: error?.message || String(error)
      });
    }
  }

  const points = dedupePoints(allPoints);

  if (!points.length && failedChunks.length) {
    return {
      id: bank.id,
      name: bank.name,
      points: [],
      error: `${failedChunks.length} tarih bölümü alınamadı.`
    };
  }

  return {
    id: bank.id,
    name: bank.name,
    points,
    warning: failedChunks.length
      ? `${failedChunks.length} tarih bölümü alınamadı.`
      : null
  };
}

async function fetchRows(url, signal) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal
  });

  if (!response.ok) {
    const details = (await response.text()).slice(0, 300);
    throw new Error(`HTTP ${response.status}: ${details}`);
  }

  const payload = await response.json();
  return Array.isArray(payload) ? payload : [];
}

function normalizePoints(rows, quote, divisor = 1) {
  return rows
    .filter((row) => String(row?.quote || '').toUpperCase() === quote && Number.isFinite(Number(row?.rate)))
    .map((row) => ({
      date: row.date,
      value: Number(row.rate) / divisor
    }))
    .filter((point) => DATE_RE.test(point.date || '') && Number.isFinite(point.value))
    .sort((a, b) => a.date.localeCompare(b.date));
}

router.get('/api/history/banks', async (req, res) => {
  const start = String(req.query.start || '');
  const end = String(req.query.end || '');
  const pair = String(req.query.pair || 'USD/TRY').toUpperCase();

  res.set('Cache-Control', 'no-store');

  const validationError = validateRange(start, end, pair);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const cacheKey = `banks:${pair}:${start}:${end}`;
  const cached = getCached(bankCache, cacheKey);
  if (cached) return res.json(cached);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutForRange(start, end));

  try {
    const series = await Promise.all(
      BANKS.map(async (bank) => {
        try {
          return await fetchBankSeries(bank, pair, start, end, controller.signal);
        } catch (error) {
          return {
            id: bank.id,
            name: bank.name,
            points: [],
            error: error?.name === 'AbortError'
              ? 'Zaman aşımı.'
              : (error?.message || String(error))
          };
        }
      })
    );

    const populated = series.filter((item) => item.points.length > 0);
    if (!populated.length) {
      const errors = series
        .map((item) => `${item.name}: ${item.error || item.warning || 'veri yok'}`)
        .join(' | ');

      return res.status(502).json({
        error: `Üç bankadan da geçmiş veri alınamadı. ${errors}`,
        series
      });
    }

    const result = {
      source: 'CanlıDöviz banka tarihçesi',
      sourceType: 'third-party-bank-specific-history',
      valueType: 'daily-close',
      note: 'Seriler bankaya özel günlük tarihsel fiyat/kapanış değeridir; her gün için ayrı alış-satış çifti değildir.',
      pair,
      start,
      end,
      series
    };

    setCached(bankCache, cacheKey, result, cacheTtlMs(end));
    return res.json(result);
  } finally {
    clearTimeout(timeout);
  }
});

router.get('/api/history/reference', async (req, res) => {
  const start = String(req.query.start || '');
  const end = String(req.query.end || '');
  const pair = String(req.query.pair || 'USD/TRY').toUpperCase();

  res.set('Cache-Control', 'no-store');

  const validationError = validateRange(start, end, pair);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const cacheKey = `reference:${pair}:${start}:${end}`;
  const cached = getCached(referenceCache, cacheKey);
  if (cached) return res.json(cached);

  const [base, quote] = pair.split('/');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutForRange(start, end));

  try {
    let rows = [];
    let source = '';
    let divisor = 1;

    if (base === 'XAU') {
      const url = new URL('https://api.frankfurter.dev/v2/rates');
      url.searchParams.set('from', start);
      url.searchParams.set('to', end);
      url.searchParams.set('base', 'XAU');
      url.searchParams.set('quotes', 'TRY');

      rows = await fetchRows(url, controller.signal);
      source = 'Altın referans kuru (Frankfurter resmi kaynak harmanı)';
      divisor = GRAMS_PER_TROY_OUNCE;
    } else {
      const tcmbUrl = new URL('https://api.frankfurter.dev/v2/providers/tcmb/rates');
      tcmbUrl.searchParams.set('from', start);
      tcmbUrl.searchParams.set('to', end);
      tcmbUrl.searchParams.set('base', base);
      tcmbUrl.searchParams.set('quotes', 'TRY');

      rows = await fetchRows(tcmbUrl, controller.signal);
      source = 'TCMB';

      if (!normalizePoints(rows, quote).length) {
        const fallbackUrl = new URL('https://api.frankfurter.dev/v2/rates');
        fallbackUrl.searchParams.set('from', start);
        fallbackUrl.searchParams.set('to', end);
        fallbackUrl.searchParams.set('base', base);
        fallbackUrl.searchParams.set('quotes', 'TRY');

        rows = await fetchRows(fallbackUrl, controller.signal);
        source = 'Frankfurter resmi kaynak harmanı';
      }
    }

    const points = normalizePoints(rows, quote, divisor);
    const result = { source, pair, start, end, points };

    setCached(referenceCache, cacheKey, result, cacheTtlMs(end));
    return res.json(result);
  } catch (error) {
    const message = error?.name === 'AbortError'
      ? 'Geçmiş kur servisi zaman aşımına uğradı.'
      : `Geçmiş kur verisi alınamadı: ${error?.message || error}`;

    return res.status(502).json({ error: message });
  } finally {
    clearTimeout(timeout);
  }
});

module.exports = router;
