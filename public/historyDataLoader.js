const qs = (selector) => document.querySelector(selector);
const pad = (value) => String(value).padStart(2, '0');

const BANK_COLORS = {
  garanti: '#e11d48',
  kuveyt: '#059669',
  yapi: '#f59e0b'
};

const BANK_ORDER = ['garanti', 'kuveyt', 'yapi'];
const visibleBanks = new Set(BANK_ORDER);
const MAX_HISTORY_YEARS = 10;

let chartState = null;
let resizeTimer = null;
let requestController = null;
let pointerFrame = null;
let pendingPointer = null;

function ensureChartStyles() {
  if (document.querySelector('#bank-history-chart-styles')) return;

  const style = document.createElement('style');
  style.id = 'bank-history-chart-styles';
  style.textContent = `
    .chart-meta {
      min-height: 1.2rem;
      margin-top: .45rem;
      color: #64748b;
      font-size: .78rem;
    }

    .chart-meta:empty {
      display: none;
    }

    .chart-meta--error {
      color: #b91c1c;
      font-weight: 650;
    }

    .chart-meta--info {
      color: #64748b;
    }

    .chart-wrap {
      position: relative;
      overflow: hidden;
      padding: 0 !important;
      border: 1px solid #dbe3ee !important;
      border-radius: 12px !important;
      background: #fff !important;
      box-shadow: inset 0 1px 0 rgba(15, 23, 42, .02);
    }

    .chart-wrap[aria-busy="true"] {
      opacity: .78;
    }

    #range-chart {
      display: block;
      width: 100% !important;
      height: 360px !important;
      cursor: crosshair;
      touch-action: pan-y;
      user-select: none;
    }

    .chart-legend {
      display: flex;
      flex-wrap: wrap;
      gap: .55rem;
      margin-top: .8rem;
      margin-bottom: .8rem;
    }

    .chart-legend__item {
      appearance: none;
      display: inline-flex;
      align-items: center;
      gap: .48rem;
      min-height: 34px;
      padding: .42rem .72rem;
      border: 1px solid #dbe3ee;
      border-left: 4px solid var(--legend-color);
      border-radius: 999px;
      background: #fff;
      color: #111827;
      font: inherit;
      font-size: .82rem;
      font-weight: 650;
      cursor: pointer;
      transition: transform .12s ease, box-shadow .12s ease, opacity .12s ease, background .12s ease;
    }

    .chart-legend__item:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(15, 23, 42, .08);
      background: #f8fafc;
    }

    .chart-legend__item.is-muted {
      opacity: .42;
      background: #f8fafc;
      border-left-color: #94a3b8;
    }

    .chart-legend__dot {
      width: 9px;
      height: 9px;
      flex: 0 0 9px;
      border-radius: 999px;
      box-shadow: 0 0 0 2px #fff, 0 0 0 3px currentColor;
    }

    .chart-tooltip {
      position: absolute;
      z-index: 20;
      min-width: 205px;
      max-width: min(290px, calc(100% - 20px));
      padding: 11px 12px;
      border: 1px solid rgba(148, 163, 184, .45);
      border-radius: 10px;
      background: rgba(15, 23, 42, .96);
      color: #fff;
      box-shadow: 0 14px 34px rgba(15, 23, 42, .24);
      pointer-events: none;
      backdrop-filter: blur(8px);
    }

    .chart-tooltip.hidden {
      display: none !important;
    }

    .chart-tooltip__date {
      margin-bottom: 8px;
      padding-bottom: 7px;
      border-bottom: 1px solid rgba(255, 255, 255, .16);
      color: #e2e8f0;
      font-size: .78rem;
      font-weight: 700;
    }

    .chart-tooltip__row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-top: 7px;
    }

    .chart-tooltip__bank {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      color: #f8fafc;
      font-size: .8rem;
      white-space: nowrap;
    }

    .chart-tooltip__dot {
      width: 8px;
      height: 8px;
      flex: 0 0 8px;
      border-radius: 999px;
    }

    .chart-tooltip__value {
      color: #fff;
      font-size: .84rem;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }

    .chart-tooltip__hint {
      margin-top: 8px;
      color: #94a3b8;
      font-size: .68rem;
    }

    #range-10y-btn {
      background: #eef4ff;
      color: #1d4ed8;
      border: 1px solid #c7d7fe;
    }

    #range-10y-btn:hover {
      background: #e0eaff;
    }

    @media (max-width: 700px) {
      #range-chart { height: 320px !important; }
      .chart-tooltip { min-width: 185px; }
      .chart-legend__item { font-size: .76rem; padding: .38rem .62rem; }
    }
  `;
  document.head.appendChild(style);
}

