'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const app = $('#app');

const CUSTOMER_FIELDS = ['name', 'ico', 'dic', 'street', 'city', 'zip', 'country', 'email'];
const UNITS = ['hod', 'ks', 'den', 'měs.', 'paušál'];
const ROUNDINGS = [
  [0, 'Přesně (na setiny hodiny)'],
  [6, 'Nahoru na 6 minut (0,1 h)'],
  [15, 'Nahoru na čtvrthodiny'],
  [30, 'Nahoru na půlhodiny'],
  [60, 'Nahoru na celé hodiny'],
];
const GROUPINGS = [['project', 'Za projekt'], ['description', 'Podle popisu']];
const STATES = [['vse', 'Vše'], ['nevyfakturovane', 'Nevyfakturované'], ['vyfakturovane', 'Vyfakturované']];
const DAYS_PAGE = 14; // kolik dní se záznamy se ukáže najednou
const LONG_RUN = 12 * 3600; // časovač běží podezřele dlouho
const PLAY = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.8v8.4c0 .6.7 1 1.2.7l6.4-4.2c.5-.3.5-1 0-1.4L4.2 1.1C3.7.8 3 1.2 3 1.8z"/></svg>';
const BIG_PLAY = '<svg class="i-play" viewBox="0 0 18 18" aria-hidden="true"><path d="M5 2.9v12.2c0 .9 1 1.4 1.7 1l9.6-6.1c.7-.4.7-1.4 0-1.9L6.7 1.9C6 1.5 5 2 5 2.9z"/></svg>';
const BIG_STOP = '<svg class="i-stop" viewBox="0 0 18 18" aria-hidden="true"><rect x="3" y="3" width="12" height="12" rx="2.5"/></svg>';

// ---------- pomocné ----------

let busy = 0; // rozpracované požadavky – mezitím se stránka sama neobnoví
let seenRev = null; // stav dat, který stránka ukazuje (viz živé obnovení)

async function api(path, { method = 'GET', body } = {}) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  let res;
  busy++;
  try {
    res = await fetch('/api/' + path, init);
  } catch {
    throw new Error('Server Hodinovky neběží – stiskni ⌘R, nebo Hodinovku zavři a spusť znovu.');
  } finally {
    busy--;
  }
  if (res.headers.get('X-Rev')) seenRev = res.headers.get('X-Rev'); // změnu udělala tahle stránka
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Chyba ${res.status}`), { status: res.status });
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), isError ? 6000 : 2500);
}

const wait = ms => new Promise(r => setTimeout(r, ms));

/** Spustí akci; tlačítko mezitím zablokuje (a po chvíli ukáže kolečko), chybu ukáže uživateli. */
async function attempt(fn, button) {
  let shownAt = 0;
  let timer;
  if (button) {
    button.disabled = true;
    timer = setTimeout(() => {
      button.classList.add('loading');
      shownAt = performance.now();
    }, 150);
  }
  try {
    return await fn();
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (button) {
      clearTimeout(timer);
      if (shownAt) await wait(Math.max(0, 350 - (performance.now() - shownAt)));
      button.classList.remove('loading');
      button.disabled = false;
    }
  }
}

const z2 = n => String(n).padStart(2, '0');
function isoDate(d = new Date()) {
  return `${d.getFullYear()}-${z2(d.getMonth() + 1)}-${z2(d.getDate())}`;
}
const dayOf = iso => isoDate(new Date(iso)); // místní den, kdy záznam začal
function addDays(iso, days) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return isoDate(d);
}
function weekStart(iso) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return isoDate(d);
}
const hm = d => `${z2(d.getHours())}:${z2(d.getMinutes())}`;
const secsOf = e => Math.max(0, ((e.end ? Date.parse(e.end) : Date.now()) - Date.parse(e.start)) / 1000);
const sumSecs = list => list.reduce((s, e) => s + secsOf(e), 0);
const dur = secs => Fmt.clock(secs, true); // délka práce i se sekundami, ať je vidět, že časovač běží
/** Součet záznamů, který s běžícím časovačem přibývá každou sekundu (viz tick). */
function liveSum(list, tag = 'b', attrs = '') {
  const running = list.some(e => !e.end);
  const base = sumSecs(list.filter(e => e.end));
  return `<${tag} ${attrs}${running ? ` data-live-base="${base}"` : ''}>${dur(sumSecs(list))}</${tag}>`;
}
function parseNum(v) {
  const n = parseFloat(String(v ?? '').replace(/[\s ]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}
const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const decimalInput = v => (v === '' || v == null ? '' : String(v).replace('.', ','));
const byName = (a, b) => a.name.localeCompare(b.name, 'cs', { sensitivity: 'base' });
const plural = (n, one, few, many) => `${n} ${n === 1 ? one : n >= 2 && n <= 4 ? few : many}`;
const setTitle = t => (document.title = t ? `${t} – Hodinovka` : 'Hodinovka');
const contactLabel = c => (c.ico ? `${c.name} (IČO ${c.ico})` : c.name);
const offeredLabel = c => `${contactLabel(c)} — ${c.app_name}`;
const pickCustomer = c => Object.fromEntries(CUSTOMER_FIELDS.map(k => [k, c?.[k] || '']));
const addressLines = p => [p.street, [p.zip, p.city].filter(Boolean).join(' '), p.country].filter(Boolean);

function newUid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64;
  b[8] = (b[8] & 63) | 128;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function dayLabel(iso) {
  const today = isoDate();
  if (iso === today) return 'Dnes';
  if (iso === addDays(today, -1)) return 'Včera';
  const d = new Date(iso + 'T12:00:00');
  const year = d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : '';
  return `${capitalize(WEEKDAYS[d.getDay()])} ${d.getDate()}. ${d.getMonth() + 1}.${year}`;
}

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem('hodinovka.' + key);
    localStorage.setItem('hodinovka.' + key, value ?? '');
  } catch {}
  return null;
}

function field(label, attrs, value = '', { cls = 'c3', type = 'text' } = {}) {
  return `<label class="${cls}">${esc(label)}<input ${attrs} type="${type}" value="${esc(value)}"></label>`;
}
function icoField(attrs, value = '', cls = 'c2') {
  return `<label class="${cls}">IČO<span class="inline"><input ${attrs} value="${esc(value)}" inputmode="numeric" spellcheck="false" placeholder="12345678">` +
    `<button type="button" class="btn" data-ares>Načíst z ARES</button></span></label>`;
}
async function loadAres(ico) {
  if (!ico.trim()) throw new Error('Nejdřív zadej IČO.');
  const data = await api('ares/' + encodeURIComponent(ico.trim()));
  toast('Údaje načteny z ARES');
  return data;
}
/** Pole kontaktu (klient, odběratel). attr = název atributu, kterým se pole poznají. */
function contactFields(c, attr) {
  const a = k => `${attr}="${k}"`;
  return `
    ${field('Název / jméno', `${a('name')} required`, c.name, { cls: 'c4' })}
    ${icoField(a('ico'), c.ico)}
    ${field('Ulice a číslo', a('street'), c.street)}
    ${field('PSČ', `${a('zip')} inputmode="numeric"`, c.zip, { cls: 'c1' })}
    ${field('Město', a('city'), c.city, { cls: 'c2' })}
    ${field('DIČ', `${a('dic')} spellcheck="false"`, c.dic, { cls: 'c2' })}
    ${field('E-mail', `${a('email')} spellcheck="false"`, c.email, { cls: 'c2', type: 'email' })}
    ${field('Stát (jen pokud není ČR)', a('country'), c.country, { cls: 'c2' })}`;
}

// ---------- projekty a klienti (sdílené mezi stránkami) ----------

const refs = { projects: [], clients: [], byProject: new Map(), byClient: new Map() };

async function loadRefs() {
  const [projects, clients] = await Promise.all([api('projects'), api('clients')]);
  refs.projects = projects;
  refs.clients = clients;
  refs.byProject = new Map(projects.map(p => [p.id, p]));
  refs.byClient = new Map(clients.map(c => [c.id, c]));
  return refs;
}
const projectOf = e => refs.byProject.get(e?.project_id);
const clientOf = p => (p ? refs.byClient.get(p.client_id) : undefined);
const colorOf = p => `pc${(p?.color ?? 0) % 8}`;

function projectTag(p, { link = false } = {}) {
  if (!p) return '<span class="proj"><i class="dot"></i>Bez projektu</span>';
  const c = clientOf(p);
  const inner = `<i class="dot ${colorOf(p)}"></i><b>${esc(p.name)}</b>${c ? `<span>${esc(c.name)}</span>` : ''}`;
  return link ? `<a class="proj ${colorOf(p)}" href="#/projekt/${p.id}">${inner}</a>` : `<span class="proj ${colorOf(p)}">${inner}</span>`;
}

function priceLabel(p) {
  if (p.pricing === 'fixed') return `Pevná cena ${Fmt.money0(p.fixed_price)}`;
  return p.rate ? `${Fmt.money0(p.rate)}/h` : 'Bez sazby';
}

/** Možnosti výběru projektu, seskupené podle klientů. Archivované jen když jsou vybrané. */
function projectOptions(selected, { none = 'Bez projektu', allowNew = false } = {}) {
  const groups = new Map();
  for (const p of refs.projects.filter(p => !p.archived || p.id === selected).sort(byName)) {
    const c = clientOf(p);
    const key = c ? c.name : '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const keys = [...groups.keys()].sort((a, b) => (!a) - (!b) || a.localeCompare(b, 'cs'));
  return `<option value="">${esc(none)}</option>` +
    keys.map(k => `<optgroup label="${esc(k || 'Bez klienta')}">${groups.get(k).map(p =>
      `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</optgroup>`).join('') +
    (allowNew ? '<option value="new">＋ Nový projekt…</option>' : '');
}

/** Naposledy použitý projekt (pro další spuštění časovače). */
function lastProject() {
  const id = Number(store('project'));
  const p = refs.byProject.get(id);
  return p && !p.archived ? id : null;
}
const rememberProject = id => store('project', id ? String(id) : '');

/** Klient podle textu z políčka: existující, převzatý z jiné aplikace, nebo nový. Vrátí id nebo null. */
async function resolveClient(text, offered) {
  text = text.trim();
  if (!text) return null;
  const own = refs.clients.find(c => contactLabel(c) === text) || refs.clients.find(c => c.name.toLowerCase() === text.toLowerCase());
  if (own) return own.id;
  const peer = offered.find(c => offeredLabel(c) === text || contactLabel(c) === text);
  const created = await api('clients', { method: 'POST', body: peer ? { ...pickCustomer(peer), uid: peer.uid } : { name: text } });
  return created.id;
}

// ---------- časovač ----------

const Timer = {
  entry: null,
  set(entry) {
    this.entry = entry || null;
    drawPill();
    tellNative();
  },
  async refresh() {
    try {
      const { entry } = await api('timer');
      const changed = (entry?.id ?? null) !== (this.entry?.id ?? null);
      this.set(entry);
      if (changed && currentSection() === 'cas') router(false);
    } catch {}
  },
  async start(values) {
    const { entry } = await api('timer/start', { method: 'POST', body: values });
    this.set(entry);
    return entry;
  },
  async stop() {
    const { stopped } = await api('timer/stop', { method: 'POST', body: {} });
    this.set(null);
    return stopped;
  },
  elapsed() {
    return this.entry ? secsOf(this.entry) : 0;
  },
};

const entryTitle = e => e.description || projectOf(e)?.name || 'Bez popisu';
const currentSection = () => (location.hash.slice(2).split(/[/?]/)[0] || 'cas');

function drawPill() {
  const e = Timer.entry;
  $('#pill').hidden = !e || currentSection() === 'cas';
  if (e) $('#pill-label').textContent = entryTitle(e);
  tick();
}

