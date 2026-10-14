#!/usr/bin/env python3
"""Hodinovka – lokální server. Spuštění: python3 server.py [--open]"""
import json
import mimetypes
import os
import re
import sys
import urllib.error
import urllib.request
import webbrowser
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import db
import mejvos
import update

PORT = int(os.environ.get("HODINOVKA_PORT", "8766"))
STATIC = db.ROOT / "static"
ALLOWED_HOSTS = {f"localhost:{PORT}", f"127.0.0.1:{PORT}"}
MAX_BODY = 5 * 1024 * 1024
NAME = "Hodinovka"
PROVIDES = ("contacts", "time")


def ares_lookup(ico):
    """Dohledá firmu v registru ARES podle IČO."""
    ico = re.sub(r"\D", "", ico)
    if not ico or len(ico) > 8:
        raise ValueError("IČO má mít až 8 číslic.")
    ico = ico.zfill(8)
    url = f"https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/{ico}"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            d = json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise LookupError(f"IČO {ico} v ARES neexistuje.")
        raise ValueError(f"ARES neodpovídá (chyba {e.code}).")
    except (urllib.error.URLError, TimeoutError):
        raise ValueError("ARES je nedostupný – jsi připojený k internetu?")

    s = d.get("sidlo") or {}
    street = s.get("nazevUlice") or s.get("nazevCastiObce") or s.get("nazevObce") or ""
    number = str(s.get("cisloDomovni") or "")
    if s.get("cisloOrientacni"):
        number += f"/{s['cisloOrientacni']}{s.get('cisloOrientacniPismeno') or ''}"
    city = s.get("nazevObce") or ""
    if city == "Praha" and s.get("nazevMestskehoObvodu"):
        city = s["nazevMestskehoObvodu"]
    psc = str(s.get("psc") or "")
    return {
        "name": d.get("obchodniJmeno") or "",
        "ico": d.get("ico") or ico,
        "dic": d.get("dic") or "",
        "street": f"{street} {number}".strip(),
        "city": city,
        "zip": f"{psc[:3]} {psc[3:]}" if len(psc) == 5 else psc,
        "country": "" if (s.get("kodStatu") or "CZ") == "CZ" else (s.get("nazevStatu") or ""),
    }


# ---------- vyúčtování a faktury ----------

def bill(body):
    """Vyúčtuje záznamy: buď jen označí jako vyfakturované, nebo rovnou vystaví fakturu ve Fakturách.
    Zámek dat drží celou dobu, takže stejné záznamy nejdou vyfakturovat dvakrát. Faktury podle uid
    poznají opakovaný požadavek (třeba po výpadku) a vrátí už vystavenou fakturu místo nové."""
    with db.open_data(write=True) as data:
        uid = db._text(body.get("uid"))
        for b in data["billings"]:
            if uid and b["uid"] == uid:
                return b
        checked = db.check_billing(data, body)
        invoice = None
        if body.get("invoice"):
            app = mejvos.ensure("invoices", exclude=db.APP_ID)
            if not app:
                raise ValueError("Na tomhle Macu nejsou Faktury. Stáhni je, nebo záznamy jen označ jako vyfakturované.")
            created = mejvos.call(app, "POST", "invoices", {
                "customer": checked["customer"],
                "items": [{k: it[k] for k in ("description", "quantity", "unit", "price")} for it in checked["items"]],
                "note": checked["note"],
                "source": {"app": db.APP_ID, "name": NAME, "ref": checked["uid"],
                           "link": f"{db.APP_ID}://vyuctovani/{checked['uid']}"},
            })
            invoice = {"app": app["id"], "app_name": app.get("name") or app["id"], "id": created["id"],
                       "number": created["number"], "scheme": app.get("scheme") or app["id"]}
        return db.create_billing(data, checked, invoice)