function renderMeta(message, isError = false) {
  const element = qs('#chart-meta');
  if (!element) return;
  element.textContent = message || '';
  element.classList.remove('chart-meta--info', 'chart-meta--error');
  if (message) element.classList.add(isError ? 'chart-meta--error' : 'chart-meta--info');
}

function setBusy(isBusy) {
  const loadButton = qs('#range-load-btn');
  const tenYearButton = qs('#range-10y-btn');
  const wrap = qs('.chart-wrap');

  if (loadButton) {
    if (!loadButton.dataset.defaultText) {
      loadButton.dataset.defaultText = loadButton.textContent || 'Grafiği Yükle';
    }
    loadButton.disabled = isBusy;
    loadButton.textContent = isBusy ? 'Yükleniyor…' : loadButton.dataset.defaultText;
  }

  if (tenYearButton) tenYearButton.disabled = isBusy;
  if (wrap) wrap.setAttribute('aria-busy', String(isBusy));
}

function toInputDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysBetween(start, end) {
  const a = parseDateOnly(start);
  const b = parseDateOnly(end);
  if (!a || !b) return 0;
  return Math.max(0, Math.round((b - a) / 86400000));
}

function formatFullDate(dateString) {
  const [year, month, day] = String(dateString || '').split('-');
  return year && month && day ? `${day}.${month}.${year}` : dateString;
}

function formatAxisDate(dateString, spanDays) {
  const [year, month, day] = String(dateString || '').split('-');
  if (!year || !month || !day) return dateString;

  if (spanDays >= 730) return year;
  if (spanDays >= 120) return `${month}.${year}`;
  return `${day}.${month}`;
}

function formatPrice(value, pair) {
  const digits = pair === 'XAU/TRY' ? 2 : 4;
  return new Intl.NumberFormat('tr-TR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(value);
}

function pairLabel(pair) {
  return pair === 'XAU/TRY' ? 'Gram Altın / TRY' : pair;
}

function normalizeSeries(series) {
  return (Array.isArray(series) ? series : [])
    .map((item) => {
      const dedup = new Map();

      for (const point of Array.isArray(item?.points) ? item.points : []) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(point?.date || '')) continue;
        const value = Number(point?.value ?? point?.close);
        if (!Number.isFinite(value)) continue;

        dedup.set(point.date, {
          date: point.date,
          value,
          open: Number.isFinite(Number(point.open)) ? Number(point.open) : null,
          high: Number.isFinite(Number(point.high)) ? Number(point.high) : null,
          low: Number.isFinite(Number(point.low)) ? Number(point.low) : null,
          close: Number.isFinite(Number(point.close)) ? Number(point.close) : value
        });
      }

      const points = Array.from(dedup.values()).sort((a, b) => a.date.localeCompare(b.date));
      return {
        id: item?.id || 'unknown',
        name: item?.name || item?.id || 'Banka',
        error: item?.error || null,
        warning: item?.warning || null,
        color: BANK_COLORS[item?.id] || '#2563eb',
        points,
        pointMap: new Map(points.map((point) => [point.date, point]))
      };
    })
    .sort((a, b) => BANK_ORDER.indexOf(a.id) - BANK_ORDER.indexOf(b.id));
}

function visibleSeries(series) {
  return series.filter((item) => visibleBanks.has(item.id) && item.points.length > 0);
}