function tick() {
  const t = dur(Timer.elapsed());
  $$('[data-elapsed]').forEach(el => (el.textContent = Timer.entry ? t : '0:00:00'));
  $$('[data-running-dur]').forEach(el => (el.textContent = t));
  $$('[data-live-base]').forEach(el => (el.textContent = dur(Number(el.dataset.liveBase) + Timer.elapsed())));
}
// Tiká těsně po každé celé sekundě od spuštění časovače, ať čas poskakuje pravidelně a nepřeskočí sekundu.
(function loop() {
  tick();
  const start = Timer.entry ? Date.parse(Timer.entry.start) : 0;
  setTimeout(loop, 1000 - ((Date.now() - start) % 1000) + 20);
})();

/** Okno aplikace ukazuje běžící čas i v horní liště Macu. */
function tellNative() {
  const handler = window.webkit?.messageHandlers?.hodinovka;
  if (!handler) return;
  const e = Timer.entry;
  handler.postMessage(e
    ? { running: true, start: Date.parse(e.start), title: e.description || '', project: projectOf(e)?.name || '' }
    : { running: false });
}

/** Volá okno aplikace (menu v horní liště Macu). */
window.hodinovka = {
  toggle: () => attempt(async () => {
    if (Timer.entry) {
      const stopped = await Timer.stop();
      toast(`Zapsáno ${dur(secsOf(stopped))}`);
    } else {
      await Timer.start({ project_id: lastProject() });
      toast('Časovač běží');
    }
    router(false);
  }),
  refresh: () => Timer.refresh(),
};

$('#pill-stop').onclick = e => attempt(async () => {
  const stopped = await Timer.stop();
  toast(`Zapsáno ${dur(secsOf(stopped))}`);
  router(false);
}, e.currentTarget);
window.addEventListener('focus', () => Timer.refresh());
setInterval(() => document.hidden || Timer.refresh(), 60000);

// ---------- záznamy: dialog ----------

const roundTo5 = d => new Date(Math.round(d.getTime() / 300e3) * 300e3);

/** Přidání nebo úprava záznamu. Vrátí true, když se něco změnilo. */
function entryDialog(entry, billing) {
  const running = entry && !entry.end;
  const now = new Date();
  const start = entry ? new Date(entry.start) : roundTo5(new Date(now - 3600e3));
  const end = entry?.end ? new Date(entry.end) : roundTo5(now);
  const longOne = entry?.end && end - start >= 864e5; // přes 24 hodin: konec potřebuje vlastní datum
  const dialog = document.createElement('dialog');
  dialog.className = 'wide';
  dialog.setAttribute('aria-labelledby', 'entry-title');
  dialog.innerHTML = `
    <form novalidate>
      <h2 id="entry-title">${!entry ? 'Přidat záznam' : running ? 'Běžící záznam' : 'Upravit záznam'}</h2>
      ${billing ? `<p class="hint" style="margin:0">Záznam je vyfakturovaný${billing.invoice ? ` (faktura ${esc(billing.invoice.number)})` : ''}. Změna se na faktuře neprojeví.</p>` : ''}
      <div class="grid">
        <label class="c6">Popis<input name="description" value="${esc(entry?.description)}" placeholder="Na čem jsi pracoval?" autocomplete="off"></label>
        <label class="c6">Projekt<select name="project_id">${projectOptions(entry ? entry.project_id : lastProject())}</select></label>
        ${field('Datum', 'name="date" required', isoDate(start), { cls: 'c2', type: 'date' })}
        ${field('Od', 'name="from" required', hm(start), { cls: longOne ? 'c1' : 'c2', type: 'time' })}
        ${longOne ? field('Do (datum)', 'name="end_date"', isoDate(end), { cls: 'c2', type: 'date' }) : ''}
        ${running ? '<label class="c2">Do<input value="běží" disabled></label>' : field('Do', 'name="to" required', hm(end), { cls: longOne ? 'c1' : 'c2', type: 'time' })}
      </div>
      <p class="duration-note" id="duration"></p>
      <div class="form-actions">
        ${entry ? '<button type="button" class="btn ghost danger" data-delete>Smazat…</button>' : ''}
        <button type="button" class="btn" data-cancel>Zrušit</button>
        <button type="submit" class="btn primary">Uložit</button>
      </div>
    </form>`;
  document.body.append(dialog);
  const form = $('form', dialog);
  const els = form.elements;

  // Políčka mají jen minuty: když se čas nezměnil, zůstanou i sekundy, ať se délka uložením nezkrátí.
  const kept = (orig, d) => (orig && Math.floor(Date.parse(orig) / 6e4) === Math.floor(d.getTime() / 6e4) ? new Date(orig) : d);
  const times = () => {
    const s = new Date(`${els.date.value}T${els.from.value}`);
    if (running) return { start: kept(entry.start, s), end: null };
    let e = new Date(`${els.end_date?.value || els.date.value}T${els.to.value}`);
    let nextDay = false;
    if (!els.end_date && e < s) {
      e = new Date(e.getTime() + 864e5);
      nextDay = true;
    }
    return { start: kept(entry?.start, s), end: kept(entry?.end, e), nextDay };
  };
  const showDuration = () => {
    const t = times();
    if (Number.isNaN(t.start.getTime()) || (t.end && Number.isNaN(t.end.getTime()))) return ($('#duration', dialog).textContent = '');
    const secs = ((t.end || new Date()) - t.start) / 1000;
    $('#duration', dialog).textContent = secs < 0 ? 'Konec je dřív než začátek.'
      : `Délka ${dur(secs)}${t.nextDay ? ' · končí další den' : ''}${running ? ' (běží dál)' : ''}`;
  };
  form.addEventListener('input', showDuration);
  showDuration();

  return new Promise(resolve => {
    const close = changed => {
      dialog.close();
      dialog.remove();
      resolve(changed);
    };
    dialog.addEventListener('cancel', e => {
      e.preventDefault();
      close(false);
    });
    $('[data-cancel]', dialog).onclick = () => close(false);
    const del = $('[data-delete]', dialog);
    if (del) del.onclick = () => attempt(async () => {
      if (!confirm(`Smazat záznam${entry.description ? ` „${entry.description}“` : ''}?`)) return;
      await api('entries/' + entry.id, { method: 'DELETE' });
      if (running) Timer.set(null);
      toast('Záznam smazán');
      close(true);
    }, del);
    form.onsubmit = e => {
      e.preventDefault();
      attempt(async () => {
        const t = times();
        if (Number.isNaN(t.start.getTime()) || (t.end && Number.isNaN(t.end.getTime()))) throw new Error('Vyplň datum a čas.');
        const body = {
          description: els.description.value,
          project_id: els.project_id.value ? Number(els.project_id.value) : null,
          start: t.start.toISOString(),
        };
        if (!running) body.end = t.end.toISOString();
        const saved = await api(entry ? `entries/${entry.id}` : 'entries', { method: entry ? 'PUT' : 'POST', body });
        if (running) Timer.set(saved);
        if (body.project_id) rememberProject(body.project_id);
        toast(entry ? 'Záznam uložen' : 'Záznam přidán');
        close(true);
      }, e.submitter);
    };
    dialog.showModal();
    if (!entry) els.description.focus();
  });
}

// ---------- záznamy: seznam po dnech ----------

const isPickable = e => Boolean(e.end) && !e.billing_id;

function entryRow(e, billings, selectable) {
  const b = e.billing_id ? billings.get(e.billing_id) : null;
  const billed = b ? `<a class="billed-tag" href="#/vyuctovani/${esc(b.uid)}">${b.invoice ? `Faktura ${esc(b.invoice_state?.number || b.invoice.number)}` : 'Vyfakturováno'}</a>` : '';
  const range = `${Fmt.time(e.start)} – ${e.end ? Fmt.time(e.end) : 'teď'}`;
  return `
    <tr class="entry${e.end ? '' : ' running'}${b ? ' billed' : ''}" data-entry="${e.id}">
      ${selectable ? `<td class="sel">${isPickable(e) ? `<label><input type="checkbox" data-select="${e.id}" aria-label="Vybrat záznam ${esc(e.description)}"></label>` : ''}</td>` : ''}
      <td>
        <div class="e-desc">${e.description ? esc(e.description) : '<span class="muted">Bez popisu</span>'}</div>
        <div class="e-meta">${projectTag(projectOf(e))}${billed}${e.end ? '' : '<span class="running-tag">Běží</span>'}<span class="show-sm muted">${range}</span></div>
      </td>
      <td class="e-range hide-sm">${range}</td>
      <td class="num e-dur"${e.end ? '' : ' data-running-dur'}>${dur(secsOf(e))}</td>
      <td class="e-act">${e.end ? `<button type="button" class="icon-btn" data-continue="${e.id}" title="Pokračovat" aria-label="Pokračovat v práci na ${esc(entryTitle(e))}">${PLAY}</button>` : ''}</td>
    </tr>`;
}

