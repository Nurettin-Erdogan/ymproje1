const historyRouter = require('../routes/historyRoutes');

const {
  parseDateOnly,
  validateRange,
  splitDateRange,
  parseCanliDovizHistory,
  dedupePoints,
  rangeDays
} = historyRouter._test;

describe('History routes helpers', () => {
  test('exports a valid Express router', () => {
    expect(typeof historyRouter).toBe('function');
  });

  test('parseDateOnly accepts real ISO dates and rejects impossible dates', () => {
    expect(parseDateOnly('2026-09-17')).toBeInstanceOf(Date);
    expect(parseDateOnly('2026-02-30')).toBeNull();
    expect(parseDateOnly('17.09.2026')).toBeNull();
  });

  test('rangeDays is inclusive', () => {
    expect(rangeDays('2026-09-01', '2026-09-01')).toBe(1);
    expect(rangeDays('2026-09-01', '2026-09-10')).toBe(10);
  });

  test('splitDateRange covers the whole interval without overlap or gaps', () => {
    const chunks = splitDateRange('2026-01-01', '2026-12-31', 100);
    expect(chunks[0]).toEqual({ start: '2026-01-01', end: '2026-04-10' });
    expect(chunks.at(-1).end).toBe('2026-12-31');

    for (let i = 0; i < chunks.length; i += 1) {
      expect(rangeDays(chunks[i].start, chunks[i].end)).toBeLessThanOrEqual(100);
      if (i > 0) {
        const previousEnd = new Date(`${chunks[i - 1].end}T00:00:00Z`);
        previousEnd.setUTCDate(previousEnd.getUTCDate() + 1);
        expect(chunks[i].start).toBe(previousEnd.toISOString().slice(0, 10));
      }
    }
  });

  test('parseCanliDovizHistory normalizes OHLC rows and ignores malformed data', () => {
    const timestamp = Math.floor(Date.parse('2026-09-17T12:00:00Z') / 1000);
    const points = parseCanliDovizHistory({
      [timestamp]: '47.10|48.20|46.90|47.80',
      bad: '1|2|3|4',
      [timestamp + 1]: 'invalid'
    });

    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      date: '2026-09-17',
      open: 47.1,
      high: 48.2,
      low: 46.9,
      close: 47.8,
      value: 47.8
    });
  });

  test('dedupePoints keeps the latest point per date and respects requested range', () => {
    const points = dedupePoints([
      { date: '2026-08-31', value: 1 },
      { date: '2026-09-01', value: 2 },
      { date: '2026-09-01', value: 3 },
      { date: '2026-09-02', value: 4 },
      { date: '2026-09-03', value: Number.NaN }
    ], '2026-09-01', '2026-09-02');

    expect(points).toEqual([
      { date: '2026-09-01', value: 3 },
      { date: '2026-09-02', value: 4 }
    ]);
  });

  test('validateRange rejects unsupported pairs and invalid ordering', () => {
    expect(validateRange('2026-09-02', '2026-09-01', 'USD/TRY')).toBe('Geçersiz tarih aralığı.');
    expect(validateRange('2026-09-01', '2026-09-02', 'JPY/TRY')).toBe('Desteklenmeyen parite.');
  });
});