function renderLegend(series) {
  const container = qs('#chart-legend');
  if (!container) return;

  container.textContent = '';

  for (const item of series.filter((entry) => entry.points.length > 0)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chart-legend__item';
    button.style.setProperty('--legend-color', item.color);
    button.style.color = item.color;
    button.setAttribute('aria-pressed', String(visibleBanks.has(item.id)));
    button.title = `${item.name} serisini göster/gizle`;

    if (!visibleBanks.has(item.id)) button.classList.add('is-muted');

    const dot = document.createElement('span');
    dot.className = 'chart-legend__dot';
    dot.style.background = item.color;

    const label = document.createElement('span');
    label.className = 'chart-legend__text';
    label.style.color = '#111827';
    label.textContent = item.name;

    button.appendChild(dot);
    button.appendChild(label);

    button.addEventListener('click', () => {
      if (visibleBanks.has(item.id)) {
        const activeCount = series.filter((entry) => visibleBanks.has(entry.id) && entry.points.length > 0).length;
        if (activeCount <= 1) return;
        visibleBanks.delete(item.id);
      } else {
        visibleBanks.add(item.id);
      }

      renderLegend(series);
      hideTooltip();
      if (chartState) {
        chartState.hoverIndex = null;
        renderChart();
      }
    });

    container.appendChild(button);
  }
}

function ensureTooltip() {
  const wrap = qs('.chart-wrap');
  if (!wrap) return null;

  let tooltip = qs('#chart-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'chart-tooltip';
    tooltip.className = 'chart-tooltip hidden';
    tooltip.setAttribute('role', 'tooltip');
    wrap.appendChild(tooltip);
  }
  return tooltip;
}

function hideTooltip() {
  const tooltip = qs('#chart-tooltip');
  if (tooltip) tooltip.classList.add('hidden');
}

function niceStep(range, targetTicks = 5) {
  if (!Number.isFinite(range) || range <= 0) return 1;

  const rough = range / Math.max(2, targetTicks);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;

  let nice = 1;
  if (normalized >= 5) nice = 5;
  else if (normalized >= 2.5) nice = 2.5;
  else if (normalized >= 2) nice = 2;

  return nice * magnitude;
}

function buildScale(values) {
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);

  if (rawMin === rawMax) {
    const padValue = Math.max(Math.abs(rawMin) * 0.005, 0.05);
    return {
      min: rawMin - padValue,
      max: rawMax + padValue
    };
  }

  const padding = (rawMax - rawMin) * 0.10;
  const paddedMin = rawMin - padding;
  const paddedMax = rawMax + padding;
  const step = niceStep(paddedMax - paddedMin, 5);

  return {
    min: Math.floor(paddedMin / step) * step,
    max: Math.ceil(paddedMax / step) * step
  };
}

function pickTickIndices(count, maxTicks) {
  if (count <= 0) return [];
  if (count <= maxTicks) return Array.from({ length: count }, (_, index) => index);

  const indices = new Set([0, count - 1]);
  for (let i = 1; i < maxTicks - 1; i += 1) {
    indices.add(Math.round((i * (count - 1)) / (maxTicks - 1)));
  }
  return Array.from(indices).sort((a, b) => a - b);
}

function setupCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const cssWidth = Math.max(320, Math.round(rect.width || canvas.clientWidth || 960));
  const cssHeight = window.innerWidth <= 700 ? 320 : 360;
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));

  canvas.style.height = `${cssHeight}px`;

  const targetWidth = Math.round(cssWidth * dpr);
  const targetHeight = Math.round(cssHeight * dpr);

  if (canvas.width !== targetWidth) canvas.width = targetWidth;
  if (canvas.height !== targetHeight) canvas.height = targetHeight;

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  return { ctx, cssWidth, cssHeight };
}

function drawRoundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function renderEmptyChart(ctx, cssWidth, cssHeight, message) {
  ctx.fillStyle = '#64748b';
  ctx.font = '500 14px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(message, cssWidth / 2, cssHeight / 2);
}