function groupByDay(rows) {
  const days = new Map();
  for (const e of rows.slice().sort((a, b) => b.start.localeCompare(a.start))) {
    const d = dayOf(e.start);
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(e);
  }
  return [...days.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}

let daysShown = { hash: '', count: DAYS_PAGE }; // kolik dní bylo vidět – po obnovení stránky zůstane

/**
 * Seznam záznamů po dnech s výběrem, hromadnými akcemi a úpravou kliknutím.
 * Vrátí funkci, která seznam překreslí s jinými řádky (filtr).
 */
function mountEntries(el, rows, billings, { empty = 'Zatím žádné záznamy.' } = {}) {
  const selected = new Set();
  let shown = daysShown.hash === location.hash ? daysShown.count : DAYS_PAGE;
  el.innerHTML = `
    <div data-days></div>
    <div class="bulkbar" hidden>
      <span class="count"></span>
      <button type="button" class="btn ghost" data-bulk="clear">Zrušit výběr</button>
      <button type="button" class="btn ghost danger" data-bulk="delete">Smazat…</button>
      <button type="button" class="btn primary" data-bulk="bill">Vyfakturovat…</button>
    </div>`;
  const daysEl = $('[data-days]', el);
  const bar = $('.bulkbar', el);
  const chosen = () => rows.filter(e => selected.has(e.id));

  const updateBulk = () => {
    bar.hidden = selected.size === 0;
    $('.count', bar).textContent = `${plural(selected.size, 'záznam', 'záznamy', 'záznamů')} · ${dur(sumSecs(chosen()))}`;
    $$('tr[data-entry]', daysEl).forEach(tr => tr.classList.toggle('selected', selected.has(Number(tr.dataset.entry))));
    $$('[data-select-day]', daysEl).forEach(box => {
      const ids = $$('[data-select]', box.closest('.day')).map(b => Number(b.dataset.select));
      box.checked = ids.length > 0 && ids.every(id => selected.has(id));
      box.indeterminate = !box.checked && ids.some(id => selected.has(id));
    });
  };
  const draw = () => {
    for (const id of [...selected]) if (!rows.some(r => r.id === id && isPickable(r))) selected.delete(id);
    const days = groupByDay(rows);
    daysEl.innerHTML = rows.length
      ? days.slice(0, shown).map(([day, list]) => `
        <section class="day">
          <div class="day-head">
            ${list.some(isPickable) ? `<label title="Vybrat nevyfakturované"><input type="checkbox" data-select-day aria-label="Vybrat nevyfakturované záznamy: ${esc(dayLabel(day))}"></label>` : ''}
            <h2>${esc(dayLabel(day))}</h2>
            ${liveSum(list, 'span', 'class="total"')}
          </div>
          <div class="table-card"><table class="list entries"><tbody>${list.map(e => entryRow(e, billings, true)).join('')}</tbody></table></div>
        </section>`).join('') + (days.length > shown ? '<div class="more"><button type="button" class="btn" data-more>Zobrazit starší</button></div>' : '')
      : `<div class="card empty">${empty}</div>`;
    $$('[data-select]', daysEl).forEach(b => (b.checked = selected.has(Number(b.dataset.select))));
    updateBulk();
  };

  daysEl.addEventListener('change', e => {
    if (e.target.matches('[data-select-day]')) {
      $$('[data-select]', e.target.closest('.day')).forEach(b => {
        b.checked = e.target.checked;
        e.target.checked ? selected.add(Number(b.dataset.select)) : selected.delete(Number(b.dataset.select));
      });
    } else if (e.target.matches('[data-select]')) {
      const id = Number(e.target.dataset.select);
      e.target.checked ? selected.add(id) : selected.delete(id);
    }
    updateBulk();
  });
  daysEl.addEventListener('click', e => {
    const cont = e.target.closest('[data-continue]');
    if (cont) {
      const src = rows.find(r => r.id === Number(cont.dataset.continue));
      return attempt(async () => {
        await Timer.start({ description: src.description, project_id: src.project_id });
        toast('Časovač běží');
        router(false);
      }, cont);
    }
    if (e.target.closest('[data-more]')) {
      shown += DAYS_PAGE;
      daysShown = { hash: location.hash, count: shown };
      return draw();
    }
    const tr = e.target.closest('tr[data-entry]');
    if (!tr || e.target.closest('a, button, input, label, select, .sel')) return;
    const entry = rows.find(r => r.id === Number(tr.dataset.entry));
    entryDialog(entry, entry.billing_id ? billings.get(entry.billing_id) : null).then(changed => changed && router(false));
  });
  bar.addEventListener('click', e => {
    const act = e.target.closest('[data-bulk]')?.dataset.bulk;
    if (act === 'clear') {
      selected.clear();
      draw();
    } else if (act === 'delete') {
      deleteEntries(chosen(), e.target.closest('button'));
    } else if (act === 'bill') {
      location.hash = `#/vyfakturovat?zaznamy=${[...selected].join(',')}`;
    }
  });
  draw();
  return newRows => {
    rows = newRows;
    shown = DAYS_PAGE;
    draw();
  };
}

async function deleteEntries(list, button) {
  const what = list.length === 1
    ? `záznam${list[0].description ? ` „${list[0].description}“` : ''}`
    : plural(list.length, 'záznam', 'záznamy', 'záznamů');
  if (!confirm(`Smazat ${what} (${dur(sumSecs(list))})?\n\nSmazané záznamy nejdou vrátit.`)) return;
  await attempt(async () => {
    await api('entries/delete', { method: 'POST', body: { entry_ids: list.map(e => e.id) } });
    toast(list.length === 1 ? 'Záznam smazán' : plural(list.length, 'záznam smazán', 'záznamy smazány', 'záznamů smazáno'));
    router(false);
  }, button);
}

const billingMap = billings => new Map(billings.map(b => [b.id, b]));

// ---------- čas ----------

async function viewTime(params) {
  const [entries, billings] = await Promise.all([api('entries'), api('billings'), loadRefs()]);
  Timer.set(entries.find(e => !e.end) || null);
  return () => renderTime(params, entries, billings);
}

function renderTime(params, entries, billings) {
  setTitle('Čas');
  const f = {
    stav: STATES.some(([k]) => k === params.get('stav')) ? params.get('stav') : 'vse',
    projekt: params.get('projekt') || '',
    q: params.get('q') || '',
    od: params.get('od') || '',
    do: params.get('do') || '',
  };
  const today = isoDate();
  const week = weekStart(today);
  const unbilled = entries.filter(isPickable);
  const projectsSorted = refs.projects.slice().sort(byName);

  app.innerHTML = `
    <div class="page-head">
      <h1>Čas</h1>
      <div class="actions"><button type="button" class="btn" id="add">Přidat ručně</button></div>
    </div>
    <div id="long"></div>
    <section class="card tracker" id="tracker">
      <input class="t-desc" id="t-desc" placeholder="Na čem pracuješ?" aria-label="Na čem pracuješ" autocomplete="off" spellcheck="true">
      <select id="t-project" aria-label="Projekt">${projectOptions(null, { allowNew: true })}</select>
      <span class="t-time" data-elapsed aria-live="off">0:00:00</span>
      <button type="button" class="play" id="t-toggle">${BIG_PLAY}${BIG_STOP}</button>
    </section>
    <div class="summary">
      <span>Dnes ${liveSum(entries.filter(e => dayOf(e.start) === today))}</span>
      <span>Tento týden ${liveSum(entries.filter(e => dayOf(e.start) >= week))}</span>
      <a href="#/cas?stav=nevyfakturovane">Nevyfakturováno <b>${dur(sumSecs(unbilled))}</b></a>
    </div>
    <div class="toolbar">
      <div class="segmented" role="group" aria-label="Stav">${STATES.map(([k, label]) => `<button type="button" data-stav="${k}" aria-pressed="false">${label}</button>`).join('')}</div>
      <span class="spacer"></span>
      <select id="f-project" aria-label="Projekt"><option value="">Všechny projekty</option>${projectsSorted.map(p => `<option value="${p.id}">${esc(p.name)}${clientOf(p) ? ` · ${esc(clientOf(p).name)}` : ''}</option>`).join('')}</select>
      <input id="search" type="search" placeholder="Hledat…" aria-label="Hledat v popisu, projektu a klientovi" autocomplete="off" spellcheck="false">
      <a class="btn" id="csv" href="/api/export/csv" download>Výkaz CSV</a>
    </div>
    <div class="chips" id="chips"></div>
    <div id="entries"></div>`;

  // --- časovač ---
  const tracker = $('#tracker');
  const desc = $('#t-desc');
  const proj = $('#t-project');
  const toggle = $('#t-toggle');
  const sync = () => {
    const e = Timer.entry;
    tracker.classList.toggle('on', Boolean(e));
    toggle.setAttribute('aria-label', e ? 'Zastavit časovač' : 'Spustit časovač');
    toggle.title = e ? 'Zastavit' : 'Spustit';
    if (e) {
      desc.value = desc.defaultValue = e.description; // uložený popis není rozepsaný (viz živé obnovení)
      proj.value = e.project_id ?? '';
    } else {
      proj.value = lastProject() ?? '';
    }
    $('#long').innerHTML = e && Timer.elapsed() > LONG_RUN
      ? `<div class="notice">Časovač běží už ${Fmt.hours(Timer.elapsed())}. Jestli jsi ho zapomněl vypnout, zastav ho a v záznamu oprav konec.</div>` : '';
    tick();
  };
  sync();

  let pending = {};
  let saveTimer;
  const flush = async () => {
    clearTimeout(saveTimer);
    const values = pending;
    pending = {};
    if (!Timer.entry || !Object.keys(values).length) return;
    Timer.set(await api('entries/' + Timer.entry.id, { method: 'PUT', body: values }));
    if ('description' in values) desc.defaultValue = values.description;
  };
  const saveRunning = values => {
    Object.assign(Timer.entry, values);
    Object.assign(pending, values);
    drawPill();
    tellNative();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => attempt(flush), 500);
  };
  desc.addEventListener('input', () => Timer.entry && saveRunning({ description: desc.value }));
  desc.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    Timer.entry ? desc.blur() : toggle.click();
  });
  proj.addEventListener('change', () => {
    if (proj.value === 'new') {
      proj.value = Timer.entry?.project_id ?? lastProject() ?? '';
      location.hash = '#/projekt/novy?zpet=cas';
      return;
    }
    const pid = proj.value ? Number(proj.value) : null;
    rememberProject(pid);
    if (Timer.entry) saveRunning({ project_id: pid });
  });
  toggle.onclick = () => attempt(async () => {
    if (Timer.entry) {
      await flush();
      const stopped = await Timer.stop();
      toast(`Zapsáno ${dur(secsOf(stopped))}`);
    } else {
      const pid = proj.value && proj.value !== 'new' ? Number(proj.value) : null;
      await Timer.start({ description: desc.value, project_id: pid });
      rememberProject(pid);
    }
    router(false);
  }, toggle);
  $('#add').onclick = () => entryDialog(null).then(changed => changed && router(false));

  // --- seznam a filtry ---
  const matches = e => {
    if (f.stav === 'nevyfakturovane' && e.billing_id) return false;
    if (f.stav === 'vyfakturovane' && !e.billing_id) return false;
    if (f.projekt && String(e.project_id) !== f.projekt) return false;
    const day = dayOf(e.start);
    if ((f.od && day < f.od) || (f.do && day > f.do)) return false;
    const q = f.q.toLowerCase();
    if (!q) return true;
    const p = projectOf(e);
    return [e.description, p?.name, clientOf(p)?.name].some(v => (v || '').toLowerCase().includes(q));
  };
  const csvUrl = () => {
    const p = new URLSearchParams();
    if (f.stav !== 'vse') p.set('stav', f.stav);
    for (const k of ['projekt', 'od', 'do']) if (f[k]) p.set(k, f[k]);
    return `/api/export/csv${p.toString() ? '?' + p : ''}`;
  };
  const syncUrl = () => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v && !(k === 'stav' && v === 'vse')) p.set(k, v);
    setHash(`#/cas${p.toString() ? '?' + p : ''}`);
  };
  const drawFilters = () => {
    $$('[data-stav]').forEach(b => {
      b.classList.toggle('on', b.dataset.stav === f.stav);
      b.setAttribute('aria-pressed', String(b.dataset.stav === f.stav));
    });
    const range = f.od || f.do ? (f.od === f.do ? Fmt.date(f.od) : `${f.od ? Fmt.date(f.od) : '…'} – ${f.do ? Fmt.date(f.do) : '…'}`) : '';
    $('#chips').innerHTML = range ? `<span class="chip">${esc(range)}<a href="#" data-clear-range aria-label="Zrušit omezení na období">×</a></span>` : '';
    $('#csv').href = csvUrl();
  };
  $('#f-project').value = f.projekt;
  $('#search').value = f.q;
  drawFilters();
  const redraw = mountEntries($('#entries'), entries.filter(matches), billingMap(billings), {
    empty: entries.length ? 'Žádný záznam neodpovídá filtru.' : 'Zatím tu nejsou žádné záznamy.<br>Napiš nahoře, na čem pracuješ, a spusť časovač.',
  });
  const update = () => {
    syncUrl();
    drawFilters();
    redraw(entries.filter(matches));
  };
  $$('[data-stav]').forEach(b => (b.onclick = () => {
    f.stav = b.dataset.stav;
    update();
  }));
  $('#f-project').onchange = e => {
    f.projekt = e.target.value;
    update();
  };
  $('#search').oninput = e => {
    f.q = e.target.value.trim();
    update();
  };
  $('#chips').onclick = e => {
    if (!e.target.closest('[data-clear-range]')) return;
    e.preventDefault();
    f.od = f.do = '';
    update();
  };
}

// ---------- přehled ----------

const PERIODS = [['tyden', 'Týden'], ['mesic', 'Měsíc'], ['rok', 'Rok']];

function periodOf(kind, anchor) {
  const [y, m] = anchor.split('-').map(Number);
  if (kind === 'rok') {
    return { from: `${y}-01-01`, to: `${y}-12-31`, prev: `${y - 1}-01-01`, next: `${y + 1}-01-01`, label: String(y) };
  }
  if (kind === 'mesic') {
    return {
      from: `${y}-${z2(m)}-01`, to: isoDate(new Date(y, m, 0)),
      prev: isoDate(new Date(y, m - 2, 1)), next: isoDate(new Date(y, m, 1)),
      label: `${capitalize(MONTHS[m - 1])} ${y}`,
    };
  }
  const from = weekStart(anchor);
  const to = addDays(from, 6);
  const [fd, td] = [new Date(from + 'T12:00:00'), new Date(to + 'T12:00:00')];
  const label = fd.getMonth() === td.getMonth()
    ? `${fd.getDate()}.–${td.getDate()}. ${td.getMonth() + 1}. ${td.getFullYear()}`
    : `${fd.getDate()}. ${fd.getMonth() + 1}. – ${Fmt.date(to)}`;
  return { from, to, prev: addDays(from, -7), next: addDays(from, 7), label };
}

