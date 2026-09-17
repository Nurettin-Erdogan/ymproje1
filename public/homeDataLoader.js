import { parseAllProviders } from './scrapeClientParser.js';

const DATA_BASE_URL = globalThis.__SCRAPE_BASE_URL__ || 'https://fatihedu.github.io/ymproje1';
const SELECTED_PAIRS = ['USD/TRY', 'EUR/TRY', 'GBP/TRY', 'XAU/TRY'];
const PROVIDER_ORDER = ['garanti', 'kuveyt', 'yapi'];

const SELECTORS = {
  usdValue: '#val-usd',
  usdChange: '#chg-usd',
  eurValue: '#val-eur',
  eurChange: '#chg-eur',
  gbpValue: '#val-gbp',
  gbpChange: '#chg-gbp',
  goldValue: '#val-gold',
  goldChange: '#chg-gold',
  listBody: '#currency-list-body',
  listMeta: '#currency-list-meta',
  loadingOverlay: '#loading-overlay',
  loadingMessage: '#loading-message'
};

const qs = (selector) => document.querySelector(selector);

let latestLoadedRows = [];
let latestRunStartedAt = null;
let currentSort = { key: null, asc: true };
let isLoggedIn = false;
let csrfToken = '';
let favoriteSet = new Set();
let loadingDepth = 0;
let latestLoadPromise = null;
let lastSuccessfulLoadAt = 0;

function normalizeProviderName(name) {
  if (!name) return '';
  return String(name)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function favoriteKey(pair, providerName) {
  return `${pair}::${normalizeProviderName(providerName)}`;
}

function showLoading(message = 'Yükleniyor...') {
  const overlay = qs(SELECTORS.loadingOverlay);
  const text = qs(SELECTORS.loadingMessage);

  loadingDepth += 1;
  if (text) text.textContent = message;
  if (overlay) overlay.classList.remove('hidden');
}

function hideLoading() {
  const overlay = qs(SELECTORS.loadingOverlay);
  loadingDepth = Math.max(0, loadingDepth - 1);
  if (loadingDepth === 0 && overlay) overlay.classList.add('hidden');
}

function formatNumber(value, fractionDigits = 4) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '-';

  return new Intl.NumberFormat('tr-TR', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits
  }).format(num);
}

function formatPct(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '';
  const sign = num > 0 ? '+' : '';
  return `${sign}${formatNumber(num, 2)}%`;
}

function formatShortDateTime(dateString) {
  if (!dateString) return '-';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return '-';

  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatRelativeTime(dateString) {
  if (!dateString) return '-';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return '-';

  const diffMs = Math.max(0, Date.now() - date.getTime());
  const minutes = Math.floor(diffMs / 60000);

  if (minutes < 1) return 'şimdi';
  if (minutes < 60) return `${minutes} dk önce`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} saat önce`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} gün önce`;

  return formatShortDateTime(dateString).split(' ')[0];
}

function getFreshnessClass(dateString) {
  if (!dateString) return 'freshness--unknown';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return 'freshness--unknown';

  const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
  if (minutes < 24 * 60) return 'freshness--fresh';
  if (minutes < 7 * 24 * 60) return 'freshness--warn';
  return 'freshness--stale';
}

function setText(selector, text) {
  const element = qs(selector);
  if (element) element.textContent = text;
}

function setChange(selector, value) {
  const element = qs(selector);
  if (!element) return;

  const num = Number(value);
  element.textContent = Number.isFinite(num) ? formatPct(num) : '';
  element.classList.remove('up', 'down');

  if (num > 0) element.classList.add('up');
  if (num < 0) element.classList.add('down');
}

function renderListMeta(message, isError = false) {
  const element = qs(SELECTORS.listMeta);
  if (!element) return;

  element.textContent = message || '';
  element.classList.toggle('text-danger', Boolean(isError));
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

function latestDataUrl() {
  const url = new URL(`${DATA_BASE_URL}/latest_all.json`);
  url.searchParams.set('_', String(Date.now()));
  return url.toString();
}

function filterVisibleRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter((row) => SELECTED_PAIRS.includes(row.pair));
}

