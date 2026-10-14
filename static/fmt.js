/* Formátování částek, času a dat (česky). */
'use strict';

const NBSP = ' ';
const group3 = s => s.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);

const Fmt = {
  money(v, currency = true) {
    const [int, dec] = Math.abs(Number(v) || 0).toFixed(2).split('.');
    const s = (v < 0 ? '-' : '') + group3(int) + ',' + dec;
    return currency ? s + NBSP + 'Kč' : s;
  },
  money0(v) {
    const n = Math.round(Number(v) || 0);
    return (n < 0 ? '-' : '') + group3(String(Math.abs(n))) + NBSP + 'Kč';
  },
  qty(v) {
    return String(+Number(v).toFixed(4)).replace('.', ',');
  },
  /** 2026-10-14 → 14. 10. 2026 */
  date(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.slice(0, 10).split('-');
    return `${+d}. ${+m}. ${y}`;
  },
  /** Hodiny jako desetinné číslo: 12,5 h */
  hours(secs) {
    const h = (Number(secs) || 0) / 3600;
    return String(+h.toFixed(h >= 100 ? 0 : 1)).replace('.', ',') + NBSP + 'h';
  },
  /** Délka jako hodiny:minuty (1:05), s sekundami 1:05:09 */
  clock(secs, withSeconds = false) {
    const s = Math.max(0, Math.floor(Number(secs) || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const z = n => String(n).padStart(2, '0');
    return withSeconds ? `${h}:${z(m)}:${z(r)}` : `${h}:${z(m)}`;
  },
  /** Čas dne z ISO: 9:05 */
  time(iso) {
    const d = new Date(iso);
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  },
};
