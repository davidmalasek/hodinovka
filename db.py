"""Data Hodinovky – vše je v jednom čitelném souboru data/hodinovka.json."""
import csv
import io
import json
import os
import shutil
import sys
import threading
from contextlib import contextmanager
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from pathlib import Path

import mejvos

APP_ID = "hodinovka"
ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get("HODINOVKA_DATA") or ROOT / "data")  # jiná složka jen pro testy
DATA_FILE = DATA / "hodinovka.json"
ZALOHY = DATA / "zalohy"
ZALOHY_POCET = 30
# Kopie dat v iCloud Drive. Zapíná ji jen server.main() – testy ji nechávají vypnutou.
ICLOUD_DEFAULT = Path.home() / "Library/Mobile Documents/com~apple~CloudDocs/Hodinovka záloha"
ICLOUD = None

DEFAULT_SETTINGS = {
    "default_rate": 0,      # hodinová sazba nových projektů (Kč)
    "rounding": 0,          # hodiny na faktuře se zaokrouhlí nahoru na tolik minut, 0 = přesně
    "grouping": "project",  # položky faktury: project = jedna za projekt, description = podle popisu
}
ROUNDINGS = (0, 6, 15, 30, 60)
GROUPINGS = ("project", "description")
PRICINGS = ("hourly", "fixed")
CUSTOMER_FIELDS = mejvos.CONTACT_FIELDS
CLIENT_FIELDS = CUSTOMER_FIELDS + ("note",)
COLORS = 8  # počet barev projektů v app.css

_lock = threading.Lock()


# ---------- soubor ----------

def empty():
    return {"settings": dict(DEFAULT_SETTINGS), "clients": [], "projects": [], "entries": [], "billings": []}


def init():
    DATA.mkdir(parents=True, exist_ok=True)
    if not DATA_FILE.exists():
        _save(empty())


def _load():
    try:
        data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Soubor {DATA_FILE.name} je poškozený ({e}). "
                           f"Obnov ho z poslední zálohy ve složce data/zalohy.")
    for key, value in empty().items():
        data.setdefault(key, value)
    return data


def _save(data):
    """Zapíše nejdřív do dočasného souboru a pak ho prohodí – soubor se nikdy nezapíše napůl."""
    tmp = DATA_FILE.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, DATA_FILE)


def _commit(data):
    daily_backup()
    _save(data)
    publish(data)
    if ICLOUD:
        _cloud_wake.set()


@contextmanager
def open_data(write=False):
    """Načte data; při write=True je po úspěšném dokončení uloží. Při chybě se nic neuloží."""
    with _lock:
        data = _load()
        yield data
        if write:
            _commit(data)


def daily_backup():
    """Před první změnou dne zkopíruje data do data/zalohy; nechá posledních 30 dní."""
    ZALOHY.mkdir(parents=True, exist_ok=True)
    target = ZALOHY / f"hodinovka-{date.today().isoformat()}.json"
    if not target.exists() and DATA_FILE.exists():
        shutil.copyfile(DATA_FILE, target)
    for old in sorted(ZALOHY.glob("hodinovka-*.json"))[:-ZALOHY_POCET]:
        old.unlink()


def backup_now(label):
    """Okamžitá záloha (např. před aktualizací) – tyhle se nemažou."""
    ZALOHY.mkdir(parents=True, exist_ok=True)
    target = ZALOHY / f"{label}-{datetime.now().strftime('%Y-%m-%d-%H%M%S')}.json"
    shutil.copyfile(DATA_FILE, target)
    return target


# ---------- propojení s ostatními aplikacemi (MejvOS) ----------

_peer_sig = None


def publish(data):
    """Zveřejní klienty ostatním aplikacím (třeba Fakturám)."""
    mejvos.publish_contacts(APP_ID, data["clients"])


def sync_peers():
    """Převezme novější údaje propojených klientů z ostatních aplikací (třeba IČO doplněné ve Fakturách).
    Dívá se jen, když se od minule něco změnilo, takže je levné volat ho před každým požadavkem."""
    global _peer_sig
    sig = mejvos.signature("contacts", APP_ID)
    if sig == _peer_sig:
        return
    with _lock:
        data = _load()
        if mejvos.merge_contacts(data["clients"], mejvos.peer_contacts(APP_ID)):
            _commit(data)
    _peer_sig = sig


