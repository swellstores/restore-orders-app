// Dates and amounts on the page, in the merchant's local time zone and locale.

// Day boundaries as ISO; the period's end day is included by searching up to the next day's start
export function startOfDay(date: string) {
  return new Date(`${date}T00:00:00`).toISOString();
}
export function startOfNextDay(date: string) {
  const next = new Date(`${date}T00:00:00`);
  next.setDate(next.getDate() + 1);
  return next.toISOString();
}

// YYYY-MM-DD for date inputs
export function localDate(date: Date) {
  return date.toLocaleDateString('en-CA');
}

export function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : '';
}

export function formatMoney(amount: number | null, currency: string | null) {
  if (amount === null) return '';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' }).format(amount);
  } catch {
    return `${amount} ${currency || ''}`.trim();
  }
}