def with_invoice_state(billings):
    """Ke každému vyúčtování s fakturou přidá její stav ve Fakturách (zaplaceno, stornováno, smazáno…)."""
    states = db.invoice_states()
    out = []
    for b in billings:
        state = None
        inv = b.get("invoice")
        if inv:
            app = states.get(inv["app"])
            row = app and app["rows"].get(b["uid"])
            if app is None:
                state = {"status": "unknown"}
            elif row:
                state = {k: row.get(k) for k in ("status", "number", "due_date", "paid_date", "total", "id")}
            else:
                state = {"status": "deleted"}
        out.append({**b, "invoice_state": state})
    return out


def peers():
    """Ostatní aplikace systému pro Nastavení a vyúčtování. ready = Faktury mají vyplněné údaje dodavatele."""
    out = mejvos.overview(db.APP_ID)
    states = db.invoice_states()
    for a in out["apps"]:
        a["ready"] = (states.get(a["id"]) or {}).get("ready")
    return out


def filter_entries(data, q):
    """Záznamy pro výkaz práce podle filtru v adrese (projekt, klient, stav, od, do, vyúčtování)."""
    one = lambda k: (q.get(k) or [""])[0]  # noqa: E731
    rows = [e for e in data["entries"] if e.get("end")]
    projects = {p["id"]: p for p in data["projects"]}
    if one("vyuctovani"):
        b = db.find_billing(data, int(one("vyuctovani")) if one("vyuctovani").isdigit() else one("vyuctovani"))
        rows = [e for e in rows if e.get("billing_id") == b["id"]]
    if one("projekt").isdigit():
        rows = [e for e in rows if e.get("project_id") == int(one("projekt"))]
    if one("klient").isdigit():
        rows = [e for e in rows if (projects.get(e.get("project_id")) or {}).get("client_id") == int(one("klient"))]
    if one("stav") == "nevyfakturovane":
        rows = [e for e in rows if not e.get("billing_id")]
    elif one("stav") == "vyfakturovane":
        rows = [e for e in rows if e.get("billing_id")]
    day = lambda e: mejvos.parse_time(e["start"]).astimezone().date().isoformat()  # noqa: E731
    if one("od"):
        rows = [e for e in rows if day(e) >= one("od")]
    if one("do"):
        rows = [e for e in rows if day(e) <= one("do")]
    return rows