async function viewDashboard(params) {
  const [entries, billings] = await Promise.all([api('entries'), api('billings'), loadRefs()]);
  return () => {
    setTitle('Přehled');
    const today = isoDate();
    const kind = PERIODS.some(([k]) => k === params.get('obdobi')) ? params.get('obdobi') : 'tyden';
    const anchor = /^\d{4}-\d{2}-\d{2}$/.test(params.get('od') || '') ? params.get('od') : today;
    const per = periodOf(kind, anchor);
    const isNow = today >= per.from && today <= per.to;
    const inPeriod = entries.filter(e => dayOf(e.start) >= per.from && dayOf(e.start) <= per.to);
    const link = (k, a) => `#/prehled?obdobi=${k}&od=${a}`;

    if (!entries.length) {
      app.innerHTML = `
        <div class="page-head"><h1>Přehled</h1></div>
        <div class="card empty">Zatím tu nic není.<br><a class="btn primary" href="#/cas">Spustit časovač</a></div>`;
      return;
    }

    const total = sumSecs(inPeriod);
    const hourly = inPeriod.filter(e => projectOf(e)?.pricing === 'hourly');
    const value = hourly.reduce((s, e) => s + secsOf(e) / 3600 * projectOf(e).rate, 0);
    const hasFixed = inPeriod.some(e => projectOf(e)?.pricing === 'fixed');
    const unbilledAmount = refs.projects.reduce((s, p) => s + p.unbilled_amount, 0);
    const unbilledSecs = sumSecs(entries.filter(isPickable));
    const billedIn = billings.filter(b => dayOf(b.created_at) >= per.from && dayOf(b.created_at) <= per.to);

    // sloupce
    let cols;
    if (kind === 'rok') {
      cols = MONTHS_SHORT.map((label, i) => {
        const key = `${per.from.slice(0, 4)}-${z2(i + 1)}`;
        const list = inPeriod.filter(e => dayOf(e.start).startsWith(key));
        return { value: sumSecs(list), label, title: capitalize(MONTHS[i]), sub: plural(list.length, 'záznam', 'záznamy', 'záznamů'), href: link('mesic', `${key}-01`), now: today.startsWith(key) };
      });
    } else {
      cols = [];
      for (let d = per.from; d <= per.to; d = addDays(d, 1)) {
        const list = inPeriod.filter(e => dayOf(e.start) === d);
        const date = new Date(d + 'T12:00:00');
        cols.push({
          value: sumSecs(list),
          label: kind === 'tyden' ? WEEKDAYS_SHORT[date.getDay()] : String(date.getDate()),
          title: `${capitalize(WEEKDAYS[date.getDay()])} ${date.getDate()}. ${date.getMonth() + 1}.`,
          sub: plural(list.length, 'záznam', 'záznamy', 'záznamů'),
          href: `#/cas?od=${d}&do=${d}`,
          now: d === today,
        });
      }
    }

    // projekty a klienti za období
    const top = (groups, max = 6) => {
      let rows = [...groups.values()].sort((a, b) => b.value - a.value);
      if (rows.length > max + 1) {
        const rest = rows.slice(max);
        rows = [...rows.slice(0, max), { label: `Ostatní (${rest.length})`, value: rest.reduce((s, r) => s + r.value, 0), href: '#/projekty' }];
      }
      return rows;
    };
    const byProject = new Map();
    const byClient = new Map();
    for (const e of inPeriod) {
      const p = projectOf(e);
      const c = clientOf(p);
      const pk = p ? p.id : 0;
      const g = byProject.get(pk) || { label: p ? p.name : 'Bez projektu', sub: c?.name, color: p ? p.color % 8 : null, value: 0, href: p ? `#/projekt/${p.id}` : `#/cas?od=${per.from}&do=${per.to}` };
      g.value += secsOf(e);
      byProject.set(pk, g);
      const ck = c ? c.id : 0;
      const h = byClient.get(ck) || { label: c ? c.name : 'Bez klienta', value: 0, href: c ? `#/klient/${c.id}` : '#/projekty' };
      h.value += secsOf(e);
      byClient.set(ck, h);
    }

    const recent = billings.slice(0, 5);
    app.innerHTML = `
      <div class="page-head">
        <div>
          <h1>Přehled</h1>
          <p class="subtitle">${esc(per.label)}</p>
        </div>
        <div class="actions">
          <nav class="segmented" aria-label="Období">${PERIODS.map(([k, label]) => `<a href="${link(k, isNow ? today : per.from)}" class="${k === kind ? 'on' : ''}" ${k === kind ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
          <a class="btn" href="${link(kind, per.prev)}" aria-label="Předchozí období">‹</a>
          ${isNow ? '' : `<a class="btn" href="${link(kind, today)}">Teď</a>`}
          <a class="btn" href="${link(kind, per.next)}" aria-label="Další období">›</a>
        </div>
      </div>
      <div class="kpis">
        <div class="kpi"><div class="k">Odpracováno</div><div class="v">${Fmt.hours(total)}</div><div class="d">${dur(total)} · ${plural(inPeriod.length, 'záznam', 'záznamy', 'záznamů')}</div></div>
        <div class="kpi"><div class="k">Hodnota práce</div><div class="v">${Fmt.money0(value)}</div><div class="d">podle hodinových sazeb${hasFixed ? ', bez pevných cen' : ''}</div></div>
        <a class="kpi" href="#/cas?stav=nevyfakturovane"><div class="k">Nevyfakturováno</div><div class="v">${Fmt.money0(unbilledAmount)}</div><div class="d">${Fmt.hours(unbilledSecs)} práce celkem</div></a>
        <a class="kpi" href="#/vyuctovani"><div class="k">Vyfakturováno</div><div class="v">${Fmt.money0(billedIn.reduce((s, b) => s + b.total, 0))}</div><div class="d">${plural(billedIn.length, 'vyúčtování', 'vyúčtování', 'vyúčtování')} za období</div></a>
      </div>
      <div class="dash-grid">
        <section class="card">
          <div class="card-head"><h2>${kind === 'rok' ? 'Hodiny po měsících' : 'Hodiny po dnech'}</h2><span class="muted">${esc(per.label)}</span></div>
          <div id="cols"></div>
        </section>
        <section class="card">
          <div class="card-head"><h2>Projekty</h2><span class="muted">${esc(per.label)}</span></div>
          <div id="projects">${byProject.size ? '' : '<p class="muted">V tomhle období nic.</p>'}</div>
        </section>
        <section class="card">
          <div class="card-head"><h2>Klienti</h2><span class="muted">${esc(per.label)}</span></div>
          <div id="clients">${byClient.size ? '' : '<p class="muted">V tomhle období nic.</p>'}</div>
        </section>
        <section class="table-card">
          <div class="card-head"><h2>Poslední vyúčtování</h2><a class="btn ghost" href="#/vyuctovani">Vše</a></div>
          ${recent.length ? billingTable(recent, { compact: true }) : '<div class="empty" style="padding:32px 16px">Zatím nic. Vyber na stránce Čas záznamy a dej Vyfakturovat.</div>'}
        </section>
      </div>`;
    columnChart($('#cols'), { cols });
    if (byProject.size) barList($('#projects'), top(byProject));
    if (byClient.size) barList($('#clients'), top(byClient));
  };
}

// ---------- vyúčtování ----------

function billingStatus(b) {
  if (!b.invoice) return ['manual', 'Bez faktury'];
  const s = b.invoice_state?.status;
  if (s === 'paid') return ['paid', 'Zaplaceno'];
  if (s === 'cancelled') return ['cancelled', 'Stornováno'];
  if (s === 'deleted') return ['overdue', 'Faktura smazána'];
  if (s === 'issued') return b.invoice_state.due_date && b.invoice_state.due_date < isoDate() ? ['overdue', 'Po splatnosti'] : ['issued', 'Čeká na platbu'];
  return ['issued', 'Vystaveno'];
}
const statusLabel = b => {
  const [cls, text] = billingStatus(b);
  return `<span class="status ${cls}">${text}</span>`;
};
const invoiceLink = b => `${b.invoice.scheme || b.invoice.app}://faktura/${b.invoice_state?.id ?? b.invoice.id}`;
const billingTitle = b => (b.invoice ? `Faktura ${b.invoice_state?.number || b.invoice.number}` : `Vyúčtování ${Fmt.date(b.created_at)}`);

function billingTable(rows, { compact = false } = {}) {
  const name = b => (b.invoice ? `Faktura ${esc(b.invoice_state?.number || b.invoice.number)}` : 'Bez faktury');
  if (compact) {
    return `
      <div class="table-scroll"><table class="list">
        <tbody>${rows.map(b => `
          <tr data-href="#/vyuctovani/${esc(b.uid)}">
            <td><a href="#/vyuctovani/${esc(b.uid)}" class="strong" style="color:inherit">${esc(b.customer?.name || name(b))}</a>
              <div class="muted" style="font-size:13px">${Fmt.date(b.created_at)} · ${name(b)}</div></td>
            <td class="num"><span class="strong">${Fmt.money0(b.total)}</span><div>${statusLabel(b)}</div></td>
          </tr>`).join('')}
        </tbody>
      </table></div>`;
  }
  return `
    <div class="table-scroll"><table class="list">
      <thead><tr><th>Datum</th><th>Odběratel</th><th class="hide-sm">Faktura</th><th class="num hide-sm">Hodin</th><th class="num">Částka</th><th class="hide-sm">Stav</th></tr></thead>
      <tbody>${rows.map(b => `
        <tr data-href="#/vyuctovani/${esc(b.uid)}">
          <td class="nowrap">${Fmt.date(b.created_at)}</td>
          <td class="strong"><a href="#/vyuctovani/${esc(b.uid)}" style="color:inherit">${esc(b.customer?.name || '–')}</a><div class="show-sm">${statusLabel(b)}</div></td>
          <td class="hide-sm">${b.invoice ? esc(b.invoice_state?.number || b.invoice.number) : '<span class="muted">bez faktury</span>'}</td>
          <td class="num hide-sm">${Fmt.hours(b.seconds)}</td>
          <td class="num">${Fmt.money0(b.total)}</td>
          <td class="hide-sm">${statusLabel(b)}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
}

async function viewBillings() {
  const billings = await api('billings');
  return () => {
    setTitle('Vyúčtování');
    app.innerHTML = `
      <a class="back" href="#/prehled">‹ Přehled</a>
      <div class="page-head"><h1>Vyúčtování</h1></div>
      <div class="table-card">${billings.length
        ? billingTable(billings) + `<div class="hint" style="padding:12px 16px">${plural(billings.length, 'vyúčtování', 'vyúčtování', 'vyúčtování')} · celkem ${Fmt.money0(billings.reduce((s, b) => s + b.total, 0))}</div>`
        : '<div class="empty">Zatím nic. Vyber na stránce Čas záznamy a dej Vyfakturovat.</div>'}</div>`;
  };
}

async function viewBilling(params, ref) {
  const [b, entries] = await Promise.all([
    api('billings/' + encodeURIComponent(ref)).catch(e => {
      // třeba když jeho fakturu mezitím smazali ve Fakturách
      throw e.status === 404 ? new Error('Vyúčtování už neexistuje, jeho záznamy jsou zase mezi nevyfakturovanými.') : e;
    }),
    api('entries'), loadRefs()]);
  const mine = entries.filter(e => e.billing_id === b.id);
  return () => {
    setTitle(billingTitle(b));
    const state = b.invoice_state?.status;
    const c = b.customer;
    app.innerHTML = `
      <a class="back" href="#/vyuctovani">‹ Vyúčtování</a>
      <div class="page-head">
        <h1>${esc(billingTitle(b))} ${statusLabel(b)}</h1>
        <div class="actions">
          <a class="btn" href="/api/export/csv?vyuctovani=${esc(b.uid)}" download>Výkaz CSV</a>
          ${b.invoice && state !== 'deleted'
            ? `<a class="btn primary" href="${esc(invoiceLink(b))}">Otevřít ve Fakturách</a>`
            : `<a class="btn primary" href="#/vyfakturovat?vyuctovani=${esc(b.uid)}">Vytvořit fakturu…</a>`}
        </div>
      </div>
      ${state === 'deleted' ? '<div class="notice bad">Faktura ve Fakturách chybí, záznamy jsou ale pořád označené jako vyfakturované. Fakturu můžeš vytvořit znovu, nebo záznamy vrátit mezi nevyfakturované.</div>' : ''}
      ${state === 'cancelled' ? '<div class="notice">Faktura je ve Fakturách stornovaná. Když chceš práci vyfakturovat znovu, vrať záznamy mezi nevyfakturované.</div>' : ''}
      <div class="detail">
        <div>
          <div class="card">
            <dl class="facts">
              <dt>Částka</dt><dd class="big">${Fmt.money(b.total)}</dd>
              ${c ? `<dt>Odběratel</dt><dd>${esc(c.name)}<div class="muted">${[...addressLines(c), c.ico && `IČO ${c.ico}`].filter(Boolean).map(esc).join('<br>')}</div></dd>` : ''}
              <dt>Odpracováno</dt><dd>${Fmt.hours(b.seconds)} <span class="muted">(${dur(b.seconds)})</span></dd>
              <dt>Období</dt><dd>${b.period?.[0] === b.period?.[1] ? Fmt.date(b.period?.[0]) : `${Fmt.date(b.period?.[0])} – ${Fmt.date(b.period?.[1])}`}</dd>
              <dt>${b.invoice ? 'Vystaveno' : 'Vyúčtováno'}</dt><dd>${Fmt.date(b.created_at)}</dd>
              ${b.invoice_state?.paid_date ? `<dt>Zaplaceno</dt><dd>${Fmt.date(b.invoice_state.paid_date)}</dd>` : ''}
            </dl>
          </div>
          <div class="side-actions">
            ${state === 'paid'
              ? '<p class="hint" style="margin:0 4px">Zaplacenou fakturu jde zrušit jen ve Fakturách. Když ji tam smažeš, záznamy se vrátí mezi nevyfakturované samy.</p>'
              : '<button type="button" class="btn ghost danger" id="undo">Vrátit mezi nevyfakturované…</button>'}
          </div>
        </div>
        <div>
          ${b.items.length ? `
            <div class="table-card" style="margin-bottom:16px">
              <div class="table-scroll"><table class="list">
                <thead><tr><th>Položka</th><th class="num">Množství</th><th class="num hide-sm">Cena</th><th class="num">Celkem</th></tr></thead>
                <tbody>${b.items.map(it => `<tr><td>${esc(it.description)}</td><td class="num">${Fmt.qty(it.quantity)} ${esc(it.unit)}</td><td class="num hide-sm">${Fmt.money(it.price)}</td><td class="num">${Fmt.money(it.amount)}</td></tr>`).join('')}</tbody>
              </table></div>
            </div>` : ''}
          ${b.note ? `<p class="hint" style="margin:0 4px 16px">Poznámka: ${esc(b.note)}</p>` : ''}
          <div id="entries"></div>
        </div>
      </div>`;
    mountEntries($('#entries'), mine, billingMap([b]), { empty: 'Záznamy tohoto vyúčtování byly smazané.' });
    const undo = $('#undo');
    if (undo) undo.onclick = e => attempt(async () => {
      const number = b.invoice && (b.invoice_state?.number || b.invoice.number);
      const deletes = b.invoice && !['deleted', 'cancelled'].includes(state); // faktura se smaže i ve Fakturách
      const extra = deletes ? `\n\nFaktura ${number} se ve Fakturách smaže.`
        : state === 'cancelled' ? `\n\nStornovaná faktura ${number} ve Fakturách zůstane.` : '';
      if (!confirm(`Vrátit ${plural(mine.length, 'záznam', 'záznamy', 'záznamů')} mezi nevyfakturované?${extra}`)) return;
      await api('billings/' + encodeURIComponent(b.uid), { method: 'DELETE' });
      toast(deletes ? 'Záznamy jsou zase nevyfakturované a faktura je smazaná' : 'Záznamy jsou zase nevyfakturované');
      location.hash = '#/cas?stav=nevyfakturovane';
    }, e.currentTarget);
  };
}

// ---------- vyfakturovat ----------

async function viewBill(params) {
  // ?vyuctovani=<uid> = faktura k vyúčtování bez faktury (ze starších verzí, kde šlo záznamy jen označit)
  const later = params.get('vyuctovani');
  const ids = (params.get('zaznamy') || '').split(',').map(Number).filter(Boolean);
  const [preview, offered, peers] = await Promise.all([
    later ? api(`billings/${encodeURIComponent(later)}/draft`) : api('billings/preview', { method: 'POST', body: { entry_ids: ids } }),
    api('offered'), api('peers'), loadRefs(),
  ]);
  return () => renderBill(later ? preview.entry_ids : ids, preview, offered, peers);
}

function renderBill(ids, preview, offered, peers) {
  setTitle('Vyfakturovat');
  const faktury = peers.apps.find(a => a.id === 'faktury');
  const canInvoice = faktury && faktury.state !== 'missing';
  const later = preview.billing; // záznamy už jsou vyúčtované, faktura se k nim vystaví dodatečně
  const state = {
    uid: later || newUid(),
    customer: preview.customer,
    clientId: preview.client_id,
    editing: false,
    items: preview.items.map(it => ({ ...it })),
    grouping: preview.grouping,
  };
  let dirty = false;
  let itemsEdited = false;
  const markDirty = () => (dirty = true);
  leaveGuard = () => dirty;
  const back = later ? `#/vyuctovani/${encodeURIComponent(later)}` : '#/cas';
  const clients = refs.clients.slice().sort(byName);

  app.innerHTML = `
    <a class="back" href="${back}">${later ? '‹ Vyúčtování' : '‹ Čas'}</a>
    <div class="page-head">
      <div>
        <h1>${later ? 'Vytvořit fakturu' : 'Vyfakturovat'}</h1>
        <p class="subtitle">${plural(ids.length, 'záznam', 'záznamy', 'záznamů')} · ${Fmt.hours(preview.seconds)} (${dur(preview.seconds)}) · ${esc(preview.note.replace('Období: ', ''))}</p>
      </div>
    </div>
    ${!faktury || faktury.state === 'missing' ? `
      <div class="notice info" style="display:flex;gap:8px 16px;align-items:center;justify-content:space-between;flex-wrap:wrap">
        <span>Fakturu vystaví Faktury, a ty na tomhle Macu nejsou. Nainstalují se samy a hned se s Hodinovkou propojí.</span>
        <button type="button" class="btn primary" id="install">Nainstalovat Faktury</button>
      </div>` : ''}
    ${faktury && faktury.ready === false ? '<div class="notice">Ve Fakturách chybí tvoje údaje nebo číslo účtu, takže nebudou na faktuře. <a href="faktury://nastaveni">Doplnit v Nastavení Faktur</a></div>' : ''}
    ${preview.warnings.map(w => `<div class="notice">${esc(w)}</div>`).join('')}
    <form id="bill-form" autocomplete="off" novalidate>
      <section class="card">
        <h2>Odběratel</h2>
        <div class="customer-pick">
          <input id="customer-search" list="customer-list" placeholder="Jiný odběratel z klientů nebo Faktur – začni psát…" aria-label="Vybrat jiného odběratele">
          <datalist id="customer-list">${clients.map(c => `<option value="${esc(contactLabel(c))}"></option>`).join('')}${offered.map(c => `<option value="${esc(offeredLabel(c))}"></option>`).join('')}</datalist>
          <button type="button" class="btn" id="new-customer">Nový odběratel</button>
        </div>
        <div id="customer-box"></div>
      </section>
      <section class="card">
        <div class="card-head">
          <h2>Položky</h2>
          ${later ? '' : `<div class="segmented" role="group" aria-label="Položky faktury">${GROUPINGS.map(([k, label]) => `<button type="button" data-grouping="${k}" class="${k === state.grouping ? 'on' : ''}" aria-pressed="${k === state.grouping}">${label}</button>`).join('')}</div>`}
        </div>
        <table class="items">
          <thead><tr><th>Popis</th><th class="w-qty">Množství</th><th class="w-unit">Jednotka</th><th class="w-price">Cena za jedn.</th><th class="w-amount num">Celkem</th><th class="w-del"><span class="sr-only">Odebrat</span></th></tr></thead>
          <tbody id="items"></tbody>
        </table>
        <datalist id="units">${UNITS.map(u => `<option value="${u}"></option>`).join('')}</datalist>
        <button type="button" class="btn ghost" id="add-item" style="margin-top:8px">+ Přidat položku</button>
        <div class="total-row"><span class="muted">Celkem k úhradě</span><strong id="total"></strong></div>
      </section>
      <section class="card">
        <label>Poznámka na faktuře (nepovinné)<textarea name="note" rows="2">${esc(preview.note)}</textarea></label>
      </section>
      <div class="form-actions">
        <a class="btn" href="${back}">Zrušit</a>
        <button type="submit" class="btn primary" ${canInvoice ? '' : 'disabled'}>Vytvořit fakturu ve Fakturách</button>
      </div>
    </form>`;

  const form = $('#bill-form');
  form.addEventListener('input', markDirty);

  // --- odběratel ---
  const box = $('#customer-box');
  const drawCustomer = () => {
    const c = state.customer;
    if (state.editing) {
      box.innerHTML = `<div class="grid">${contactFields(c || {}, 'data-c')}</div>
        <p class="hint">Údaje se použijí jen na téhle faktuře. Nový odběratel se ve Fakturách uloží do kontaktů.</p>`;
      $$('[data-c]', box).forEach(el => (el.oninput = () => (state.customer[el.dataset.c] = el.value)));
      $('[data-ares]', box).onclick = e => attempt(async () => {
        Object.assign(state.customer, await loadAres(state.customer.ico));
        markDirty();
        drawCustomer();
      }, e.currentTarget);
    } else if (c) {
      box.innerHTML = `
        <div class="customer-card">
          <div class="name">${esc(c.name)}</div>
          <div class="muted">${[...addressLines(c), c.ico && `IČO ${c.ico}`, c.dic && `DIČ ${c.dic}`].filter(Boolean).map(esc).join(' · ') || 'Bez adresy a IČO'}</div>
        </div>
        <p class="hint">${!c.ico && !c.street ? 'Bez IČO a adresy bude na faktuře jen jméno. ' : ''}<a href="#" id="edit-customer">Upravit údaje</a></p>`;
      $('#edit-customer').onclick = e => {
        e.preventDefault();
        state.editing = true;
        drawCustomer();
      };
    } else {
      box.innerHTML = '<p class="hint" style="margin:0">Projekt nemá klienta. Vyber odběratele, nebo přidej nového.</p>';
    }
  };
  const search = $('#customer-search');
  search.addEventListener('input', () => {
    const own = clients.find(c => contactLabel(c) === search.value);
    const peer = !own && offered.find(c => offeredLabel(c) === search.value);
    if (!own && !peer) return;
    const src = own || peer;
    Object.assign(state, { customer: { ...pickCustomer(src), uid: src.uid }, clientId: own ? own.id : state.clientId, editing: false });
    search.value = '';
    markDirty();
    drawCustomer();
  });
  $('#new-customer').onclick = () => {
    Object.assign(state, { customer: { ...pickCustomer({}), uid: '' }, editing: true });
    markDirty();
    drawCustomer();
    $('[data-c="name"]', box).focus();
  };

  // --- položky ---
  const tbody = $('#items');
  const updateTotals = () => {
    let total = 0;
    $$('tr[data-i]', tbody).forEach(tr => {
      const it = state.items[tr.dataset.i];
      const amount = round2(parseNum(it.quantity) * parseNum(it.price));
      total += amount;
      $('[data-amount]', tr).textContent = Fmt.money(amount, false);
    });
    $('#total').textContent = Fmt.money(round2(total));
  };
  const drawItems = () => {
    tbody.innerHTML = state.items.map((it, i) => `
      <tr data-i="${i}">
        <td><input data-k="description" value="${esc(it.description)}" placeholder="Popis položky…" aria-label="Popis položky ${i + 1}"></td>
        <td class="w-qty"><input data-k="quantity" class="num" inputmode="decimal" value="${esc(decimalInput(it.quantity))}" placeholder="1" aria-label="Množství"></td>
        <td class="w-unit"><input data-k="unit" list="units" value="${esc(it.unit)}" aria-label="Jednotka"></td>
        <td class="w-price"><input data-k="price" class="num" inputmode="decimal" value="${esc(decimalInput(it.price))}" placeholder="0" aria-label="Cena za jednotku"></td>
        <td class="w-amount num" data-amount></td>
        <td class="w-del">${state.items.length > 1 ? `<button type="button" class="del" data-del aria-label="Odebrat položku ${i + 1}">×</button>` : ''}</td>
      </tr>`).join('');
    updateTotals();
  };
  tbody.addEventListener('input', e => {
    const tr = e.target.closest('tr[data-i]');
    state.items[tr.dataset.i][e.target.dataset.k] = e.target.value;
    itemsEdited = true;
    updateTotals();
  });
  tbody.addEventListener('click', e => {
    if (!e.target.matches('[data-del]')) return;
    state.items.splice(Number(e.target.closest('tr').dataset.i), 1);
    itemsEdited = true;
    markDirty();
    drawItems();
  });
  $('#add-item').onclick = () => {
    state.items.push({ description: '', quantity: 1, unit: state.items.at(-1)?.unit || 'hod', price: '' });
    drawItems();
    $('tr[data-i]:last-child [data-k="description"]', tbody).focus();
  };
  $$('[data-grouping]').forEach(b => (b.onclick = () => attempt(async () => {
    if (b.dataset.grouping === state.grouping) return;
    if (itemsEdited && !confirm('Položky jsi upravil. Přepočítat je znovu podle záznamů?')) return;
    const p = await api('billings/preview', { method: 'POST', body: { entry_ids: ids, grouping: b.dataset.grouping } });
    state.items = p.items.map(it => ({ ...it }));
    state.grouping = p.grouping;
    itemsEdited = false;
    $$('[data-grouping]').forEach(x => {
      x.classList.toggle('on', x.dataset.grouping === state.grouping);
      x.setAttribute('aria-pressed', String(x.dataset.grouping === state.grouping));
    });
    drawItems();
  }, b)));

  form.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      form.requestSubmit();
    } else if (e.target.tagName === 'INPUT') {
      e.preventDefault();
    }
  });

  const body = () => ({
    uid: state.uid,
    entry_ids: ids,
    grouping: state.grouping,
    client_id: state.clientId,
    customer: state.customer,
    items: state.items.filter(it => String(it.description).trim() || String(it.price).trim())
      .map(it => ({ ...it, quantity: parseNum(it.quantity), price: parseNum(it.price) })),
    note: form.elements.note.value,
  });
  form.onsubmit = e => {
    e.preventDefault();
    attempt(async () => {
      if (!state.customer?.name?.trim()) {
        (state.editing ? $('[data-c="name"]', box) : search).focus();
        throw new Error('Vyber nebo vyplň odběratele.');
      }
      const b = later
        ? await api(`billings/${encodeURIComponent(later)}/invoice`, { method: 'POST', body: body() })
        : await api('billings', { method: 'POST', body: body() });
      leaveGuard = null;
      toast(`Faktura ${b.invoice.number} je vytvořená ve Fakturách`);
      location.hash = `#/vyuctovani/${b.uid}`;
    }, e.submitter);
  };
  const install = $('#install');
  if (install) install.onclick = () => installPeer('faktury', install);

  drawCustomer();
  drawItems();
}

