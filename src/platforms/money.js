// ISO 4217 currencies without minor units, per Meta's currency offset table.
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'COP', 'CRC', 'HUF', 'ISK', 'PYG', 'TWD', 'IDR']);

/** Meta budgets are integers in the currency's minor unit (cents, paise...). */
export function toMinorUnits(amount, currency = 'USD') {
  return ZERO_DECIMAL.has(String(currency).toUpperCase()) ? Math.round(amount) : Math.round(amount * 100);
}

/** Google Ads amounts are in micros (1,000,000 = 1 unit of currency). */
export const toMicros = (amount) => Math.round(amount * 1_000_000);
export const fromMicros = (micros) => Number(micros ?? 0) / 1_000_000;