class Handler(BaseHTTPRequestHandler):
    server_version = NAME

    # ---------- odpovědi ----------

    def send_body(self, body, ctype, status=200, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, data, status=200, headers=None):
        self.send_body(json.dumps(data, ensure_ascii=False).encode(), "application/json; charset=utf-8", status, headers)

    def send_error_json(self, status, message):
        self.send_json({"error": message}, status)

    def send_file(self, path, root):
        try:
            path = path.resolve()
            path.relative_to(root.resolve())
        except ValueError:
            return self.send_error_json(404, "Nenalezeno.")
        if not path.is_file():
            return self.send_error_json(404, "Nenalezeno.")
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        if not (self.headers.get("Content-Type") or "").startswith("application/json"):
            raise ValueError("Očekávám JSON.")
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ValueError("Požadavek je moc velký.")
        return json.loads(self.rfile.read(length) or b"{}") if length else {}

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else "") and not str(args[1]).startswith("2"):
            super().log_message(fmt, *args)

    # ---------- zabezpečení ----------

    def is_trusted(self):
        """Server poslouchá jen na tomto Macu; navíc odmítne požadavky z cizích webů."""
        if self.headers.get("Host") not in ALLOWED_HOSTS:
            return False
        origin = self.headers.get("Origin")
        if self.command != "GET" and origin and urlparse(origin).netloc not in ALLOWED_HOSTS:
            return False
        return True

    # ---------- směrování ----------

    def do_GET(self):
        self.dispatch()

    def do_POST(self):
        self.dispatch()

    def do_PUT(self):
        self.dispatch()

    def do_DELETE(self):
        self.dispatch()

    def dispatch(self):
        if not self.is_trusted():
            return self.send_error_json(403, "Zakázáno.")
        url = urlparse(self.path)
        path = unquote(url.path)
        try:
            if path.startswith("/api/"):
                return self.api(self.command, path[5:].strip("/").split("/"), parse_qs(url.query))
            if self.command != "GET":
                return self.send_error_json(405, "Nepovolená metoda.")
            return self.send_file(STATIC / (path.lstrip("/") or "index.html"), STATIC)
        except LookupError as e:
            self.send_error_json(404, str(e))
        except (ValueError, RuntimeError) as e:
            self.send_error_json(400, str(e))
        except Exception as e:  # noqa: BLE001 – ať appka nespadne, chybu ukážeme
            self.log_error("Chyba: %r", e)
            self.send_error_json(500, f"Neočekávaná chyba: {e}")

    def api(self, method, parts, query):
        res, rid, sub = (parts + [None, None])[:3]
        rid = int(rid) if rid and rid.isdigit() else rid

        # Věci, které nesahají na data, běží mimo zámek (ARES i ostatní aplikace můžou chvíli trvat).
        if res == "ares" and method == "GET" and rid is not None:
            return self.send_json(ares_lookup(str(rid)))
        if res == "version" and method == "GET":
            return self.send_json({"version": update.current_version()})
        if res == "update" and rid is None:
            if method == "GET":
                return self.send_json(update.status())
            if method == "POST":
                self.read_json()
                self.send_json(update.install())
                return update.restart_later()  # nový kód se načte restartem serveru
        if res == "peers" and method == "GET" and rid is None:
            return self.send_json(peers())
        if res == "peers" and method == "POST" and isinstance(rid, str) and sub == "install":
            self.read_json()
            mejvos.install(rid)
            return self.send_json(peers())
        if res == "peers" and method == "POST" and isinstance(rid, str) and sub == "open":
            self.read_json()
            mejvos.open_app(rid)
            return self.send_json({"ok": True})
        if res == "os" and method == "GET" and rid is None:
            return self.send_json({"id": db.APP_ID, "name": NAME, "version": update.current_version(),
                                   "protocol": mejvos.PROTOCOL, "provides": list(PROVIDES)})

        db.sync_peers()
        body = self.read_json() if method in ("POST", "PUT") else None
        if res == "billings" and method == "POST" and rid is None:
            return self.send_json(bill(body), 201)
        if res == "export" and rid == "csv" and method == "GET":
            with db.open_data() as data:
                text = db.entries_csv(data, filter_entries(data, query))
            name = f"vykaz-prace-{date.today().isoformat()}.csv"
            return self.send_body(text.encode("utf-8"), "text/csv; charset=utf-8",
                                  headers={"Content-Disposition": f'attachment; filename="{name}"'})

        status, headers = 200, None
        # Odpověď se pošle až po úspěšném uložení – při chybě se neuloží nic.
        with db.open_data(write=method != "GET") as data:
            result = self.route(data, method, res, rid, sub, body)
        if result is None:
            return self.send_error_json(404, "Neznámá adresa.")
        if isinstance(result, tuple):
            result, status, headers = result
        if res == "billings" and isinstance(result, list):
            result = with_invoice_state(result)
        elif res == "billings" and "uid" in result:
            result = with_invoice_state([result])[0]
        self.send_json(result, status, headers)

    @staticmethod
    def route(data, method, res, rid, sub, body):
        if res == "settings":
            if method == "GET":
                return db.get_settings(data)
            if method == "PUT":
                return db.save_settings(data, body)

        elif res == "clients":
            if method == "GET" and rid is None:
                return db.list_clients(data)
            if method == "POST" and rid is None:
                return db.save_client(data, body), 201, None
            if isinstance(rid, int):
                if method == "GET":
                    return db.get_client(data, rid)
                if method == "PUT":
                    return db.save_client(data, body, rid)
                if method == "DELETE":
                    db.delete_client(data, rid)
                    return {"ok": True}

        elif res == "offered" and method == "GET":
            return db.offered_contacts(data)

        elif res == "projects":
            if method == "GET" and rid is None:
                return db.list_projects(data)
            if method == "POST" and rid is None:
                return db.save_project(data, body), 201, None
            if isinstance(rid, int):
                if method == "GET":
                    db.get_project(data, rid)
                    return next(p for p in db.list_projects(data) if p["id"] == rid)
                if method == "PUT":
                    return db.save_project(data, body, rid)
                if method == "DELETE":
                    db.delete_project(data, rid)
                    return {"ok": True}

        elif res == "entries":
            if method == "GET" and rid is None:
                return db.list_entries(data)
            if method == "POST" and rid is None:
                return db.save_entry(data, body), 201, None
            if isinstance(rid, int):
                if method == "GET":
                    return db.get_entry(data, rid)
                if method == "PUT":
                    return db.save_entry(data, body, rid)
                if method == "DELETE":
                    db.delete_entry(data, rid)
                    return {"ok": True}

        elif res == "timer":
            if method == "GET" and rid is None:
                return {"entry": db.running(data)}
            if method == "POST" and rid == "start":
                return {"entry": db.start_timer(data, body)}
            if method == "POST" and rid == "stop":
                return {"entry": None, "stopped": db.stop_timer(data)}

        elif res == "billings":
            if method == "GET" and rid is None:
                return db.list_billings(data)
            if method == "POST" and rid == "preview":
                return db.billing_preview(data, body.get("entry_ids"), body.get("grouping"))
            if rid is not None and method == "GET":
                return db.find_billing(data, rid)
            if rid is not None and method == "DELETE":
                return db.delete_billing(data, rid)

        elif res == "os" and rid == "contacts" and method == "GET":
            return [mejvos.contact(c) for c in data["clients"]]

        elif res == "zaloha" and method == "GET":
            return {**db.cloud_status, "data": str(db.DATA).replace(str(Path.home()), "~", 1)}

        elif res == "export" and rid is None and method == "GET":
            name = f"hodinovka-zaloha-{date.today().isoformat()}.json"
            return data, 200, {"Content-Disposition": f'attachment; filename="{name}"'}

        return None