/** Nainstaluje jinou aplikaci systému (stáhne ji z GitHubu do Aplikací a spustí). */
function installPeer(id, button) {
  return attempt(async () => {
    toast('Stahuji a instaluji… může to minutu trvat');
    await api(`peers/${id}/install`, { method: 'POST', body: {} });
    toast('Nainstalováno a propojeno');
    router(false);
  }, button);
}

// ---------- projekty ----------

async function viewProjects(params) {
  await loadRefs();
  return () => {
    setTitle('Projekty');
    const archived = params.get('archiv') === '1';
    app.innerHTML = `
      <div class="page-head"><h1>Projekty</h1><a class="btn primary" href="#/projekt/novy">Nový projekt</a></div>
      <div class="toolbar">
        <nav class="segmented" aria-label="Projekty"><a href="#/projekty" class="${archived ? '' : 'on'}">Aktivní</a><a href="#/projekty?archiv=1" class="${archived ? 'on' : ''}">Archivované</a></nav>
        <span class="spacer"></span>
        <input id="search" type="search" placeholder="Hledat…" aria-label="Hledat projekt nebo klienta" autocomplete="off" spellcheck="false">
      </div>
      <div id="list"></div>`;
    const draw = q => {
      q = q.toLowerCase();
      const rows = refs.projects.filter(p => Boolean(p.archived) === archived)
        .filter(p => !q || [p.name, clientOf(p)?.name].some(v => (v || '').toLowerCase().includes(q)));
      const groups = new Map();
      for (const p of rows.sort(byName)) {
        const c = clientOf(p);
        const key = c ? c.id : 0;
        if (!groups.has(key)) groups.set(key, { client: c, projects: [] });
        groups.get(key).projects.push(p);
      }
      const ordered = [...groups.values()].sort((a, b) => (!a.client) - (!b.client) || (a.client && b.client ? byName(a.client, b.client) : 0));
      $('#list').innerHTML = ordered.length ? ordered.map(g => `
        <section class="table-card" style="margin-bottom:16px">
          <div class="card-head"><h2>${g.client ? `<a href="#/klient/${g.client.id}" style="color:inherit">${esc(g.client.name)}</a>` : 'Bez klienta'}</h2><span class="muted">${plural(g.projects.length, 'projekt', 'projekty', 'projektů')}</span></div>
          <div class="table-scroll"><table class="list projects">
            <thead><tr><th>Projekt</th><th class="hide-sm">Cena</th><th class="num">Odpracováno</th><th class="num">Nevyfakturováno</th></tr></thead>
            <tbody>${g.projects.map(p => `
              <tr data-href="#/projekt/${p.id}">
                <td class="strong"><a href="#/projekt/${p.id}" class="proj ${colorOf(p)}" style="font-size:14px;color:var(--text)"><i class="dot ${colorOf(p)}"></i>${esc(p.name)}</a><div class="show-sm muted">${esc(priceLabel(p))}</div></td>
                <td class="hide-sm muted">${esc(priceLabel(p))}</td>
                <td class="num">${Fmt.hours(p.seconds)}</td>
                <td class="num">${p.unbilled_seconds ? `${Fmt.money0(p.unbilled_amount)}<div class="muted" style="font-size:12px">${Fmt.hours(p.unbilled_seconds)}</div>` : '<span class="muted">–</span>'}</td>
              </tr>`).join('')}
            </tbody>
          </table></div>
        </section>`).join('')
        : `<div class="card empty">${refs.projects.length ? 'Nic nenalezeno.' : 'Zatím žádné projekty.<br><a class="btn primary" href="#/projekt/novy">Založit první projekt</a>'}</div>`;
    };
    $('#search').oninput = e => draw(e.target.value.trim());
    draw('');
  };
}