def offered_contacts(data):
    """Kontakty z ostatních aplikací, které v Hodinovce ještě nejsou – nabízí se při výběru klienta."""
    return mejvos.offered_contacts(data["clients"], mejvos.peer_contacts(APP_ID))


def invoice_states():
    """Stav faktur vystavených z Hodinovky, jak ho zveřejnily Faktury: {app: {ref: řádek}}.
    Aplikace, která nic nezveřejnila, ve výsledku chybí (stav neznáme)."""
    out = {}
    for app_id, d in mejvos.read("invoices", APP_ID).items():
        out[app_id] = {"ready": d.get("ready"), "rows": {
            r["ref"]: r for r in d["items"] if isinstance(r, dict) and r.get("app") == APP_ID and r.get("ref")}}
    return out


# ---------- záloha do iCloud Drive ----------

cloud_status = {"dir": None, "last": None, "error": None}
_cloud_wake = threading.Event()


def start_cloud_backup(target):
    """Spustí na pozadí kopírování dat do iCloud Drive – hned a pak po každé změně."""
    global ICLOUD
    ICLOUD = Path(target)
    cloud_status["dir"] = str(ICLOUD)
    threading.Thread(target=_cloud_worker, daemon=True, name="icloud").start()
    _cloud_wake.set()


def _cloud_worker():
    while True:
        _cloud_wake.wait()
        _cloud_wake.clear()
        cloud_sync()


def cloud_sync():
    """Zkopíruje hodinovka.json a zálohy do ICLOUD. Nic nemaže, kromě denních záloh starších než 30 dní."""
    target = ICLOUD
    if target is None:
        return
    try:
        if not target.parent.is_dir():
            raise RuntimeError("iCloud Drive na tomhle Macu není zapnutý.")
        target.mkdir(exist_ok=True)
        files = [DATA_FILE] + ([f for f in sorted(ZALOHY.glob("*.json"))] if ZALOHY.is_dir() else [])
        for src in files:
            _copy_if_changed(src, target / src.relative_to(DATA))
        for old in sorted((target / ZALOHY.name).glob("hodinovka-*.json"))[:-ZALOHY_POCET]:
            old.unlink()
        cloud_status.update(last=mejvos.now(), error=None)
    except Exception as e:  # záloha nesmí shodit server – chyba se ukáže v Nastavení
        cloud_status["error"] = str(e)
        print(f"Záloha do iCloud Drive selhala: {e}", file=sys.stderr, flush=True)


def _copy_if_changed(src, dst):
    st = src.stat()
    try:
        d = dst.stat()
        if d.st_size == st.st_size and int(d.st_mtime) == int(st.st_mtime):
            return
    except FileNotFoundError:
        pass
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(f".{dst.name}.tmp")
    shutil.copy2(src, tmp)
    os.replace(tmp, dst)


# ---------- pomocné ----------

def _text(v):
    return "" if v is None else str(v).strip()


def _decimal(v, label):
    try:
        d = Decimal(str(v).replace(",", ".").replace(" ", "").replace(" ", "") or "0")
    except InvalidOperation:
        raise ValueError(f"{label}: „{v}“ není číslo.")
    if not d.is_finite():
        raise ValueError(f"{label}: „{v}“ není číslo.")
    return d


def _money(d):
    return float(Decimal(d).quantize(Decimal("0.01"), ROUND_HALF_UP))


def _time(v, label):
    dt = mejvos.parse_time(v)
    if dt is None:
        raise ValueError(f"{label}: neplatný čas.")
    return dt.astimezone().isoformat(timespec="seconds")


def _int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _next_id(rows):
    return max((r["id"] for r in rows), default=0) + 1


def _find(rows, rid, label):
    for r in rows:
        if r["id"] == rid:
            return r
    raise LookupError(f"{label} neexistuje.")