function getPairAverage(rows, pair) {
  const matches = rows.filter((row) => row.pair === pair);
  if (!matches.length) return null;

  const parityValues = matches.map((row) => Number(row.parity)).filter(Number.isFinite);
  const changeValues = matches.map((row) => Number(row.changePct)).filter(Number.isFinite);

  return {
    parity: parityValues.length
      ? parityValues.reduce((sum, value) => sum + value, 0) / parityValues.length
      : null,
    changePct: changeValues.length
      ? changeValues.reduce((sum, value) => sum + value, 0) / changeValues.length
      : null
  };
}

function updateSummaryCards(rows) {
  const usd = getPairAverage(rows, 'USD/TRY');
  const eur = getPairAverage(rows, 'EUR/TRY');
  const gbp = getPairAverage(rows, 'GBP/TRY');
  const gold = getPairAverage(rows, 'XAU/TRY');

  setText(SELECTORS.usdValue, formatNumber(usd?.parity));
  setChange(SELECTORS.usdChange, usd?.changePct);

  setText(SELECTORS.eurValue, formatNumber(eur?.parity));
  setChange(SELECTORS.eurChange, eur?.changePct);

  setText(SELECTORS.gbpValue, formatNumber(gbp?.parity));
  setChange(SELECTORS.gbpChange, gbp?.changePct);

  setText(SELECTORS.goldValue, formatNumber(gold?.parity));
  setChange(SELECTORS.goldChange, gold?.changePct);
}

function providerRank(providerId) {
  const index = PROVIDER_ORDER.indexOf(providerId);
  return index === -1 ? PROVIDER_ORDER.length : index;
}

function compareRows(a, b) {
  if (currentSort.key === 'buy' || currentSort.key === 'sell' || currentSort.key === 'spread') {
    const aValue = Number(a[currentSort.key]);
    const bValue = Number(b[currentSort.key]);
    const aValid = Number.isFinite(aValue);
    const bValid = Number.isFinite(bValue);

    if (!aValid && !bValid) return 0;
    if (!aValid) return 1;
    if (!bValid) return -1;

    return currentSort.asc ? aValue - bValue : bValue - aValue;
  }

  const rankDiff = providerRank(a.providerId) - providerRank(b.providerId);
  if (rankDiff !== 0) return rankDiff;
  return String(a.providerName || '').localeCompare(String(b.providerName || ''), 'tr');
}

function clearSortIndicators() {
  document.querySelectorAll('th[data-sort]').forEach((header) => {
    header.classList.remove('asc', 'desc');
    const button = header.querySelector('.sort-btn');
    if (button) button.textContent = '⇅';
  });
}

function updateSortIndicator() {
  clearSortIndicators();
  if (!currentSort.key) return;

  const header = document.querySelector(`th[data-sort="${currentSort.key}"]`);
  if (!header) return;

  header.classList.add(currentSort.asc ? 'asc' : 'desc');
  const button = header.querySelector('.sort-btn');
  if (button) button.textContent = currentSort.asc ? '▲' : '▼';
}

function wireSortHeaders() {
  document.querySelectorAll('th[data-sort]').forEach((header) => {
    if (header.dataset.sortBound === '1') return;
    header.dataset.sortBound = '1';
    header.classList.add('th-sortable');

    header.addEventListener('click', () => {
      const key = header.dataset.sort;
      if (!key) return;

      if (currentSort.key === key) {
        currentSort.asc = !currentSort.asc;
      } else {
        currentSort = { key, asc: true };
      }

      updateSortIndicator();
      renderCurrencyList(latestLoadedRows);
    });
  });
}

function createCell(text, className = '') {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  cell.textContent = text;
  return cell;
}