async function viewProject(params, id) {
  const [entries, billings, offered, settings] = await Promise.all([
    id ? api('entries') : [], id ? api('billings') : [], api('offered'), api('settings'), loadRefs(),
  ]);
  const project = id ? refs.byProject.get(id) : null;
  if (id && !project) throw new Error('Projekt neexistuje.');
  return () => renderProject(params, project, entries.filter(e => id && e.project_id === id), billings, offered, settings);
}

function renderProject(params, p, entries, billings, offered, settings) {
  const id = p?.id;
  setTitle(id ? p.name : 'Nový projekt');
  let dirty = false;
  leaveGuard = () => dirty;
  const presetClient = refs.byClient.get(Number(params.get('klient')));
  const client = id ? clientOf(p) : presetClient;
  const back = params.get('zpet') === 'cas' ? '#/cas' : client && !id ? `#/klient/${client.id}` : '#/projekty';
  const pricing = p?.pricing || 'hourly';
  const unbilled = entries.filter(isPickable);
  const fixedRate = p?.pricing === 'fixed' && p.seconds ? p.fixed_price / (p.seconds / 3600) : 0;

  app.innerHTML = `
    <a class="back" href="${back}">‹ ${back === '#/cas' ? 'Čas' : back.startsWith('#/klient') ? esc(client.name) : 'Projekty'}</a>
    <div class="page-head">
      <div>
        <h1>${id ? `<i class="dot ${colorOf(p)}"></i>${esc(p.name)}` : 'Nový projekt'}</h1>
        ${id ? `<p class="subtitle">${client ? `<a href="#/klient/${client.id}">${esc(client.name)}</a> · ` : ''}${esc(priceLabel(p))}${p.archived ? ' · archivovaný' : ''}</p>` : ''}
      </div>
      ${unbilled.length ? `<div class="actions"><a class="btn primary" href="#/vyfakturovat?zaznamy=${unbilled.map(e => e.id).join(',')}">Vyfakturovat ${dur(sumSecs(unbilled))}</a></div>` : ''}
    </div>
    ${id ? `
      <div class="kpis">
        <div class="kpi"><div class="k">Odpracováno</div><div class="v">${Fmt.hours(p.seconds)}</div><div class="d">${plural(p.entry_count, 'záznam', 'záznamy', 'záznamů')}</div></div>
        <div class="kpi"><div class="k">Nevyfakturováno</div><div class="v">${Fmt.money0(p.unbilled_amount)}</div><div class="d">${Fmt.hours(p.unbilled_seconds)}</div></div>
        <div class="kpi"><div class="k">Vyfakturováno</div><div class="v">${Fmt.money0(p.billed_amount)}</div><div class="d">${p.pricing === 'fixed' ? (p.fixed_billed ? 'pevná cena je vyfakturovaná' : 'pevná cena zatím ne') : 'za celou dobu'}</div></div>
        ${p.pricing === 'fixed'
          ? `<div class="kpi"><div class="k">Vychází na hodinu</div><div class="v">${fixedRate ? `${Fmt.money0(fixedRate)}` : '–'}</div><div class="d">z pevné ceny ${Fmt.money0(p.fixed_price)}</div></div>`
          : `<div class="kpi"><div class="k">Sazba</div><div class="v">${p.rate ? Fmt.money0(p.rate) : '–'}</div><div class="d">za hodinu</div></div>`}
      </div>` : ''}
    <form id="project-form" class="card" autocomplete="off" novalidate>
      <div class="grid">
        ${field('Název projektu', 'name="name" required placeholder="Třeba Web pro kavárnu"', p?.name, { cls: 'c4' })}
        <label class="c2">Klient<input name="client" list="client-list" value="${esc(client ? contactLabel(client) : '')}" placeholder="Vyber nebo napiš nového"></label>
        <datalist id="client-list">${refs.clients.slice().sort(byName).map(c => `<option value="${esc(contactLabel(c))}"></option>`).join('')}${offered.map(c => `<option value="${esc(offeredLabel(c))}"></option>`).join('')}</datalist>
        <div class="c6 price-pick">
          <div class="segmented" role="group" aria-label="Cena">
            <button type="button" data-pricing="hourly">Hodinová sazba</button>
            <button type="button" data-pricing="fixed">Pevná cena</button>
          </div>
          <div class="grid">
            ${field('Sazba (Kč za hodinu)', `name="rate" class="num" inputmode="decimal" placeholder="0"`, decimalInput(p ? p.rate : settings.default_rate || ''), { cls: 'c2' })}
            ${field('Pevná cena (Kč)', `name="fixed_price" class="num" inputmode="decimal" placeholder="0"`, decimalInput(p?.fixed_price || ''), { cls: 'c2' })}
            <p class="hint c6" id="price-hint" style="margin:0"></p>
          </div>
        </div>
        <label class="c6">Poznámka (nepovinné)<textarea name="note" rows="2">${esc(p?.note)}</textarea></label>
        ${id ? `<div class="c6"><label class="check"><input type="checkbox" name="archived" ${p.archived ? 'checked' : ''}> Archivovat – projekt se přestane nabízet u časovače</label></div>` : ''}
      </div>
      <div class="form-actions" style="margin-top:20px">
        ${id ? '<button type="button" class="btn ghost danger" id="delete" style="margin-right:auto">Smazat projekt…</button>' : ''}
        <a class="btn" href="${back}">Zrušit</a>
        <button type="submit" class="btn primary">${id ? 'Uložit' : 'Založit projekt'}</button>
      </div>
    </form>
    ${id ? '<h2 style="margin-top:32px">Záznamy</h2><div id="entries"></div>' : ''}`;

  const form = $('#project-form');
  const els = form.elements;
  form.addEventListener('input', () => (dirty = true));
  let mode = pricing;
  const drawPricing = () => {
    $$('[data-pricing]').forEach(b => {
      b.classList.toggle('on', b.dataset.pricing === mode);
      b.setAttribute('aria-pressed', String(b.dataset.pricing === mode));
    });
    els.rate.closest('label').hidden = mode !== 'hourly';
    els.fixed_price.closest('label').hidden = mode !== 'fixed';
    $('#price-hint').textContent = mode === 'fixed'
      ? 'Pevná cena se vyfakturuje jednou, bez ohledu na počet hodin. Čas se dál měří, ať víš, kolik tě projekt stál.'
      : 'Na faktuře bude odpracovaný čas krát sazba. Zaokrouhlení hodin nastavíš v Nastavení.';
  };
  $$('[data-pricing]').forEach(b => (b.onclick = () => {
    mode = b.dataset.pricing;
    dirty = true;
    drawPricing();
  }));
  drawPricing();

  form.onsubmit = e => {
    e.preventDefault();
    attempt(async () => {
      if (!els.name.value.trim()) {
        els.name.focus();
        throw new Error('Vyplň název projektu.');
      }
      const clientId = await resolveClient(els.client.value, offered);
      const saved = await api(id ? `projects/${id}` : 'projects', {
        method: id ? 'PUT' : 'POST',
        body: {
          name: els.name.value, client_id: clientId, pricing: mode,
          rate: parseNum(els.rate.value), fixed_price: parseNum(els.fixed_price.value),
          note: els.note.value, archived: Boolean(els.archived?.checked),
        },
      });
      leaveGuard = null;
      toast(id ? 'Projekt uložen' : 'Projekt založen');
      if (params.get('zpet') === 'cas') {
        rememberProject(saved.id);
        if (Timer.entry && !Timer.entry.project_id) await api('entries/' + Timer.entry.id, { method: 'PUT', body: { project_id: saved.id } });
        location.hash = '#/cas';
      } else {
        location.hash = id ? '#/projekty' : `#/projekt/${saved.id}`;
      }
    }, e.submitter);
  };
  const del = $('#delete');
  if (del) del.onclick = () => attempt(async () => {
    if (!confirm(`Smazat projekt ${p.name}?`)) return;
    await api('projects/' + id, { method: 'DELETE' });
    leaveGuard = null;
    toast('Projekt smazán');
    location.hash = '#/projekty';
  }, del);
  if (id) mountEntries($('#entries'), entries, billingMap(billings), { empty: 'Na projektu zatím nikdo nepracoval.' });
}

