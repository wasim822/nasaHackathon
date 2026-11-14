export function fmtKm2(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const digits = a >= 100 ? 0 : a >= 10 ? 1 : 2;
  return `${v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 })} km²`;
}

export function fmtSignedKm2(v: number): string {
  return `${v > 0 ? '+' : v < 0 ? '−' : '±'}${fmtKm2(Math.abs(v))}`;
}

export function fmtPct(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(Math.abs(v) >= 10 ? 0 : 1)}%`;
}

export function fmtCoord(lat: number, lng: number): string {
  return `${Math.abs(lat).toFixed(3)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(3)}°${lng >= 0 ? 'E' : 'W'}`;
}