def main():
    db.init()
    db.daily_backup()
    test_data = os.environ.get("HODINOVKA_DATA")
    # Kopie do iCloud Drive; testovací data jen když ji výslovně zapne HODINOVKA_ICLOUD.
    cloud = os.environ.get("HODINOVKA_ICLOUD") or ("" if test_data else str(db.ICLOUD_DEFAULT))
    if cloud:
        db.start_cloud_backup(cloud)
    # Do sdíleného systému se testovací data přihlásí, jen když mají vlastní MEJVOS_DIR.
    mejvos.ENABLED = not test_data or bool(os.environ.get("MEJVOS_DIR"))
    try:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError:
        sys.exit(f"Port {PORT} je obsazený – Hodinovka už nejspíš běží. "
                 f"Otevři http://localhost:{PORT}")
    url = f"http://localhost:{PORT}"
    (db.DATA / "server.pid").write_text(str(os.getpid()))  # spouštěč podle něj pozná starou verzi
    mejvos.announce(db.APP_ID, name=NAME, version=update.current_version(), port=PORT, root=db.ROOT,
                    provides=PROVIDES, env={"HODINOVKA_APP": os.environ.get("HODINOVKA_APP")})
    with db.open_data() as data:
        db.publish(data)
    print(f"Hodinovka běží na {url}")
    print("Data:", db.DATA)
    print("Vypnutí: zavři toto okno (nebo Ctrl+C).")
    if "--open" in sys.argv:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nHodinovka vypnuta.")


if __name__ == "__main__":
    main()