// ---------- klienti ----------

async function viewClients() {
  const [offered] = await Promise.all([api('offered'), loadRefs()]);
  return () => {
    setTitle('Klienti');
    app.innerHTML = `
      <div class="page-head"><h1>Klienti</h1><a class="btn primary" href="#/klient/novy">Nový klient</a></div>
      <div class="toolbar"><input id="search" type="search" placeholder="Hledat…" aria-label="Hledat název, IČO nebo město" autocomplete="off" spellcheck="false"></div>
      <div class="table-card" id="list"></div>
      ${offered.length ? `
        <section class="table-card" style="margin-top:24px">
          <div class="card-head"><h2>Kontakty z ostatních aplikací</h2><span class="muted">nabízí se i při zakládání projektu</span></div>
          <div class="table-scroll"><table class="list">
            <tbody>${offered.slice().sort(byName).map(c => `
              <tr>
                <td class="strong">${esc(c.name)}<div class="muted" style="font-weight:400;font-size:13px">${esc([c.ico && `IČO ${c.ico}`, c.city].filter(Boolean).join(' · '))}</div></td>
                <td class="hide-sm"><span class="linked">${esc(c.app_name)}</span></td>
                <td class="num"><button type="button" class="btn" data-adopt="${esc(c.uid)}">Přidat</button></td>
              </tr>`).join('')}
            </tbody>
          </table></div>
        </section>` : ''}`;
    const draw = q => {
      q = q.toLowerCase();
      const rows = refs.clients.slice().sort(byName).filter(c => !q || [c.name, c.ico, c.city, c.email].some(v => (v || '').toLowerCase().includes(q)));
      $('#list').innerHTML = rows.length ? `
        <div class="table-scroll"><table class="list">
          <thead><tr><th>Název</th><th class="hide-sm">IČO</th><th class="num hide-sm">Projektů</th><th class="num">Odpracováno</th><th class="num">Nevyfakturováno</th></tr></thead>
          <tbody>${rows.map(c => `
            <tr data-href="#/klient/${c.id}">
              <td class="strong"><a href="#/klient/${c.id}" style="color:inherit">${esc(c.name)}</a>${c.linked.length ? `<div style="margin-top:2px;font-weight:400"><span class="linked">propojeno: ${esc(c.linked.join(', '))}</span></div>` : ''}</td>
              <td class="hide-sm">${esc(c.ico)}</td>
              <td class="num hide-sm">${c.project_count}</td>
              <td class="num">${Fmt.hours(c.seconds)}</td>
              <td class="num">${c.unbilled_amount ? Fmt.money0(c.unbilled_amount) : '<span class="muted">–</span>'}</td>
            </tr>`).join('')}
          </tbody>
        </table></div>` : `<div class="empty">${refs.clients.length ? 'Nic nenalezeno.' : 'Zatím žádní klienti.'}</div>`;
    };
    $('#search').oninput = e => draw(e.target.value.trim());
    draw('');
    $$('[data-adopt]').forEach(b => (b.onclick = () => attempt(async () => {
      const c = offered.find(x => x.uid === b.dataset.adopt);
      await api('clients', { method: 'POST', body: { ...pickCustomer(c), uid: c.uid } });
      toast(`${c.name} je mezi klienty`);
      router(false);
    }, b)));
  };
}

async function viewClient(params, id) {
  await loadRefs();
  const client = id ? refs.byClient.get(id) : {};
  if (id && !client) throw new Error('Klient neexistuje.');
  return () => {
    setTitle(id ? client.name : 'Nový klient');
    let dirty = false;
    leaveGuard = () => dirty;
    const projects = id ? refs.projects.filter(p => p.client_id === id).sort((a, b) => a.archived - b.archived || byName(a, b)) : [];
    app.innerHTML = `
      <a class="back" href="#/klienti">‹ Klienti</a>
      <div class="page-head">
        <h1>${id ? esc(client.name) : 'Nový klient'}</h1>
        ${id ? `<a class="btn primary" href="#/projekt/novy?klient=${id}">Nový projekt</a>` : ''}
      </div>
      ${id && client.linked.length ? `<div class="notice info">Klient je propojený s aplikací ${esc(client.linked.join(', '))}. Změny údajů se přenesou i tam.</div>` : ''}
      <form id="client-form" class="card" autocomplete="off" novalidate>
        <div class="grid">
          ${contactFields(client, 'name')}
          <label class="c6">Poznámka (jen pro tebe)<textarea name="note" rows="2">${esc(client.note)}</textarea></label>
        </div>
        <p class="hint">Stačí jméno. IČO a adresu doplň, až budeš fakturovat – Faktury je pak použijí.</p>
        <div class="form-actions" style="margin-top:20px">
          ${id ? '<button type="button" class="btn ghost danger" id="delete" style="margin-right:auto">Smazat klienta…</button>' : ''}
          <button type="submit" class="btn primary">Uložit</button>
        </div>
      </form>
      ${id ? `<h2 style="margin-top:32px">Projekty</h2>
        ${projects.length ? `<div class="table-card"><div class="table-scroll"><table class="list projects">
          <thead><tr><th>Projekt</th><th class="hide-sm">Cena</th><th class="num">Odpracováno</th><th class="num">Nevyfakturováno</th></tr></thead>
          <tbody>${projects.map(p => `
            <tr data-href="#/projekt/${p.id}">
              <td class="strong"><a href="#/projekt/${p.id}" class="proj ${colorOf(p)}" style="font-size:14px;color:var(--text)"><i class="dot ${colorOf(p)}"></i>${esc(p.name)}</a>${p.archived ? ' <span class="tag">archiv</span>' : ''}</td>
              <td class="hide-sm muted">${esc(priceLabel(p))}</td>
              <td class="num">${Fmt.hours(p.seconds)}</td>
              <td class="num">${p.unbilled_seconds ? Fmt.money0(p.unbilled_amount) : '<span class="muted">–</span>'}</td>
            </tr>`).join('')}</tbody></table></div></div>` : '<p class="muted">Zatím žádné.</p>'}` : ''}`;

    const form = $('#client-form');
    form.addEventListener('input', () => (dirty = true));
    $('[data-ares]', form).onclick = e => attempt(async () => {
      const data = await loadAres(form.elements.ico.value);
      for (const [k, v] of Object.entries(data)) if (form.elements[k]) form.elements[k].value = v;
      dirty = true;
    }, e.currentTarget);
    form.onsubmit = e => {
      e.preventDefault();
      attempt(async () => {
        if (!form.elements.name.value.trim()) {
          form.elements.name.focus();
          throw new Error('Vyplň název nebo jméno klienta.');
        }
        const saved = await api(id ? `clients/${id}` : 'clients', { method: id ? 'PUT' : 'POST', body: Object.fromEntries(new FormData(form)) });
        leaveGuard = null;
        toast('Klient uložen');
        location.hash = id ? '#/klienti' : `#/klient/${saved.id}`;
      }, e.submitter);
    };
    const del = $('#delete');
    if (del) del.onclick = () => attempt(async () => {
      if (!confirm(`Smazat klienta ${client.name}?\n\nJeho projekty i odpracovaný čas zůstanou, jen budou bez klienta.`)) return;
      await api('clients/' + id, { method: 'DELETE' });
      leaveGuard = null;
      toast('Klient smazán');
      location.hash = '#/klienti';
    }, del);
  };
}

// ---------- nastavení ----------