function renderCurrencyList(rows) {
  const body = qs(SELECTORS.listBody);
  if (!body) return;

  const safeRows = Array.isArray(rows) ? rows.slice() : [];
  latestLoadedRows = safeRows;
  body.textContent = '';

  if (!safeRows.length) {
    const emptyRow = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 7;
    cell.className = 'text-center text-muted';
    cell.textContent = 'Kur verisi bulunamadı.';
    emptyRow.appendChild(cell);
    body.appendChild(emptyRow);
    return;
  }

  const groups = new Map(SELECTED_PAIRS.map((pair) => [pair, []]));
  for (const row of safeRows) {
    if (groups.has(row.pair)) groups.get(row.pair).push(row);
  }

  for (const pair of SELECTED_PAIRS) {
    const pairRows = groups.get(pair) || [];
    if (!pairRows.length) continue;

    pairRows.sort(compareRows);

    const headerRow = document.createElement('tr');
    headerRow.className = 'currency-group-row';

    const headerCell = document.createElement('td');
    headerCell.colSpan = 7;

    const group = document.createElement('div');
    group.className = 'currency-group';

    const groupName = document.createElement('span');
    groupName.className = 'currency-group__name';
    groupName.textContent = pair === 'XAU/TRY' ? 'ALTIN' : pair;

    group.appendChild(groupName);
    headerCell.appendChild(group);
    headerRow.appendChild(headerCell);
    body.appendChild(headerRow);

    for (const row of pairRows) {
      const tr = document.createElement('tr');
      tr.className = 'bank-row';

      const favoriteCell = document.createElement('td');
      favoriteCell.className = 'col-fav';

      if (isLoggedIn) {
        const isFavorite = favoriteSet.has(favoriteKey(row.pair, row.providerName));
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `fav-btn${isFavorite ? ' is-active' : ''}`;
        button.dataset.pair = row.pair;
        button.dataset.provider = row.providerName;
        button.setAttribute('aria-label', `${row.providerName} ${pair} favorisini ${isFavorite ? 'kaldır' : 'ekle'}`);
        button.textContent = '★';
        favoriteCell.appendChild(button);
      }

      tr.appendChild(favoriteCell);
      tr.appendChild(createCell(row.providerName || '-'));
      tr.appendChild(createCell(formatNumber(row.buy)));
      tr.appendChild(createCell(formatNumber(row.sell)));
      tr.appendChild(createCell(formatNumber(row.spread)));

      const change = Number(row.changePct);
      const changeClass = change > 0 ? 'up' : change < 0 ? 'down' : '';
      tr.appendChild(createCell(formatPct(change), changeClass));

      const freshnessCell = document.createElement('td');
      const freshnessClass = getFreshnessClass(row.time);
      freshnessCell.className = `last-updated ${freshnessClass}`;
      freshnessCell.title = formatShortDateTime(row.time);
      freshnessCell.dataset.time = row.time || '';

      const freshnessWrap = document.createElement('div');
      freshnessWrap.className = 'freshness-cell';

      const freshnessDot = document.createElement('span');
      freshnessDot.className = 'freshness-dot';

      const freshnessText = document.createElement('span');
      freshnessText.className = 'freshness-text';
      freshnessText.textContent = formatRelativeTime(row.time);

      freshnessWrap.appendChild(freshnessDot);
      freshnessWrap.appendChild(freshnessText);
      freshnessCell.appendChild(freshnessWrap);
      tr.appendChild(freshnessCell);

      body.appendChild(tr);
    }
  }

  bindFavoriteButtons();
}

function refreshRelativeTimes() {
  document.querySelectorAll('.last-updated[data-time]').forEach((cell) => {
    const time = cell.dataset.time || '';
    cell.classList.remove('freshness--fresh', 'freshness--warn', 'freshness--stale', 'freshness--unknown');
    cell.classList.add(getFreshnessClass(time));

    const text = cell.querySelector('.freshness-text');
    if (text) text.textContent = formatRelativeTime(time);
  });
}

async function initAuthState() {
  try {
    const auth = await fetchJson('/auth/me');
    isLoggedIn = Boolean(auth?.user);
  } catch {
    isLoggedIn = false;
  }
}

async function ensureCsrfToken() {
  if (csrfToken) return csrfToken;
  const data = await fetchJson('/csrf-token');
  csrfToken = data?.csrfToken || '';
  return csrfToken;
}