def _plural(n, one, few, many):
    return f"{n} {one if n == 1 else few if 2 <= n <= 4 else many}"


def _cz_date(d):
    return f"{d.day}. {d.month}. {d.year}"


def seconds(entry, now=None):
    """Délka záznamu v sekundách; běžící záznam se počítá do teď."""
    start = mejvos.parse_time(entry["start"])
    end = mejvos.parse_time(entry["end"]) if entry.get("end") else (now or datetime.now().astimezone())
    return max(0, int((end - start).total_seconds()))


def rounded_hours(secs, minutes=0):
    """Hodiny na fakturu: přesně na setiny, nebo nahoru na celé úseky po `minutes` minutách."""
    if minutes:
        units = -(-secs // (minutes * 60))
        hours = Decimal(units * minutes) / 60
    else:
        hours = Decimal(secs) / 3600
    return float(hours.quantize(Decimal("0.01"), ROUND_HALF_UP))


# ---------- nastavení ----------

def get_settings(data):
    return {**DEFAULT_SETTINGS, **data.get("settings", {})}


def save_settings(data, values):
    s = get_settings(data)
    if "default_rate" in values:
        rate = _decimal(values["default_rate"], "Výchozí sazba")
        if rate < 0:
            raise ValueError("Výchozí sazba nemůže být záporná.")
        s["default_rate"] = float(rate)
    if "rounding" in values:
        if _int(values["rounding"]) not in ROUNDINGS:
            raise ValueError("Neplatné zaokrouhlení.")
        s["rounding"] = _int(values["rounding"])
    if "grouping" in values:
        if values["grouping"] not in GROUPINGS:
            raise ValueError("Neplatné seskupení položek.")
        s["grouping"] = values["grouping"]
    data["settings"] = s
    return s


# ---------- klienti ----------

def list_clients(data):
    stats = project_stats(data)
    linked = {}
    for peer in mejvos.peer_contacts(APP_ID):
        linked.setdefault(peer["uid"], []).append(peer["app_name"])
    out = []
    for c in data["clients"]:
        mine = [stats[p["id"]] for p in data["projects"] if p.get("client_id") == c["id"]]
        out.append({**c, "project_count": len(mine), "linked": sorted(set(linked.get(c["uid"], []))),
                    "seconds": sum(s["seconds"] for s in mine),
                    "unbilled_seconds": sum(s["unbilled_seconds"] for s in mine),
                    "unbilled_amount": round(sum(s["unbilled_amount"] for s in mine), 2)})
    return out


def get_client(data, cid):
    return _find(data["clients"], cid, "Klient")


def save_client(data, values, cid=None):
    """Nový nebo upravený klient. Klient převzatý z jiné aplikace (třeba z Faktur) má její uid,
    takže zůstanou propojení. Když už ho Hodinovka má, vrátí se ten existující."""
    clean = {k: _text(values.get(k)) for k in CLIENT_FIELDS}
    if not clean["name"]:
        raise ValueError("Vyplň název nebo jméno klienta.")
    now = mejvos.now()
    if cid is None:
        uid = _text(values.get("uid"))
        existing = next((c for c in data["clients"] if uid and c["uid"] == uid), None)
        if existing:
            return existing
        client = {"id": _next_id(data["clients"]), "uid": uid or mejvos.new_uid(), **clean,
                  "created_at": now, "updated_at": now}
        data["clients"].append(client)
        return client
    client = get_client(data, cid)
    client.update(clean, updated_at=now)
    return client


def delete_client(data, cid):
    client = get_client(data, cid)
    data["clients"].remove(client)
    for p in data["projects"]:
        if p.get("client_id") == cid:
            p["client_id"] = None  # projekty i jejich čas zůstanou


# ---------- projekty ----------

def list_projects(data):
    stats = project_stats(data)
    return [{**p, **stats[p["id"]]} for p in data["projects"]]


def get_project(data, pid):
    return _find(data["projects"], pid, "Projekt")


def save_project(data, values, pid=None):
    existing = get_project(data, pid) if pid is not None else None
    name = _text(values.get("name"))
    if not name:
        raise ValueError("Vyplň název projektu.")
    client_id = _int(values.get("client_id"))
    if client_id is not None and not any(c["id"] == client_id for c in data["clients"]):
        client_id = None  # klienta mezitím někdo smazal
    if any(p is not existing and p["name"].casefold() == name.casefold() and p.get("client_id") == client_id
           for p in data["projects"]):
        raise ValueError(f"Projekt {name} u tohoto klienta už existuje.")
    pricing = values.get("pricing") or "hourly"
    if pricing not in PRICINGS:
        raise ValueError("Neplatný způsob ceny.")
    rate = _decimal(values.get("rate") or 0, "Hodinová sazba")
    fixed = _decimal(values.get("fixed_price") or 0, "Pevná cena")
    if rate < 0 or fixed < 0:
        raise ValueError("Cena nemůže být záporná.")
    fields = {
        "name": name,
        "client_id": client_id,
        "pricing": pricing,
        "rate": _money(rate),
        "fixed_price": _money(fixed),
        "note": _text(values.get("note")),
        "archived": values.get("archived") is True,
        "updated_at": mejvos.now(),
    }
    if existing:
        existing.update(fields)
        return existing
    project = {"id": _next_id(data["projects"]), **fields,
               "color": len(data["projects"]) % COLORS, "created_at": mejvos.now()}
    data["projects"].append(project)
    return project


def delete_project(data, pid):
    project = get_project(data, pid)
    count = sum(1 for e in data["entries"] if e.get("project_id") == pid)
    if count:
        raise ValueError(f"Projekt má {_plural(count, 'záznam', 'záznamy', 'záznamů')}. "
                         f"Archivuj ho, nebo nejdřív smaž záznamy.")
    data["projects"].remove(project)


def project_stats(data, now=None):
    """Součty za každý projekt: čas celkem, nevyfakturovaný čas a částka, vyfakturovaná částka."""
    now = now or datetime.now().astimezone()
    out = {p["id"]: {"seconds": 0, "unbilled_seconds": 0, "entry_count": 0, "billed_amount": 0.0,
                     "fixed_billed": False} for p in data["projects"]}
    for e in data["entries"]:
        s = out.get(e.get("project_id"))
        if s is None:
            continue
        secs = seconds(e, now)
        s["seconds"] += secs
        s["entry_count"] += 1
        if not e.get("billing_id") and e.get("end"):
            s["unbilled_seconds"] += secs
    for b in data["billings"]:
        for it in b["items"]:
            s = out.get(it.get("project_id"))
            if s is None:
                continue
            s["billed_amount"] = round(s["billed_amount"] + it["amount"], 2)
            if it.get("kind") == "fixed" and it["amount"] > 0:
                s["fixed_billed"] = True
    for p in data["projects"]:
        s = out[p["id"]]
        if p["pricing"] == "fixed":
            s["unbilled_amount"] = p["fixed_price"] if not s["fixed_billed"] and s["unbilled_seconds"] else 0.0
        else:
            s["unbilled_amount"] = _money(Decimal(s["unbilled_seconds"]) / 3600 * Decimal(str(p["rate"])))
    return out


# ---------- záznamy a časovač ----------

def list_entries(data):
    return sorted(data["entries"], key=lambda e: (e["start"], e["id"]), reverse=True)


def get_entry(data, eid):
    return _find(data["entries"], eid, "Záznam")


def running(data):
    return next((e for e in data["entries"] if not e.get("end")), None)


def _project_id(data, value):
    pid = _int(value)
    if pid is not None and not any(p["id"] == pid for p in data["projects"]):
        raise ValueError("Vybraný projekt neexistuje.")
    return pid


def save_entry(data, values, eid=None):
    """Ručně přidaný nebo upravený záznam. U běžícího záznamu jde změnit i začátek, konec ne."""
    existing = get_entry(data, eid) if eid is not None else None
    is_running = existing is not None and not existing.get("end")
    old = existing or {}
    start = _time(values.get("start", old.get("start")), "Začátek")
    if is_running:
        end = None
        if mejvos.parse_time(start) > datetime.now().astimezone():
            raise ValueError("Běžící záznam nemůže začínat v budoucnu.")
    else:
        end = _time(values.get("end", old.get("end")), "Konec")
        if mejvos.parse_time(end) < mejvos.parse_time(start):
            raise ValueError("Konec nemůže být dřív než začátek.")
    fields = {
        "description": _text(values.get("description", old.get("description"))),
        "project_id": _project_id(data, values.get("project_id", old.get("project_id"))),
        "start": start,
        "end": end,
        "updated_at": mejvos.now(),
    }
    if existing:
        existing.update(fields)
        return existing
    entry = {"id": _next_id(data["entries"]), **fields, "billing_id": None, "created_at": mejvos.now()}
    data["entries"].append(entry)
    return entry


def delete_entry(data, eid):
    entry = get_entry(data, eid)
    data["entries"].remove(entry)
    for b in data["billings"]:
        if eid in b["entry_ids"]:
            b["entry_ids"].remove(eid)


def start_timer(data, values):
    """Spustí časovač. Když už nějaký běží, nejdřív ho zastaví (jako stopky: vždy běží jen jeden)."""
    stop_timer(data)
    now = mejvos.now()
    start = _time(values.get("start"), "Začátek") if values.get("start") else now
    entry = {
        "id": _next_id(data["entries"]),
        "description": _text(values.get("description")),
        "project_id": _project_id(data, values.get("project_id")),
        "start": start,
        "end": None,
        "billing_id": None,
        "created_at": now,
        "updated_at": now,
    }
    data["entries"].append(entry)
    return entry


def stop_timer(data):
    """Zastaví časovač. Když neběží (třeba se stoplo v jiném okně), nic se nestane a vrátí None."""
    entry = running(data)
    if not entry:
        return None
    now = mejvos.now()
    entry["end"] = max(now, entry["start"], key=lambda t: mejvos.parse_time(t))
    entry["updated_at"] = now
    return entry


# ---------- vyúčtování ----------

def _entry_label(e):
    when = mejvos.parse_time(e["start"]).astimezone()
    return f"„{e['description']}“ z {_cz_date(when)}" if e["description"] else f"z {_cz_date(when)}"


def _billable(data, entry_ids):
    ids = []
    for raw in entry_ids or []:
        i = _int(raw)
        if i is None:
            raise ValueError("Neplatný záznam.")
        if i not in ids:
            ids.append(i)
    if not ids:
        raise ValueError("Nevybral jsi žádný záznam.")
    rows = [get_entry(data, i) for i in ids]
    for e in rows:
        if not e.get("end"):
            raise ValueError("Běžící záznam nejde vyfakturovat – nejdřív zastav časovač.")
        if e.get("billing_id"):
            raise ValueError(f"Záznam {_entry_label(e)} už je vyfakturovaný.")
    return sorted(rows, key=lambda e: mejvos.parse_time(e["start"]))


def _item(description, quantity, unit, price, project_id, kind, secs):
    q, p = Decimal(str(quantity)), Decimal(str(price))
    return {"description": description, "quantity": float(q), "unit": unit, "price": float(p),
            "amount": _money(q * p), "project_id": project_id, "kind": kind, "seconds": secs}


def billing_preview(data, entry_ids, grouping=None):
    """Návrh faktury za vybrané záznamy: položky podle projektů a jejich cen, odběratel, období.
    Všechno jde před vystavením upravit – návrh jen ušetří práci."""
    s = get_settings(data)
    grouping = grouping if grouping in GROUPINGS else s["grouping"]
    rows = _billable(data, entry_ids)
    projects = {p["id"]: p for p in data["projects"]}
    stats = project_stats(data)
    groups = {}
    for e in rows:
        groups.setdefault(e.get("project_id") if e.get("project_id") in projects else None, []).append(e)
    multi = len(groups) > 1
    items, warnings = [], []

    for pid, part in groups.items():
        secs = sum(seconds(e) for e in part)
        p = projects.get(pid)
        if p is None:
            items.append(_item("Práce", rounded_hours(secs, s["rounding"]), "hod", 0, None, "hourly", secs))
            warnings.append(f"{_plural(len(part), 'záznam nemá', 'záznamy nemají', 'záznamů nemá')} projekt, "
                            f"a tak ani cenu – doplň ji u položky „Práce“.")
            continue
        if p["pricing"] == "fixed":
            done = stats[pid]["fixed_billed"]
            items.append(_item(p["name"], 1, "", 0 if done else p["fixed_price"], pid, "fixed", secs))
            if done:
                warnings.append(f"Pevná cena projektu {p['name']} už je vyfakturovaná, a tak je položka za 0 Kč. "
                                f"Když fakturuješ další část, uprav cenu.")
            elif not p["fixed_price"]:
                warnings.append(f"Projekt {p['name']} nemá vyplněnou pevnou cenu.")
            continue
        if not p["rate"]:
            warnings.append(f"Projekt {p['name']} nemá hodinovou sazbu – doplň cenu u položky, nebo ji nastav u projektu.")
        if grouping == "description":
            by_text = {}
            for e in part:
                by_text.setdefault(e["description"] or p["name"], []).append(e)
            for text, same in by_text.items():
                label = f"{p['name']}: {text}" if multi and text != p["name"] else text
                t = sum(seconds(e) for e in same)
                items.append(_item(label, rounded_hours(t, s["rounding"]), "hod", p["rate"], pid, "hourly", t))
        else:
            items.append(_item(p["name"], rounded_hours(secs, s["rounding"]), "hod", p["rate"], pid, "hourly", secs))

    client_ids = []
    for pid in groups:
        cid = projects[pid].get("client_id") if pid in projects else None
        if cid is not None and cid not in client_ids:
            client_ids.append(cid)
    clients = [get_client(data, cid) for cid in client_ids]
    if len(clients) > 1:
        warnings.append(f"Záznamy patří různým klientům ({', '.join(c['name'] for c in clients)}). "
                        f"Faktura bude na jednoho odběratele.")
    customer = {"uid": clients[0]["uid"], **{k: clients[0].get(k, "") for k in CUSTOMER_FIELDS}} if clients else None

    first = mejvos.parse_time(rows[0]["start"]).astimezone().date()
    last = max(mejvos.parse_time(e["end"]).astimezone().date() for e in rows)
    if first == last:
        period = _cz_date(first)
    elif first.year == last.year:
        period = f"{first.day}. {first.month}. – {_cz_date(last)}"
    else:
        period = f"{_cz_date(first)} – {_cz_date(last)}"

    return {
        "entry_ids": [e["id"] for e in rows],
        "grouping": grouping,
        "items": items,
        "total": _money(sum((Decimal(str(i["amount"])) for i in items), Decimal(0))),
        "seconds": sum(seconds(e) for e in rows),
        "customer": customer,
        "client_id": clients[0]["id"] if clients else None,
        "warnings": warnings,
        "period": [first.isoformat(), last.isoformat()],
        "note": f"Období: {period}",
    }


def _clean_items(items):
    out = []
    for i, it in enumerate(items or [], 1):
        desc = _text(it.get("description"))
        if not desc and not _text(it.get("price")):
            continue  # prázdný řádek
        if not desc:
            raise ValueError(f"Položka {i}: chybí popis.")
        qty = _decimal(it.get("quantity", 1), f"Položka {i}, množství")
        price = _decimal(it.get("price", 0), f"Položka {i}, cena")
        out.append({
            "description": desc,
            "quantity": float(qty),
            "unit": _text(it.get("unit")),
            "price": float(price),
            "amount": _money(qty * price),
            "project_id": _int(it.get("project_id")),
            "kind": it.get("kind") if it.get("kind") in ("hourly", "fixed") else "",
            "seconds": _int(it.get("seconds")) or 0,
        })
    return out


def find_billing(data, ref):
    """Vyúčtování podle čísla (id) nebo uid."""
    for b in data["billings"]:
        if b["id"] == ref or b["uid"] == ref:
            return b
    raise LookupError("Vyúčtování neexistuje.")


def check_billing(data, values):
    """Ověří a vyčistí vyúčtování ještě před vystavením faktury, ať pak uložení nemůže selhat.
    Bez položek (jen „označit jako vyfakturované“) se položky spočítají samy."""
    rows = _billable(data, values.get("entry_ids"))
    preview = billing_preview(data, [e["id"] for e in rows], values.get("grouping"))
    items = _clean_items(values["items"]) if values.get("items") is not None else preview["items"]
    given = values.get("customer") or preview["customer"] or {}
    customer = {k: _text(given.get(k)) for k in CUSTOMER_FIELDS}
    customer["uid"] = _text(given.get("uid"))
    total = _money(sum((Decimal(str(i["amount"])) for i in items), Decimal(0)))
    if values.get("invoice"):
        if not customer["name"]:
            raise ValueError("Vyber nebo vyplň odběratele.")
        if not items:
            raise ValueError("Faktura musí mít aspoň jednu položku.")
        if total <= 0:
            raise ValueError("Faktura by byla na 0 Kč. Doplň ceny, nebo záznamy jen označ jako vyfakturované.")
    client_id = _int(values.get("client_id", preview["client_id"]))
    return {
        "uid": _text(values.get("uid")) or mejvos.new_uid(),
        "entry_ids": [e["id"] for e in rows],
        "items": items,
        "total": total,
        "seconds": preview["seconds"],
        "period": preview["period"],
        "customer": customer if customer["name"] else None,
        "client_id": client_id if any(c["id"] == client_id for c in data["clients"]) else None,
        "note": _text(values.get("note")),
    }


def create_billing(data, checked, invoice=None):
    """Uloží vyúčtování (z check_billing) a označí jeho záznamy jako vyfakturované.
    invoice = odkaz na fakturu v jiné aplikaci, nebo None (označeno ručně)."""
    billing = {"id": _next_id(data["billings"]), **checked, "invoice": invoice, "created_at": mejvos.now()}
    data["billings"].append(billing)
    for eid in checked["entry_ids"]:
        e = get_entry(data, eid)
        e["billing_id"] = billing["id"]
        e["updated_at"] = billing["created_at"]
    return billing


def delete_billing(data, ref):
    """Vrátí záznamy vyúčtování mezi nevyfakturované. Faktura v jiné aplikaci zůstane, jak je."""
    billing = find_billing(data, ref)
    data["billings"].remove(billing)
    count = 0
    for e in data["entries"]:
        if e.get("billing_id") == billing["id"]:
            e["billing_id"] = None
            e["updated_at"] = mejvos.now()
            count += 1
    return {"returned": count}


def list_billings(data):
    return sorted(data["billings"], key=lambda b: (b["created_at"], b["id"]), reverse=True)


# ---------- výkaz práce (CSV) ----------

def entries_csv(data, entries):
    """Výkaz práce pro Excel/Numbers: středník a desetinná čárka, jak to čeká česká verze."""
    projects = {p["id"]: p for p in data["projects"]}
    clients = {c["id"]: c for c in data["clients"]}
    billings = {b["id"]: b for b in data["billings"]}
    out = io.StringIO()
    w = csv.writer(out, delimiter=";", lineterminator="\r\n")
    w.writerow(["Datum", "Od", "Do", "Hodiny", "Popis", "Projekt", "Klient", "Vyfakturováno"])
    for e in sorted(entries, key=lambda e: e["start"]):
        if not e.get("end"):
            continue
        start, end = mejvos.parse_time(e["start"]).astimezone(), mejvos.parse_time(e["end"]).astimezone()
        p = projects.get(e.get("project_id")) or {}
        c = clients.get(p.get("client_id")) or {}
        b = billings.get(e.get("billing_id"))
        billed = ""
        if b:
            billed = f"faktura {b['invoice']['number']}" if b.get("invoice") else f"ano ({_cz_date(mejvos.parse_time(b['created_at']).date())})"
        w.writerow([_cz_date(start), start.strftime("%H:%M"), end.strftime("%H:%M"),
                    f"{seconds(e) / 3600:.2f}".replace(".", ","), e["description"], p.get("name", ""),
                    c.get("name", ""), billed])
    return "﻿" + out.getvalue()