async function viewSettings() {
  const [s, cloud, peers] = await Promise.all([api('settings'), api('zaloha'), api('peers')]);
  return () => {
    setTitle('Nastavení');
    let dirty = false;
    leaveGuard = () => dirty;
    app.innerHTML = `
      <div class="page-head"><h1>Nastavení</h1></div>
      <form id="settings-form" autocomplete="off" novalidate>
        <section class="card">
          <h2>Fakturace</h2>
          <div class="grid">
            ${field('Výchozí sazba nových projektů (Kč/h)', 'name="default_rate" class="num" inputmode="decimal" placeholder="0"', decimalInput(s.default_rate || ''), { cls: 'c2' })}
            <label class="c2">Hodiny na faktuře<select name="rounding">${ROUNDINGS.map(([v, t]) => `<option value="${v}" ${Number(s.rounding) === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
            <label class="c2">Položky faktury<select name="grouping">${GROUPINGS.map(([v, t]) => `<option value="${v}" ${s.grouping === v ? 'selected' : ''}>${t}${v === 'project' ? ' (jedna položka)' : ''}</option>`).join('')}</select></label>
          </div>
          <p class="hint">Zaokrouhluje se součet hodin každé položky. Položky jde před vystavením faktury vždycky upravit.</p>
          <div class="form-actions" style="margin-top:16px"><button type="submit" class="btn primary">Uložit</button></div>
        </section>
      </form>
      <section class="card">
        <h2>Propojené aplikace</h2>
        <p style="margin-top:0">Hodinovka patří do systému <b>${esc(peers.system)}</b>. Aplikace na tomhle Macu se najdou samy, sdílí klienty a z Hodinovky jde jedním kliknutím vystavit fakturu ve Fakturách.</p>
        <div class="apps">${peers.apps.map(a => `
          <div class="app-row">
            <span class="app-icon ${esc(a.id)}" aria-hidden="true">${esc(a.name.charAt(0))}</span>
            <span class="who"><b>${esc(a.name)}</b><span>${esc(a.description)}</span></span>
            ${a.state === 'running' || a.state === 'ready'
              ? `<span class="state ok">✓ Propojeno${a.version ? ` · verze ${esc(a.version)}` : ''}</span><a class="btn" href="${esc(a.scheme || a.id)}://">Otevřít</a>`
              : a.state === 'installed'
                ? `<span class="state muted">Propojí se po prvním otevření</span><button type="button" class="btn" data-open="${esc(a.id)}">Otevřít</button>`
                : `<a class="btn ghost" href="${esc(a.web)}" target="_blank" rel="noopener">Co to je</a><button type="button" class="btn primary" data-install="${esc(a.id)}">Nainstalovat</button>`}
          </div>`).join('')}
        </div>
      </section>
      <section class="card">
        <h2>Data a zálohy</h2>
        <p style="margin-top:0">Všechno je ve složce <b>${esc(cloud.data)}</b> v souboru <b>hodinovka.json</b>.
        Před první změnou každého dne se uloží kopie do <b>zalohy</b> (posledních 30 dní).</p>
        ${cloudStatus(cloud)}
        <div class="actions"><a class="btn" href="/api/export" download>Stáhnout zálohu dat</a><a class="btn" href="/api/export/csv" download>Výkaz práce (CSV)</a></div>
      </section>
      <section class="card">
        <h2>Aktualizace</h2>
        <p class="hint" id="version-info" style="margin:0">Zjišťuji verzi…</p>
      </section>`;
    showVersion();
    $$('[data-install]').forEach(b => (b.onclick = () => installPeer(b.dataset.install, b)));
    $$('[data-open]').forEach(b => (b.onclick = () => attempt(async () => {
      await api(`peers/${b.dataset.open}/open`, { method: 'POST', body: {} });
      toast('Otevírám… po prvním spuštění se aplikace propojí sama');
    }, b)));

    const form = $('#settings-form');
    form.addEventListener('input', () => (dirty = true));
    form.onsubmit = e => {
      e.preventDefault();
      attempt(async () => {
        const v = Object.fromEntries(new FormData(form));
        v.default_rate = parseNum(v.default_rate);
        await api('settings', { method: 'PUT', body: v });
        dirty = false;
        toast('Nastavení uloženo');
      }, e.submitter);
    };
  };
}

function cloudStatus(c) {
  if (!c.dir) return '<p class="hint bad">Záloha do iCloud Drive je vypnutá.</p>';
  if (c.error) return `<p class="hint bad">Záloha do iCloud Drive selhala: ${esc(c.error)}</p>`;
  if (!c.last) return '<p class="hint">Záloha do iCloud Drive právě probíhá…</p>';
  const day = c.last.slice(0, 10) === isoDate() ? 'dnes' : Fmt.date(c.last.slice(0, 10));
  return `<p class="hint ok" style="margin-bottom:16px">Po každé změně se data zkopírují do iCloud Drive → <b>Hodinovka záloha</b>. Naposledy ${day} v ${c.last.slice(11, 16)} ✓</p>`;
}

// ---------- aktualizace ----------

/** Lišta nad obsahem, která zůstává i při přechodu mezi stránkami. */
function updateBar(html, action = '') {
  const bar = $('#update');
  bar.innerHTML = html ? `<div class="notice info"><span>${html}</span>${action}</div>` : '';
  bar.hidden = !html;
  const button = $('[data-update]', bar);
  if (button) button.onclick = () => installUpdate();
}

/** Při otevření appky zjistí, jestli na GitHubu nevyšla nová verze, a rovnou ji nainstaluje. */
async function checkForUpdate() {
  const u = await api('update').catch(() => null);
  if (!u?.available || u.git) return; // vývojová kopie z gitu se neaktualizuje
  if (leaveGuard?.()) {
    updateBar(`Vyšla nová verze Hodinovky ${esc(u.latest)}.`, '<button class="btn primary" data-update>Aktualizovat</button>');
  } else {
    installUpdate();
  }
}

async function installUpdate() {
  if (leaveGuard?.() && !confirm('Máš neuložené změny. Aktualizace stránku znovu načte – opravdu pokračovat?')) return;
  updateBar('Aktualizuji Hodinovku na novou verzi…');
  try {
    const result = await api('update', { method: 'POST', body: {} });
    // Server se restartuje s novým kódem – počkej, až naběhne. Časovač běží dál (je uložený).
    for (let i = 0; i < 60; i++) {
      await wait(500);
      const v = await api('version').catch(() => null);
      if (v?.version !== result.version) continue;
      try { sessionStorage.setItem('updated', JSON.stringify(result)); } catch {}
      if (leaveGuard?.()) return updateBar(`Hodinovka je aktualizovaná na verzi ${esc(result.version)}. Po uložení změn načti stránku znovu (⌘R).`);
      return location.reload();
    }
    throw new Error('Server se po aktualizaci nespustil. Zavři Hodinovku a otevři ji znovu.');
  } catch (e) {
    updateBar(`Aktualizace se nepovedla: ${esc(e.message)}`);
  }
}

/** Po aktualizaci a znovunačtení stránky řekne, co se stalo. */
function announceUpdate() {
  let result = null;
  try {
    result = JSON.parse(sessionStorage.getItem('updated'));
    sessionStorage.removeItem('updated');
  } catch {}
  if (!result) return;
  const done = `Hodinovka je aktualizovaná na verzi ${esc(result.version)}.`;
  if (result.app_error) updateBar(`${done} ${esc(result.app_error)}`);
  else if (result.app_changed) updateBar(`${done} Ukonči Hodinovku (⌘Q) a otevři ji znovu, ať se načte i nové okno aplikace.`);
  else toast(done);
}

async function showVersion() {
  const u = await api('update').catch(() => null);
  const el = $('#version-info');
  if (!u || !el) return;
  let html = `Máš verzi <b>${esc(u.version)}</b>. `;
  if (!u.latest) html += 'Nové verze se hledají na GitHubu při každém otevření Hodinovky a samy se nainstalují.';
  else if (!u.available) html += 'Je to nejnovější verze ✓';
  else if (u.git) html += `Vyšla verze ${esc(u.latest)}. Tohle je vývojová kopie z gitu, takže se aktualizace neinstalují.`;
  else html += `Vyšla verze ${esc(u.latest)}. <button class="btn primary" data-update>Aktualizovat</button>`;
  if (u.url) html += ` <a href="${esc(u.url)}" target="_blank" rel="noopener">Co je nového</a>`;
  el.innerHTML = html;
  const button = $('[data-update]', el);
  if (button) button.onclick = () => installUpdate();
}

// ---------- živé obnovení ----------

/* Když se data změní jinde (ve Fakturách, v druhém okně nebo v prohlížeči), otevřená stránka se sama obnoví.
   Neruší: počká, dokud uživatel něco píše, má otevřený dialog, vybrané řádky nebo neuložené změny. */
function canRefresh() {
  const el = document.activeElement;
  // rozepsaný text (kromě hledání, to se po obnovení vrátí) by obnovení smazalo
  const typed = $$('input, textarea', app).some(i => !['search', 'checkbox', 'radio', 'file'].includes(i.type) && i.value !== i.defaultValue);
  return !busy && !leaveGuard?.() && !typed && !$('dialog[open]') && !$('.bulkbar:not([hidden])') &&
    !(el && app.contains(el) && el.matches('input, textarea, select')) && !String(window.getSelection?.() || '');
}

async function refreshView() {
  const q = $('#search')?.value;
  await router(false);
  const search = $('#search');
  if (q && search && !search.value) {
    search.value = q;
    search.dispatchEvent(new Event('input'));
  }
}

async function watchChanges() {
  if (document.hidden) return;
  const r = await fetch('/api/rev').then(res => res.json()).catch(() => null);
  if (!r?.rev || r.rev === seenRev) return;
  if (seenRev !== null && !canRefresh()) return; // zkusí to znovu za chvíli
  const changed = seenRev !== null;
  seenRev = r.rev;
  if (changed) refreshView();
}

setInterval(watchChanges, 2000);
window.addEventListener('focus', watchChanges);
document.addEventListener('visibilitychange', watchChanges);

// ---------- směrování ----------

const routes = [
  [/^\/cas$/, viewTime],
  [/^\/prehled$/, viewDashboard],
  [/^\/vyuctovani$/, viewBillings],
  [/^\/vyuctovani\/([\w-]+)$/, (p, ref) => viewBilling(p, ref)],
  [/^\/vyfakturovat$/, viewBill],
  [/^\/projekty$/, viewProjects],
  [/^\/projekt\/novy$/, p => viewProject(p, null)],
  [/^\/projekt\/(\d+)$/, (p, id) => viewProject(p, Number(id))],
  [/^\/klienti$/, viewClients],
  [/^\/klient\/novy$/, p => viewClient(p, null)],
  [/^\/klient\/(\d+)$/, (p, id) => viewClient(p, Number(id))],
  [/^\/nastaveni$/, viewSettings],
];
let routeToken = 0;
let leaveGuard = null; // vrací true, když jsou na stránce neuložené změny
let currentHash = location.hash;

/** Změní adresu bez znovunačtení stránky (filtry). */
function setHash(hash) {
  history.replaceState(null, '', hash);
  currentHash = location.hash;
}

async function router(navigated = true) {
  const [path, query] = (location.hash.slice(1) || '/cas').split('?');
  const route = routes.find(([re]) => re.test(path));
  if (!route) return location.replace('#/cas');
  const section = path.split('/')[1];
  $$('[data-nav]').forEach(a => {
    const on = a.dataset.nav.split(' ').some(n => section.startsWith(n));
    a.classList.toggle('active', on);
    on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
  });
  drawPill();

  const token = ++routeToken;
  try {
    const render = await route[1](new URLSearchParams(query || ''), ...path.match(route[0]).slice(1));
    if (token !== routeToken) return; // mezitím se přešlo jinam
    if (navigated) leaveGuard = null;
    const y = window.scrollY;
    render();
    tick();
    if (navigated) {
      window.scrollTo(0, 0);
      app.classList.remove('enter');
      void app.offsetWidth; // restart animace
      app.classList.add('enter');
    } else {
      window.scrollTo(0, y);
    }
  } catch (e) {
    if (token === routeToken) app.innerHTML = `<div class="notice">${esc(e.message)}</div><p><a href="#/cas">Zpět na čas</a></p>`;
  }
}

window.addEventListener('hashchange', () => {
  if (leaveGuard?.() && !confirm('Máš neuložené změny. Opravdu odejít?')) {
    history.replaceState(null, '', currentHash);
    return;
  }
  leaveGuard = null;
  currentHash = location.hash;
  router();
});
window.addEventListener('beforeunload', e => {
  if (leaveGuard?.()) e.preventDefault();
});

// Kliknutí kamkoli na řádek tabulky otevře detail.
app.addEventListener('click', e => {
  const row = e.target.closest('tr[data-href]');
  if (row && !e.target.closest('a, button, input, label, select, .sel')) location.hash = row.dataset.href;
});

Timer.refresh();
watchChanges();
router();
announceUpdate();
checkForUpdate();