async function loadFavorites() {
  if (!isLoggedIn) {
    favoriteSet = new Set();
    return;
  }

  try {
    const data = await fetchJson('/api/favorites');
    const favorites = Array.isArray(data?.favorites) ? data.favorites : [];
    favoriteSet = new Set(
      favorites.map((favorite) => favoriteKey(favorite.pair, favorite.providerName))
    );
  } catch (error) {
    console.warn('[homeDataLoader] favoriler alınamadı', error?.message || error);
    favoriteSet = new Set();
  }
}

async function updateFavorite(pair, providerName, shouldAdd) {
  const token = await ensureCsrfToken();
  const body = new URLSearchParams({ pair, providerName }).toString();
  const url = shouldAdd ? '/api/favorites' : '/api/favorites/remove';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'x-csrf-token': token
    },
    body
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(details || `HTTP ${response.status}`);
  }

  const data = await response.json();
  const favorites = Array.isArray(data?.favorites) ? data.favorites : [];
  favoriteSet = new Set(
    favorites.map((favorite) => favoriteKey(favorite.pair, favorite.providerName))
  );
}

function bindFavoriteButtons() {
  if (!isLoggedIn) return;

  qs(SELECTORS.listBody)?.querySelectorAll('.fav-btn').forEach((button) => {
    if (button.dataset.favoriteBound === '1') return;
    button.dataset.favoriteBound = '1';

    button.addEventListener('click', async () => {
      const pair = button.dataset.pair || '';
      const providerName = button.dataset.provider || '';
      const key = favoriteKey(pair, providerName);
      const shouldAdd = !favoriteSet.has(key);

      button.disabled = true;
      try {
        await updateFavorite(pair, providerName, shouldAdd);
        renderCurrencyList(latestLoadedRows);
      } catch (error) {
        console.error('[homeDataLoader] favori güncellenemedi', error);
        renderListMeta(`Favori güncellenemedi: ${error?.message || error}`, true);
      } finally {
        button.disabled = false;
      }
    });
  });
}

async function loadLatestData({ showOverlay = false } = {}) {
  if (latestLoadPromise) return latestLoadPromise;

  latestLoadPromise = (async () => {
    if (showOverlay) showLoading('Son veriler yükleniyor...');

    try {
      const snapshot = await fetchJson(latestDataUrl());
      const rows = filterVisibleRows(parseAllProviders(snapshot));

      if (!rows.length) {
        throw new Error('Kur sağlayıcılarından kullanılabilir veri gelmedi.');
      }

      latestRunStartedAt = snapshot?.runStartedAt || snapshot?.scheduledFor || null;
      latestLoadedRows = rows;
      lastSuccessfulLoadAt = Date.now();

      updateSummaryCards(rows);
      renderCurrencyList(rows);
      updateSortIndicator();
      renderListMeta(`Son güncelleme: ${formatShortDateTime(latestRunStartedAt)}`);
    } catch (error) {
      console.error('[homeDataLoader]', error);
      const prefix = latestLoadedRows.length ? 'Yeni veri alınamadı' : 'Son veriler yüklenemedi';
      renderListMeta(`${prefix}: ${error?.message || error}`, true);
    } finally {
      if (showOverlay) hideLoading();
      latestLoadPromise = null;
    }
  })();

  return latestLoadPromise;
}

function setCurrentYear() {
  const year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());
}

async function refreshAuthAndFavorites() {
  await initAuthState();
  await loadFavorites();
  if (latestLoadedRows.length) renderCurrencyList(latestLoadedRows);
}

function bindLifecycleRefresh() {
  window.setInterval(() => {
    void loadLatestData({ showOverlay: false });
  }, 10 * 60 * 1000);

  window.setInterval(refreshRelativeTimes, 60 * 1000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;

    refreshRelativeTimes();

    if (Date.now() - lastSuccessfulLoadAt > 3 * 60 * 1000) {
      void loadLatestData({ showOverlay: false });
    }
  });

  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      void refreshAuthAndFavorites();
      void loadLatestData({ showOverlay: false });
    }
  });
}

async function init() {
  setCurrentYear();
  wireSortHeaders();

  await Promise.allSettled([
    refreshAuthAndFavorites(),
    loadLatestData({ showOverlay: true })
  ]);

  bindLifecycleRefresh();
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    void init();
  });
}
