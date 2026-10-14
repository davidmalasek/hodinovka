/* Grafy bez knihoven: sloupce (hodiny po dnech nebo měsících) a vodorovné pruhy. */
'use strict';

const MONTHS = ['leden', 'únor', 'březen', 'duben', 'květen', 'červen', 'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'];
const MONTHS_SHORT = ['led', 'úno', 'bře', 'dub', 'kvě', 'čvn', 'čvc', 'srp', 'zář', 'říj', 'lis', 'pro'];
const WEEKDAYS = ['neděle', 'pondělí', 'úterý', 'středa', 'čtvrtek', 'pátek', 'sobota'];
const WEEKDAYS_SHORT = ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'];
const capitalize = s => s.charAt(0).toUpperCase() + s.slice(1);

/** Hezké maximum osy a krok mezi čárami (0 / 2 h / 4 h …). */
function niceScale(max, ticks = 4) {
  const raw = Math.max(max, 1) / ticks;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * pow).find(s => s >= raw - 1e-9);
  return { top: step * Math.ceil(Math.max(max, 1) / step - 1e-9), step };
}

/** Popisek osy v hodinách: 0,5 h → „30 min“, 2 → „2 h“. */
const hoursTick = h => (h > 0 && h < 1 ? `${Math.round(h * 60)} min` : `${String(+h.toFixed(1)).replace('.', ',')} h`);

/**
 * Sloupcový graf odpracovaných hodin.
 * cols: [{ value (sekundy), label, title, sub, href, now }]
 */
function columnChart(el, { cols }) {
  const hours = cols.map(c => c.value / 3600);
  const peak = Math.max(...hours, 0);
  const { top, step } = niceScale(peak);
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  const pct = v => (v / top) * 100;
  const peakIndex = hours.indexOf(peak);
  const dense = cols.length > 14;

  el.innerHTML = `
    <div class="colchart">
      <div class="plot">
        ${ticks.map(t => `<div class="gridline${t === 0 ? ' base' : ''}" style="bottom:${pct(t)}%"><span class="tick">${t === 0 ? '0' : hoursTick(t)}</span></div>`).join('')}
        <div class="cols" style="grid-template-columns:repeat(${cols.length},minmax(0,1fr))">
          ${cols.map((c, i) => `
            <a class="col" href="${c.href}" data-i="${i}" aria-label="${esc(`${c.title}: ${Fmt.hours(c.value)}`)}">
              <span class="bar${c.value ? '' : ' zero'}" style="--h:${pct(hours[i])}%;--i:${dense ? i / 3 : i}"></span>
              ${i === peakIndex && peak > 0 ? `<span class="cap" style="--h:${pct(hours[i])}%" aria-hidden="true">${hoursTick(peak)}</span>` : ''}
            </a>`).join('')}
        </div>
      </div>
      <div class="xs${dense ? ' dense' : ''}" style="grid-template-columns:repeat(${cols.length},minmax(0,1fr))" aria-hidden="true">${cols.map(c => `<span class="${c.now ? 'now' : ''}">${esc(c.label)}</span>`).join('')}</div>
      <div class="tooltip" aria-hidden="true"><div class="tv"></div><div class="tl"></div></div>
    </div>`;

  const chart = el.querySelector('.colchart');
  const plot = el.querySelector('.plot');
  const tip = el.querySelector('.tooltip');
  const show = col => {
    const i = Number(col.dataset.i);
    tip.querySelector('.tv').textContent = cols[i].value ? `${Fmt.hours(cols[i].value)} · ${Fmt.clock(cols[i].value)}` : '0 h';
    tip.querySelector('.tl').textContent = [cols[i].title, cols[i].sub].filter(Boolean).join(' · ');
    const c = chart.getBoundingClientRect(), p = plot.getBoundingClientRect(), k = col.getBoundingClientRect();
    const half = tip.offsetWidth / 2;
    const x = Math.min(Math.max(k.left - c.left + k.width / 2, half), c.width - half);
    tip.style.left = `${x}px`;
    tip.style.top = `${p.top - c.top + p.height * (1 - hours[i] / top) - 10}px`;
    tip.classList.add('show');
  };
  const hide = () => tip.classList.remove('show');
  el.querySelectorAll('.col').forEach(col => {
    col.addEventListener('pointerenter', () => show(col));
    col.addEventListener('focus', () => show(col));
    col.addEventListener('pointerleave', hide);
    col.addEventListener('blur', hide);
  });
}

/** Vodorovné pruhy: rows = [{ label, value (sekundy), href, color, sub }] */
function barList(el, rows) {
  const max = Math.max(...rows.map(r => r.value), 1);
  el.innerHTML = `<div class="bars">${rows.map((r, i) => `
    <a href="${r.href}">
      <span class="name">${r.color != null ? `<i class="dot pc${r.color}"></i> ` : ''}${esc(r.label)}${r.sub ? ` <span class="muted">${esc(r.sub)}</span>` : ''}</span>
      <span class="val">${Fmt.hours(r.value)}</span>
      <span class="track" aria-hidden="true"><span class="fill" style="--w:${(r.value / max) * 100}%;--i:${i}"></span></span>
    </a>`).join('')}</div>`;
}