function renderChart() {
  const canvas = qs('#range-chart');
  if (!canvas || !chartState) return;

  const setup = setupCanvas(canvas);
  if (!setup) return;

  const { ctx, cssWidth, cssHeight } = setup;
  const activeSeries = visibleSeries(chartState.series);
  const allDates = Array.from(
    new Set(activeSeries.flatMap((item) => item.points.map((point) => point.date)))
  ).sort();

  const values = activeSeries
    .flatMap((item) => item.points.map((point) => point.value))
    .filter(Number.isFinite);

  if (!values.length || !allDates.length) {
    chartState.layout = null;
    renderEmptyChart(ctx, cssWidth, cssHeight, 'Seçilen aralık için banka geçmiş verisi bulunamadı.');
    return;
  }

  const compact = cssWidth < 700;
  const padding = {
    top: 54,
    right: compact ? 20 : 30,
    bottom: 48,
    left: compact ? 66 : 82
  };

  const plotWidth = Math.max(80, cssWidth - padding.left - padding.right);
  const plotHeight = Math.max(80, cssHeight - padding.top - padding.bottom);
  const scale = buildScale(values);
  const scaleRange = scale.max - scale.min || 1;
  const spanDays = daysBetween(allDates[0], allDates[allDates.length - 1]);

  const xForIndex = (index) =>
    allDates.length === 1
      ? padding.left + plotWidth / 2
      : padding.left + (index / (allDates.length - 1)) * plotWidth;

  const yFor = (value) =>
    padding.top + ((scale.max - value) / scaleRange) * plotHeight;

  const dateIndex = new Map(allDates.map((date, index) => [date, index]));
  const seriesPixels = activeSeries.map((item) => ({
    item,
    pixels: item.points
      .map((point) => ({
        point,
        index: dateIndex.get(point.date)
      }))
      .filter((entry) => entry.index != null && Number.isFinite(entry.point.value))
      .map((entry) => ({
        ...entry,
        x: xForIndex(entry.index),
        y: yFor(entry.point.value)
      }))
  }));

  chartState.layout = {
    padding,
    plotWidth,
    plotHeight,
    cssWidth,
    cssHeight,
    allDates,
    xForIndex,
    yFor,
    activeSeries,
    seriesPixels,
    scale,
    spanDays
  };

  ctx.save();
  drawRoundedRect(ctx, padding.left, padding.top, plotWidth, plotHeight, 9);
  ctx.fillStyle = '#fbfdff';
  ctx.fill();
  ctx.clip();

  const yTicks = 5;
  for (let i = 0; i <= yTicks; i += 1) {
    const y = padding.top + (i / yTicks) * plotHeight;
    const crispY = Math.round(y) + 0.5;

    ctx.strokeStyle = i === yTicks ? '#cbd5e1' : '#e2e8f0';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, crispY);
    ctx.lineTo(padding.left + plotWidth, crispY);
    ctx.stroke();
  }

  const maxDateTicks = compact ? 4 : Math.min(8, Math.max(4, Math.floor(plotWidth / 115)));
  const tickIndices = pickTickIndices(allDates.length, maxDateTicks);
  for (const index of tickIndices) {
    const x = Math.round(xForIndex(index)) + 0.5;
    ctx.strokeStyle = '#eef2f7';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, padding.top);
    ctx.lineTo(x, padding.top + plotHeight);
    ctx.stroke();
  }

  const drawPointMarkers = allDates.length <= 120;

  for (const { item, pixels } of seriesPixels) {
    if (!pixels.length) continue;

    ctx.save();
    ctx.strokeStyle = item.color;
    ctx.globalAlpha = 0.10;
    ctx.lineWidth = 7;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    pixels.forEach((entry, index) => {
      if (index === 0) ctx.moveTo(entry.x, entry.y);
      else ctx.lineTo(entry.x, entry.y);
    });
    ctx.stroke();
    ctx.restore();

    ctx.strokeStyle = item.color;
    ctx.lineWidth = 2.35;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    pixels.forEach((entry, index) => {
      if (index === 0) ctx.moveTo(entry.x, entry.y);
      else ctx.lineTo(entry.x, entry.y);
    });
    ctx.stroke();

    if (drawPointMarkers) {
      for (const entry of pixels) {
        ctx.beginPath();
        ctx.fillStyle = '#fff';
        ctx.arc(entry.x, entry.y, 3.7, 0, Math.PI * 2);
        ctx.fill();

        ctx.beginPath();
        ctx.fillStyle = item.color;
        ctx.arc(entry.x, entry.y, 2.3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  const hoverIndex = Number.isInteger(chartState.hoverIndex) ? chartState.hoverIndex : null;
  if (hoverIndex != null && allDates[hoverIndex]) {
    const hoverDate = allDates[hoverIndex];
    const x = xForIndex(hoverIndex);

    ctx.strokeStyle = 'rgba(71, 85, 105, .6)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, padding.top);
    ctx.lineTo(x, padding.top + plotHeight);
    ctx.stroke();
    ctx.setLineDash([]);

    for (const item of activeSeries) {
      const point = item.pointMap.get(hoverDate);
      if (!point) continue;

      const y = yFor(point.value);
      ctx.beginPath();
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = item.color;
      ctx.lineWidth = 2.5;
      ctx.arc(x, y, 5.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  ctx.restore();

  ctx.fillStyle = '#64748b';
  ctx.font = '500 12px "Segoe UI", system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';

  for (let i = 0; i <= yTicks; i += 1) {
    const y = padding.top + (i / yTicks) * plotHeight;
    const value = scale.max - (i / yTicks) * scaleRange;
    ctx.fillText(formatPrice(value, chartState.pair), padding.left - 10, y);
  }

  ctx.fillStyle = '#64748b';
  ctx.font = '500 12px "Segoe UI", system-ui, sans-serif';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'center';

  let lastAxisLabel = null;
  for (const index of tickIndices) {
    const date = allDates[index];
    const label = formatAxisDate(date, spanDays);
    if (label === lastAxisLabel && index !== tickIndices[tickIndices.length - 1]) continue;
    ctx.fillText(label, xForIndex(index), cssHeight - 16);
    lastAxisLabel = label;
  }

  ctx.textAlign = 'left';
  ctx.fillStyle = '#0f172a';
  ctx.font = '700 14px "Segoe UI", system-ui, sans-serif';
  ctx.fillText(`${pairLabel(chartState.pair)} banka geçmiş grafiği`, padding.left, 22);

  ctx.fillStyle = '#64748b';
  ctx.font = '500 11px "Segoe UI", system-ui, sans-serif';
  const subtitle = allDates.length === 1
    ? `${formatFullDate(allDates[0])} · günlük kapanış`
    : `${formatFullDate(allDates[0])} – ${formatFullDate(allDates[allDates.length - 1])} · ${allDates.length} veri günü`;
  ctx.fillText(subtitle, padding.left, 40);

  canvas.setAttribute(
    'aria-label',
    `${pairLabel(chartState.pair)} için ${formatFullDate(allDates[0])} ile ${formatFullDate(allDates[allDates.length - 1])} arasındaki banka geçmiş grafiği`
  );
}

function positionTooltip(clientX, clientY, tooltip, canvas) {
  const wrap = canvas.parentElement;
  const wrapRect = wrap.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const localX = clientX - wrapRect.left;
  const localY = clientY - wrapRect.top;

  let left = localX + 16;
  let top = localY + 16;

  if (left + tooltipRect.width > wrapRect.width - 10) {
    left = localX - tooltipRect.width - 16;
  }
  if (top + tooltipRect.height > wrapRect.height - 10) {
    top = localY - tooltipRect.height - 16;
  }

  tooltip.style.left = `${Math.max(10, left)}px`;
  tooltip.style.top = `${Math.max(10, top)}px`;
}

function processPointer(clientX, clientY) {
  const canvas = qs('#range-chart');
  const tooltip = ensureTooltip();
  const layout = chartState?.layout;

  if (!canvas || !tooltip || !layout?.allDates?.length) return;

  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const { padding, plotWidth, plotHeight, allDates, activeSeries } = layout;

  if (
    x < padding.left ||
    x > padding.left + plotWidth ||
    y < padding.top ||
    y > padding.top + plotHeight
  ) {
    if (chartState.hoverIndex != null) {
      chartState.hoverIndex = null;
      renderChart();
    }
    hideTooltip();
    return;
  }

  const ratio = plotWidth > 0 ? (x - padding.left) / plotWidth : 0;
  const nearestIndex = allDates.length === 1
    ? 0
    : Math.max(0, Math.min(allDates.length - 1, Math.round(ratio * (allDates.length - 1))));

  if (chartState.hoverIndex !== nearestIndex) {
    chartState.hoverIndex = nearestIndex;
    renderChart();
  }

  const date = allDates[nearestIndex];
  const rows = activeSeries
    .map((item) => {
      const point = item.pointMap.get(date);
      return point ? { item, point } : null;
    })
    .filter(Boolean);

  if (!rows.length) {
    hideTooltip();
    return;
  }

  tooltip.textContent = '';

  const title = document.createElement('div');
  title.className = 'chart-tooltip__date';
  title.textContent = formatFullDate(date);
  tooltip.appendChild(title);

  for (const { item, point } of rows) {
    const row = document.createElement('div');
    row.className = 'chart-tooltip__row';

    const label = document.createElement('span');
    label.className = 'chart-tooltip__bank';

    const dot = document.createElement('span');
    dot.className = 'chart-tooltip__dot';
    dot.style.background = item.color;

    const name = document.createElement('span');
    name.textContent = item.name;

    label.appendChild(dot);
    label.appendChild(name);

    const value = document.createElement('strong');
    value.className = 'chart-tooltip__value';
    value.textContent = `${formatPrice(point.value, chartState.pair)} ₺`;

    row.appendChild(label);
    row.appendChild(value);
    tooltip.appendChild(row);
  }

  const hint = document.createElement('div');
  hint.className = 'chart-tooltip__hint';
  hint.textContent = 'Günlük kapanış';
  tooltip.appendChild(hint);

  tooltip.classList.remove('hidden');
  positionTooltip(clientX, clientY, tooltip, canvas);
}

function queuePointer(event) {
  pendingPointer = { clientX: event.clientX, clientY: event.clientY };
  if (pointerFrame != null) return;

  pointerFrame = requestAnimationFrame(() => {
    pointerFrame = null;
    if (!pendingPointer) return;
    const pointer = pendingPointer;
    pendingPointer = null;
    processPointer(pointer.clientX, pointer.clientY);
  });
}

function clearHover() {
  pendingPointer = null;
  if (pointerFrame != null) {
    cancelAnimationFrame(pointerFrame);
    pointerFrame = null;
  }
  if (chartState?.hoverIndex != null) {
    chartState.hoverIndex = null;
    renderChart();
  }
  hideTooltip();
}

function bindCanvasInteractions(canvas) {
  if (canvas.dataset.historyBound === '1') return;
  canvas.dataset.historyBound = '1';
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');

  canvas.addEventListener('pointermove', queuePointer);
  canvas.addEventListener('pointerleave', clearHover);
  canvas.addEventListener('pointercancel', clearHover);
}

function drawBankHistory(rawSeries, pair, start, end) {
  const canvas = qs('#range-chart');
  if (!canvas || typeof canvas.getContext !== 'function') return;

  hideTooltip();
  const series = normalizeSeries(rawSeries).filter((item) => item.points.length > 0);

  const currentlyVisible = series.some((item) => visibleBanks.has(item.id));
  if (!currentlyVisible) {
    for (const item of series) visibleBanks.add(item.id);
  }

  chartState = {
    series,
    pair,
    start,
    end,
    hoverIndex: null,
    layout: null
  };

  renderLegend(series);
  bindCanvasInteractions(canvas);
  renderChart();
}

function validateRange(start, end) {
  const startDate = parseDateOnly(start);
  const endDate = parseDateOnly(end);
  if (!startDate || !endDate) return 'Lütfen geçerli başlangıç ve bitiş tarihini seçin.';
  if (startDate > endDate) return 'Başlangıç tarihi bitiş tarihinden büyük olamaz.';

  const today = parseDateOnly(toInputDate(new Date()));
  if (today && endDate > today) return 'Gelecek tarih için geçmiş veri sorgulanamaz.';

  const maxEnd = new Date(startDate);
  maxEnd.setUTCFullYear(maxEnd.getUTCFullYear() + MAX_HISTORY_YEARS);
  if (endDate > maxEnd) return `Tek sorguda en fazla ${MAX_HISTORY_YEARS} yıllık aralık seçilebilir.`;

  return null;
}

async function loadHistoryChart() {
  const start = qs('#range-start-date')?.value || '';
  const end = qs('#range-end-date')?.value || '';
  const pair = qs('#chart-pair')?.value || 'USD/TRY';

  const validationError = validateRange(start, end);
  if (validationError) {
    renderMeta(validationError, true);
    return;
  }

  if (requestController) requestController.abort();
  requestController = new AbortController();

  renderMeta('');
  setBusy(true);

  try {
    const params = new URLSearchParams({ start, end, pair });
    const response = await fetch(`/api/history/banks?${params.toString()}`, {
      cache: 'no-store',
      signal: requestController.signal
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }

    const series = Array.isArray(payload?.series) ? payload.series : [];
    const populated = series.filter((item) => Array.isArray(item?.points) && item.points.length > 0);

    if (!populated.length) {
      drawBankHistory([], pair, start, end);
      renderMeta(`${start} - ${end} aralığında banka geçmiş verisi bulunamadı.`, true);
      return;
    }

    drawBankHistory(series, pair, start, end);

    const issues = series
      .filter((item) => item?.error || item?.warning)
      .map((item) => item?.name)
      .filter(Boolean);

    if (issues.length) {
      renderMeta(`Bazı geçmiş veriler eksik olabilir: ${issues.join(', ')}.`, true);
    } else {
      renderMeta('');
    }
  } catch (error) {
    if (error?.name === 'AbortError') return;

    console.error('[historyDataLoader]', error);
    drawBankHistory([], pair, start, end);
    renderMeta(`Banka geçmiş verileri çekilemedi: ${error?.message || error}`, true);
  } finally {
    requestController = null;
    setBusy(false);
  }
}

function configureDateInputs() {
  const startInput = qs('#range-start-date');
  const endInput = qs('#range-end-date');
  if (!startInput || !endInput) return;

  const todayDate = new Date();
  const oldestDate = new Date(todayDate);
  oldestDate.setFullYear(oldestDate.getFullYear() - MAX_HISTORY_YEARS);

  const today = toInputDate(todayDate);
  const oldest = toInputDate(oldestDate);

  startInput.min = oldest;
  endInput.min = oldest;
  startInput.max = today;
  endInput.max = today;

  if (!endInput.value || endInput.value > today || endInput.value < oldest) {
    endInput.value = today;
  }

  if (!startInput.value || startInput.value > endInput.value || startInput.value < oldest) {
    const defaultStart = new Date(todayDate);
    defaultStart.setDate(defaultStart.getDate() - 30);
    startInput.value = toInputDate(defaultStart < oldestDate ? oldestDate : defaultStart);
  }
}

function ensureTenYearButton() {
  const loadButton = qs('#range-load-btn');
  if (!loadButton || qs('#range-10y-btn')) return;

  const button = document.createElement('button');
  button.id = 'range-10y-btn';
  button.type = 'button';
  button.className = 'btn btn-sm';
  button.textContent = 'Son 10 Yıl';
  button.title = 'Son 10 yıllık banka geçmişini getir';

  button.addEventListener('click', () => {
    const startInput = qs('#range-start-date');
    const endInput = qs('#range-end-date');
    if (!startInput || !endInput) return;

    const todayDate = new Date();
    const oldestDate = new Date(todayDate);
    oldestDate.setFullYear(oldestDate.getFullYear() - MAX_HISTORY_YEARS);

    startInput.value = toInputDate(oldestDate);
    endInput.value = toInputDate(todayDate);
    void loadHistoryChart();
  });

  loadButton.parentElement?.insertBefore(button, loadButton);
}

function bindControls() {
  const loadButton = qs('#range-load-btn');
  if (loadButton && loadButton.dataset.historyBound !== '1') {
    loadButton.dataset.historyBound = '1';
    loadButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      void loadHistoryChart();
    }, true);
  }

  const pairSelect = qs('#chart-pair');
  if (pairSelect && pairSelect.dataset.historyBound !== '1') {
    pairSelect.dataset.historyBound = '1';
    pairSelect.addEventListener('change', () => {
      if (chartState?.series?.length) void loadHistoryChart();
    });
  }
}

function bindResize() {
  if (document.documentElement.dataset.historyResizeBound === '1') return;
  document.documentElement.dataset.historyResizeBound = '1';

  window.addEventListener('resize', () => {
    if (!chartState) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      hideTooltip();
      chartState.hoverIndex = null;
      renderChart();
    }, 120);
  });
}

function renderInitialMessage() {
  const canvas = qs('#range-chart');
  if (!canvas || typeof canvas.getContext !== 'function') return;

  chartState = {
    series: [],
    pair: qs('#chart-pair')?.value || 'USD/TRY',
    start: '',
    end: '',
    hoverIndex: null,
    layout: null
  };

  const setup = setupCanvas(canvas);
  if (!setup) return;
  renderEmptyChart(setup.ctx, setup.cssWidth, setup.cssHeight, 'Tarih aralığını seçip “Grafiği Yükle” butonuna basın.');
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    ensureChartStyles();
    configureDateInputs();
    ensureTenYearButton();
    bindControls();
    bindResize();
    renderInitialMessage();
  });
}
