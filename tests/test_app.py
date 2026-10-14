"""Testy dat, propojení aplikací (MejvOS) a serveru. Spuštění: python3 -m unittest discover tests"""
import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import zipfile
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db  # noqa: E402
import mejvos  # noqa: E402
import server  # noqa: E402
import update  # noqa: E402

TODAY = date.today().isoformat()


def at(day_offset=0, hour=9, minute=0):
    """Čas s pásmem, jak ho posílá prohlížeč."""
    d = datetime.now().astimezone().replace(hour=hour, minute=minute, second=0, microsecond=0) + timedelta(days=day_offset)
    return d.isoformat()


class TempData(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self._orig = {k: getattr(db, k) for k in ("DATA", "DATA_FILE", "ZALOHY", "ICLOUD")}
        self._mejvos = (mejvos.HOME, mejvos.ENABLED)
        db.ICLOUD = None  # testy se nikdy nesmí dotknout skutečného iCloudu
        db.DATA = root / "data"
        db.DATA_FILE = db.DATA / "hodinovka.json"
        db.ZALOHY = db.DATA / "zalohy"
        db._peer_sig = None
        mejvos.HOME = root / "MejvOS"  # ani skutečného systému MejvOS
        mejvos.ENABLED = False
        db.init()

    def tearDown(self):
        for k, v in self._orig.items():
            setattr(db, k, v)
        mejvos.HOME, mejvos.ENABLED = self._mejvos
        self.tmp.cleanup()

    def stored(self):
        return json.loads(db.DATA_FILE.read_text(encoding="utf-8"))

    def setup_project(self, data, pricing="hourly", **extra):
        client = db.save_client(data, {"name": "Kavárna"})
        project = db.save_project(data, {"name": "Web", "client_id": client["id"], "pricing": pricing,
                                         "rate": "800", "fixed_price": "10 000", **extra})
        return client, project

    def entry(self, data, project, start=None, minutes=90, description="Práce"):
        start = start or at(-1)
        end = (datetime.fromisoformat(start) + timedelta(minutes=minutes)).isoformat()
        return db.save_entry(data, {"project_id": project["id"] if project else None, "description": description,
                                    "start": start, "end": end})


class DataTests(TempData):
    def test_init_creates_readable_file(self):
        data = self.stored()
        self.assertEqual(data["entries"], [])
        self.assertEqual(data["settings"]["rounding"], 0)

    def test_clients_need_only_a_name(self):
        with db.open_data(True) as data:
            with self.assertRaisesRegex(ValueError, "Vyplň název"):
                db.save_client(data, {"ico": "123"})
            c = db.save_client(data, {"name": " Petra Malá "})
            self.assertEqual((c["name"], c["ico"]), ("Petra Malá", ""))
            self.assertTrue(c["uid"])
            # klient převzatý z jiné aplikace (stejné uid) se nezdvojí
            a = db.save_client(data, {"name": "Firma", "uid": "abc"})
            b = db.save_client(data, {"name": "Firma", "uid": "abc"})
            self.assertIs(a, b)
            self.assertEqual(len(data["clients"]), 2)

    def test_project_validation_and_pricing(self):
        with db.open_data(True) as data:
            client, p = self.setup_project(data, pricing="fixed")
            self.assertEqual((p["pricing"], p["fixed_price"], p["rate"]), ("fixed", 10000.0, 800.0))
            with self.assertRaisesRegex(ValueError, "už existuje"):
                db.save_project(data, {"name": "web", "client_id": client["id"]})
            with self.assertRaisesRegex(ValueError, "způsob ceny"):
                db.save_project(data, {"name": "Jiný", "pricing": "zdarma"})
            with self.assertRaisesRegex(ValueError, "záporná"):
                db.save_project(data, {"name": "Jiný", "rate": "-5"})
            other = db.save_project(data, {"name": "Web", "client_id": 999})  # neexistující klient → bez klienta
            self.assertIsNone(other["client_id"])

    def test_entry_times_with_timezones(self):
        with db.open_data(True) as data:
            _, p = self.setup_project(data)
            e = db.save_entry(data, {"project_id": p["id"], "start": "2026-03-28T23:30:00Z", "end": "2026-03-29T01:00:00Z"})
            self.assertEqual(db.seconds(e), 5400)
            self.assertIn("+", e["start"][19:] + "+")  # uloženo i s pásmem
            with self.assertRaisesRegex(ValueError, "dřív než začátek"):
                db.save_entry(data, {"start": at(0, 10), "end": at(0, 9)})
            with self.assertRaisesRegex(ValueError, "neplatný čas"):
                db.save_entry(data, {"start": "včera", "end": at()})
            with self.assertRaisesRegex(ValueError, "projekt neexistuje"):
                db.save_entry(data, {"project_id": 99, "start": at(0, 8), "end": at(0, 9)})
            # úprava jen popisu nechá časy, jak jsou
            changed = db.save_entry(data, {"description": "Nový popis"}, e["id"])
            self.assertEqual((changed["description"], db.seconds(changed)), ("Nový popis", 5400))

    def test_timer_runs_one_at_a_time(self):
        with db.open_data(True) as data:
            _, p = self.setup_project(data)
            first = db.start_timer(data, {"description": "A", "project_id": p["id"]})
            second = db.start_timer(data, {"description": "B"})
            self.assertIsNotNone(first["end"])  # spuštění dalšího ten první zastaví
            self.assertIs(db.running(data), second)
            stopped = db.stop_timer(data)
            self.assertIs(stopped, second)
            self.assertIsNone(db.stop_timer(data))  # druhé zastavení (třeba z jiného okna) nic neudělá
            with self.assertRaisesRegex(ValueError, "budoucnu"):
                running = db.start_timer(data, {})
                db.save_entry(data, {"start": at(1)}, running["id"])

    def test_rounded_hours(self):
        self.assertEqual(db.rounded_hours(4800), 1.33)
        self.assertEqual(db.rounded_hours(4801, 15), 1.5)
        self.assertEqual(db.rounded_hours(4500, 15), 1.25)
        self.assertEqual(db.rounded_hours(61, 6), 0.1)
        self.assertEqual(db.rounded_hours(3600, 60), 1.0)
        self.assertEqual(db.rounded_hours(0, 30), 0.0)

    def test_preview_groups_entries_by_project_and_description(self):
        with db.open_data(True) as data:
            _, web = self.setup_project(data)
            fixed = db.save_project(data, {"name": "Logo", "pricing": "fixed", "fixed_price": 5000})
            a = self.entry(data, web, at(-2), 90, "Úprava menu")
            b = self.entry(data, web, at(-1), 30, "Úprava menu")
            c = self.entry(data, web, at(-1, 13), 45, "Reference")
            d = self.entry(data, fixed, at(-1, 15), 600, "Návrh")
            ids = [a["id"], b["id"], c["id"], d["id"]]
            p = db.billing_preview(data, ids)
            self.assertEqual([(i["description"], i["quantity"], i["price"]) for i in p["items"]],
                             [("Web – Úprava menu, Reference", 2.75, 800.0), ("Logo – Návrh", 1.0, 5000.0)])
            self.assertEqual(p["total"], 7200.0)
            self.assertEqual(p["customer"]["name"], "Kavárna")
            self.assertTrue(p["note"].startswith("Období: "))
            p = db.billing_preview(data, ids, "description")
            self.assertEqual([(i["description"], i["quantity"]) for i in p["items"]],
                             [("Web: Úprava menu", 2.0), ("Web: Reference", 0.75), ("Logo – Návrh", 1.0)])
            db.save_settings(data, {"rounding": 60})
            self.assertEqual(db.billing_preview(data, [c["id"]])["items"][0]["quantity"], 1.0)

    def test_item_text_says_what_was_done(self):
        with db.open_data(True) as data:
            _, web = self.setup_project(data)
            quiet = self.entry(data, web, at(-3), 30, "")
            self.assertEqual(db.billing_preview(data, [quiet["id"]])["items"][0]["description"], "Práce na projektu Web")
            many = [self.entry(data, web, at(-2, 8, i), 1, f"Úkol číslo {i:02d}") for i in range(20)]
            text = db.billing_preview(data, [quiet["id"]] + [e["id"] for e in many])["items"][0]["description"]
            self.assertTrue(text.startswith("Web – Úkol číslo 00, Úkol číslo 01, "))
            self.assertTrue(text.endswith(" a další"))
            self.assertLessEqual(len(text), db.ITEM_TEXT + len(" a další"))
            loose = self.entry(data, None, at(-1, 15), 60, "Konzultace")
            self.assertEqual(db.billing_preview(data, [loose["id"]])["items"][0]["description"], "Práce – Konzultace")

    def test_preview_warnings(self):
        with db.open_data(True) as data:
            other = db.save_client(data, {"name": "Jiná firma"})
            _, web = self.setup_project(data, rate="0")
            design = db.save_project(data, {"name": "Design", "client_id": other["id"], "rate": 500})
            e1, e2 = self.entry(data, web), self.entry(data, design, at(-1, 13))
            e3 = self.entry(data, None, at(-1, 15))
            warnings = " ".join(db.billing_preview(data, [e1["id"], e2["id"], e3["id"]])["warnings"])
            self.assertIn("nemá hodinovou sazbu", warnings)
            self.assertIn("různým klientům", warnings)
            self.assertIn("nemá projekt", warnings)
            running = db.start_timer(data, {})
            with self.assertRaisesRegex(ValueError, "Běžící záznam"):
                db.billing_preview(data, [running["id"]])
            with self.assertRaisesRegex(ValueError, "Nevybral"):
                db.billing_preview(data, [])

    def test_fixed_price_is_billed_once(self):
        with db.open_data(True) as data:
            _, logo = self.setup_project(data, pricing="fixed")
            first = self.entry(data, logo)
            db.create_billing(data, db.check_billing(data, {"entry_ids": [first["id"]]}))
            stats = db.project_stats(data)[logo["id"]]
            self.assertEqual((stats["fixed_billed"], stats["billed_amount"], stats["unbilled_amount"]), (True, 10000.0, 0.0))
            later = self.entry(data, logo, at(0, 7))
            p = db.billing_preview(data, [later["id"]])
            self.assertEqual(p["items"][0]["price"], 0.0)
            self.assertIn("už je vyfakturovaná", p["warnings"][0])
            with self.assertRaisesRegex(ValueError, "0 Kč"):
                db.check_billing(data, {"entry_ids": [later["id"]]})

    def test_billing_marks_and_unmarks_entries(self):
        with db.open_data(True) as data:
            _, web = self.setup_project(data)
            e = self.entry(data, web)
            stats = db.project_stats(data)[web["id"]]
            self.assertEqual((stats["unbilled_seconds"], stats["unbilled_amount"]), (5400, 1200.0))
            b = db.create_billing(data, db.check_billing(data, {"entry_ids": [e["id"]]}))
            self.assertEqual((b["total"], b["invoice"], e["billing_id"]), (1200.0, None, b["id"]))
            with self.assertRaisesRegex(ValueError, "už je vyfakturovaný"):
                db.check_billing(data, {"entry_ids": [e["id"]]})
            self.assertEqual(db.project_stats(data)[web["id"]]["unbilled_amount"], 0.0)
            self.assertEqual(db.delete_billing(data, b["uid"]), {"returned": 1})
            self.assertIsNone(e["billing_id"])
            self.assertEqual(data["billings"], [])

    def test_custom_customer_and_items(self):
        """Fakturace na jinou firmu a s upravenými položkami nesmí nic rozbít."""
        with db.open_data(True) as data:
            _, web = self.setup_project(data)
            e = self.entry(data, web)
            checked = db.check_billing(data, {
                "entry_ids": [e["id"]],
                "customer": {"name": "Holding a.s.", "ico": "12345678"},
                "items": [{"description": "Záloha", "quantity": "1", "price": "2 500,50"}, {"description": "", "price": ""}],
            })
            self.assertEqual((checked["customer"]["name"], checked["total"], len(checked["items"])), ("Holding a.s.", 2500.5, 1))
            with self.assertRaisesRegex(ValueError, "odběratele"):
                db.check_billing(data, {"entry_ids": [e["id"]], "customer": {"name": ""},
                                        "items": [{"description": "x", "price": 1}]})
            with self.assertRaisesRegex(ValueError, "není číslo"):
                db.check_billing(data, {"entry_ids": [e["id"]], "items": [{"description": "x", "price": "abc"}]})

    def test_delete_many_entries(self):
        with db.open_data(True) as data:
            _, web = self.setup_project(data)
            a, b = self.entry(data, web), self.entry(data, web, at(-2))
        with self.assertRaises(LookupError), db.open_data(True) as data:
            db.delete_entries(data, [a["id"], 999])
        self.assertEqual(len(self.stored()["entries"]), 2)  # buď všechny, nebo žádný
        with self.assertRaisesRegex(ValueError, "Nevybral"), db.open_data(True) as data:
            db.delete_entries(data, [])
        with db.open_data(True) as data:
            self.assertEqual(db.delete_entries(data, [a["id"], str(b["id"]), a["id"]]), {"deleted": 2})
            self.assertEqual(data["entries"], [])

    def test_delete_rules(self):
        with db.open_data(True) as data:
            client, web = self.setup_project(data)
            e = self.entry(data, web)
            b = db.create_billing(data, db.check_billing(data, {"entry_ids": [e["id"]]}))
            with self.assertRaisesRegex(ValueError, "Archivuj"):
                db.delete_project(data, web["id"])
            db.delete_client(data, client["id"])  # projekt i čas zůstanou
            self.assertIsNone(web["client_id"])
            db.delete_entry(data, e["id"])
            self.assertEqual(b["entry_ids"], [])
            db.delete_project(data, web["id"])
            self.assertEqual(data["projects"], [])

    def test_csv_report(self):
        with db.open_data(True) as data:
            _, web = self.setup_project(data)
            self.entry(data, web, at(-1, 9), 90, "Úprava; menu")
            db.start_timer(data, {})  # běžící záznam ve výkazu není
            text = db.entries_csv(data, data["entries"])
        lines = text.lstrip("﻿").strip().splitlines()
        self.assertEqual(len(lines), 2)
        self.assertIn("1,50", lines[1])
        self.assertIn('"Úprava; menu"', lines[1])

    def test_error_rolls_back_and_backup(self):
        with self.assertRaises(ValueError):
            with db.open_data(True) as data:
                db.save_client(data, {"name": "A"})
                db.save_client(data, {})
        self.assertEqual(self.stored()["clients"], [])
        with db.open_data(True) as data:
            db.save_client(data, {"name": "A"})
        self.assertTrue((db.ZALOHY / f"hodinovka-{TODAY}.json").exists())

    def test_corrupted_file_gives_clear_error(self):
        db.DATA_FILE.write_text("{nedokončené", encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "poškozený"):
            with db.open_data():
                pass

    def test_settings(self):
        with db.open_data(True) as data:
            s = db.save_settings(data, {"default_rate": "750", "rounding": "15", "grouping": "description"})
            self.assertEqual((s["default_rate"], s["rounding"], s["grouping"]), (750.0, 15, "description"))
            with self.assertRaises(ValueError):
                db.save_settings(data, {"rounding": "7"})


# ---------- MejvOS ----------

class MejvosTests(TempData):
    def manifest(self, app_id, api="http://127.0.0.1:1/api/os", provides=("contacts",), version="1.4.0"):
        launcher = Path(self.tmp.name) / app_id / "spustit.sh"
        launcher.parent.mkdir(exist_ok=True)
        launcher.write_text("#!/bin/bash\nexit 0\n")
        mejvos._write_json(mejvos.HOME / "apps" / f"{app_id}.json", {
            "id": app_id, "name": app_id.capitalize(), "version": version, "api": api, "provides": list(provides),
            "launch": {"command": ["/bin/bash", str(launcher)]}, "scheme": app_id})
        return launcher

    def test_nothing_is_written_unless_enabled(self):
        with db.open_data(True) as data:
            db.save_client(data, {"name": "A"})
        self.assertFalse(mejvos.HOME.exists())
        mejvos.ENABLED = True
        mejvos.announce("hodinovka", name="Hodinovka", version="1.0.0", port=8766, root=db.ROOT, provides=["contacts"])
        with db.open_data(True) as data:
            db.save_client(data, {"name": "B"})
        m = json.loads((mejvos.HOME / "apps/hodinovka.json").read_text(encoding="utf-8"))
        self.assertEqual((m["api"], m["scheme"], m["protocol"]), ("http://localhost:8766/api/os", "hodinovka", 1))
        published = json.loads((mejvos.HOME / "contacts/hodinovka.json").read_text(encoding="utf-8"))
        self.assertEqual([c["name"] for c in published["items"]], ["A", "B"])

    def test_unchanged_lists_are_not_rewritten(self):
        mejvos.ENABLED = True
        mejvos.publish_contacts("hodinovka", [{"uid": "a", "name": "A"}])
        sig = mejvos.signature("contacts")
        mejvos.publish_contacts("hodinovka", [{"uid": "a", "name": "A"}])
        self.assertEqual(mejvos.signature("contacts"), sig)  # ostatní se zbytečně neobnovují
        mejvos.publish_contacts("hodinovka", [{"uid": "a", "name": "B"}])
        self.assertNotEqual(mejvos.signature("contacts"), sig)

    def test_uninstalled_apps_are_ignored(self):
        launcher = self.manifest("faktury")
        self.assertEqual([a["id"] for a in mejvos.apps()], ["faktury"])
        self.assertEqual(mejvos.apps(exclude="faktury"), [])
        launcher.unlink()
        self.assertEqual(mejvos.apps(), [])
        (mejvos.HOME / "apps/rozbity.json").write_text("{", encoding="utf-8")
        self.assertEqual(mejvos.apps(), [])

    def test_peer_contacts_are_offered_once(self):
        self.manifest("faktury")
        mejvos._write_json(mejvos.HOME / "contacts/faktury.json", {"items": [
            {"uid": "f1", "name": "Kavárna s.r.o.", "ico": "11111111"},
            {"uid": "f2", "name": "Nový klient"},
            {"uid": "f3", "name": "Petra Malá"},
            {"uid": "", "name": "Bez uid"},
        ]})
        mejvos._write_json(mejvos.HOME / "contacts/odinstalovana.json", {"items": [{"uid": "x", "name": "X"}]})
        with db.open_data(True) as data:
            db.save_client(data, {"name": "Kavárna", "ico": "11111111"})  # stejné IČO
            db.save_client(data, {"name": "petra malá"})  # stejné jméno
            offered = db.offered_contacts(data)
        self.assertEqual([(c["uid"], c["app_name"]) for c in offered], [("f2", "Faktury")])

    def test_newer_peer_data_fills_linked_client(self):
        self.manifest("faktury")
        hour_ago = (datetime.now().astimezone() - timedelta(hours=1)).isoformat()
        with db.open_data(True) as data:
            c = db.save_client(data, {"name": "Kavárna", "uid": "u1", "note": "moje poznámka"})
            c["updated_at"] = hour_ago
        later = (datetime.now().astimezone() - timedelta(minutes=30)).isoformat()
        mejvos._write_json(mejvos.HOME / "contacts/faktury.json", {"items": [
            {"uid": "u1", "name": "Kavárna s.r.o.", "ico": "12345678", "street": "", "updated_at": later}]})
        db.sync_peers()
        stored = self.stored()["clients"][0]
        self.assertEqual((stored["name"], stored["ico"], stored["note"]), ("Kavárna s.r.o.", "12345678", "moje poznámka"))
        # starší údaje z jiné aplikace nic nepřepíšou a prázdné hodnoty nic nesmažou
        with db.open_data(True) as data:
            db.save_client(data, {**data["clients"][0], "name": "Kavárna U Mlýna"}, c["id"])
        mejvos._write_json(mejvos.HOME / "contacts/faktury.json", {"items": [
            {"uid": "u1", "name": "Stará", "updated_at": later}]})
        db.sync_peers()
        self.assertEqual(self.stored()["clients"][0]["name"], "Kavárna U Mlýna")

    def test_merge_handles_mixed_time_formats(self):
        rows = [{"uid": "a", "name": "A", "created_at": "2026-01-01T10:00:00"}]  # starší data bez pásma
        peers = [{**mejvos.contact({"uid": "a", "name": "B", "ico": "1"}), "updated_at": "2026-02-01T10:00:00+01:00"}]
        self.assertEqual(mejvos.merge_contacts(rows, peers), 1)
        self.assertEqual((rows[0]["name"], rows[0]["ico"]), ("B", "1"))
        self.assertEqual(mejvos.merge_contacts(rows, peers), 0)

    def test_call_reports_errors_and_starts_app(self):
        fake = FakeFaktury()
        self.addCleanup(fake.close)
        self.manifest("faktury", api=fake.api, provides=["contacts", "invoices"])
        app = mejvos.find("invoices")
        self.assertEqual(mejvos.call(app, "GET", "")["id"], "faktury")
        fake.fail_with = "Faktura s číslem 1 už existuje."
        with self.assertRaisesRegex(mejvos.PeerError, "už existuje"):
            mejvos.call(app, "POST", "invoices", {})
        offline = {**app, "api": "http://127.0.0.1:9/api/os"}
        with self.assertRaisesRegex(mejvos.PeerError, "neběží"):
            mejvos.call(offline, "GET", "", launch=False)
        with mock.patch.object(mejvos, "start") as start, self.assertRaisesRegex(mejvos.PeerError, "neodpovídá"):
            mejvos.call(offline, "GET", "", timeout=1)
        start.assert_called_once()

    def test_overview_lists_catalog(self):
        self.manifest("faktury")
        with mock.patch.object(mejvos, "alive", return_value=True):
            apps = mejvos.overview("hodinovka")["apps"]
        self.assertEqual([(a["id"], a["state"]) for a in apps], [("faktury", "running")])
        self.assertIn("Faktury.zip", apps[0]["download"])


class FakeFaktury:
    """Zjednodušené Faktury: přijmou nebo smažou fakturu a zveřejní stav jako ty skutečné."""

    def __init__(self, home=None):
        self.invoices, self.deleted, self.fail_with, self.home = [], [], None, home
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, status, body):
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                self.reply(200, {"id": "faktury", "name": "Faktury"})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if fake.fail_with:
                    return self.reply(400, {"error": fake.fail_with})
                if self.path.endswith("/invoices/delete"):
                    inv = next((i for i in fake.invoices if i["ref"] == body["ref"]), None)
                    if inv and inv["status"] == "paid":
                        return self.reply(400, {"error": f"Faktura {inv['number']} je zaplacená, a tak se sama nesmaže."})
                    if inv and inv["status"] == "issued":
                        fake.delete(inv["ref"])
                    return self.reply(200, {"deleted": bool(inv and inv["status"] == "issued")})
                ref = body["source"]["ref"]
                inv = next((i for i in fake.invoices if i["ref"] == ref), None)
                if not inv:
                    inv = {"id": len(fake.invoices) + 1, "number": f"2026{len(fake.invoices) + 1:04d}", "ref": ref,
                           "app": body["source"]["app"], "status": "issued", "due_date": "2099-01-01",
                           "total": sum(i["quantity"] * i["price"] for i in body["items"]), "body": body}
                    fake.invoices.append(inv)
                fake.publish()
                self.reply(201, inv)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.api = f"http://127.0.0.1:{self.httpd.server_address[1]}/api/os"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def delete(self, ref):
        """Smaže fakturu jako ve Fakturách: zmizí ze seznamu a ohlásí se jako smazaná."""
        self.invoices = [i for i in self.invoices if i["ref"] != ref]
        self.deleted.append({"app": "hodinovka", "ref": ref, "deleted_at": mejvos.now()})
        self.publish()

    def publish(self):
        if self.home:
            mejvos._write_json(self.home / "invoices/faktury.json", {"ready": True, "items": [
                {k: v for k, v in i.items() if k != "body"} for i in self.invoices], "deleted": self.deleted})

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


# ---------- aktualizace ----------

def release_zip(version, files, prefix=None):
    """Archiv verze ve tvaru, v jakém ho dává GitHub (vše ve složce hodinovka-<verze>/)."""
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, (content, mode) in {"VERSION": (version, 0o644), "server.py": ("# nový", 0o644), **files}.items():
            info = zipfile.ZipInfo(f"{prefix or 'hodinovka-' + version}/{name}")
            info.external_attr = (0o100000 | mode) << 16
            z.writestr(info, content)
    return buf.getvalue()


class UpdateTests(TempData):
    def setUp(self):
        super().setUp()
        self.root = Path(self.tmp.name) / "app"
        (self.root / "data").mkdir(parents=True)
        (self.root / "data/hodinovka.json").write_text("moje data", encoding="utf-8")
        (self.root / "VERSION").write_text("1.0.0\n", encoding="utf-8")
        (self.root / "server.py").write_text("# starý", encoding="utf-8")
        (self.root / "macos").mkdir()
        (self.root / "macos/Hodinovka.swift").write_text("okno", encoding="utf-8")
        update._cache.update(at=0.0, release=None)

    def latest(self, version):
        return mock.patch.object(update, "latest_release", return_value={
            "tag": f"v{version}", "version": version, "notes": "", "url": "https://example.com"})

    def test_versions_compare_as_numbers(self):
        self.assertEqual(update.parse_version("v1.2"), (1, 2, 0))
        self.assertGreater(update.parse_version("1.10.0"), update.parse_version("1.9.3"))

    def test_apply_replaces_app_files_but_never_data(self):
        content = release_zip("1.1.0", {
            "spustit.sh": ("#!/bin/bash", 0o755),
            "static/novy.js": ("// nový soubor", 0o644),
            "data/hodinovka.json": ("cizí data", 0o644),
            "python/bin/python3": ("cizí python", 0o755),
        })
        self.assertFalse(update.apply_zip(content, self.root, "1.1.0"))
        self.assertEqual(update.current_version(self.root), "1.1.0")
        self.assertEqual((self.root / "static/novy.js").read_text(encoding="utf-8"), "// nový soubor")
        self.assertEqual((self.root / "data/hodinovka.json").read_text(encoding="utf-8"), "moje data")
        self.assertTrue((self.root / "spustit.sh").stat().st_mode & 0o100)
        self.assertFalse((self.root / "python").exists())

    def test_apply_reports_changed_app_window(self):
        self.assertTrue(update.apply_zip(release_zip("1.1.0", {"macos/Hodinovka.swift": ("nové okno", 0o644)}), self.root, "1.1.0"))

    def test_apply_rejects_bad_archives(self):
        with self.assertRaisesRegex(ValueError, "poškozená"):
            update.apply_zip(release_zip("1.1.0", {"../mimo.txt": ("x", 0o644)}, prefix="hodinovka"), self.root)
        with self.assertRaisesRegex(ValueError, "jinou verzi"):
            update.apply_zip(release_zip("1.1.0", {}), self.root, "1.2.0")
        self.assertEqual((self.root / "server.py").read_text(encoding="utf-8"), "# starý")

    def test_status_and_git_install(self):
        with self.latest("1.1.0"):
            self.assertTrue(update.status(self.root)["available"])
            (self.root / ".git").mkdir()
            with self.assertRaisesRegex(ValueError, "gitu"):
                update.install(self.root)
        with self.latest("1.0.0"):
            self.assertFalse(update.status(self.root)["available"])

    def test_install_backs_up_and_applies(self):
        content = release_zip("1.1.0", {})

        class Response(BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        with self.latest("1.1.0"), mock.patch.object(update.urllib.request, "urlopen", return_value=Response(content)):
            self.assertEqual(update.install(self.root), {"version": "1.1.0", "app_changed": False})
        self.assertEqual(update.current_version(self.root), "1.1.0")
        self.assertEqual(len(list(db.ZALOHY.glob("pred-aktualizaci-*.json"))), 1)


# ---------- server ----------

class ServerTests(TempData):
    def setUp(self):
        super().setUp()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.port = self.httpd.server_address[1]
        server.ALLOWED_HOSTS = {f"localhost:{self.port}", f"127.0.0.1:{self.port}"}
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        super().tearDown()

    def call(self, method, path, body=None, headers=None, ctype="application/json", raw=False):
        data = json.dumps(body).encode() if isinstance(body, dict) else body
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data, method=method,
                                     headers={"Content-Type": ctype, **(headers or {})})
        try:
            with urllib.request.urlopen(req) as r:
                content = r.read()
                return r.status, content.decode("utf-8") if raw else json.loads(content or b"null")
        except urllib.error.HTTPError as e:
            with e:
                return e.code, json.loads(e.read() or b"null")

    def make_entries(self):
        self.call("POST", "/api/clients", {"name": "Kavárna", "ico": "12345678"})
        _, p = self.call("POST", "/api/projects", {"name": "Web", "client_id": 1, "rate": 1000})
        ids = []
        for day in (-2, -1):
            _, e = self.call("POST", "/api/entries", {"project_id": p["id"], "description": "Práce", "start": at(day, 9), "end": at(day, 10, 30)})
            ids.append(e["id"])
        return p, ids

    def test_timer_flow(self):
        _, started = self.call("POST", "/api/timer/start", {"description": "Reference"})
        self.assertIsNone(started["entry"]["end"])
        self.assertEqual(self.call("GET", "/api/timer")[1]["entry"]["id"], started["entry"]["id"])
        status, edited = self.call("PUT", f"/api/entries/{started['entry']['id']}", {"description": "Přidávání reference"})
        self.assertEqual((status, edited["end"]), (200, None))
        _, stopped = self.call("POST", "/api/timer/stop", {})
        self.assertEqual(stopped["stopped"]["description"], "Přidávání reference")
        self.assertIsNone(self.call("POST", "/api/timer/stop", {})[1]["stopped"])
        self.assertIsNone(self.call("GET", "/api/timer")[1]["entry"])

    def test_billing_without_faktury(self):
        _, ids = self.make_entries()
        status, preview = self.call("POST", "/api/billings/preview", {"entry_ids": ids})
        self.assertEqual((status, preview["total"]), (200, 3000.0))
        status, body = self.call("POST", "/api/billings", {"uid": "x1", "entry_ids": ids, **preview})
        self.assertEqual(status, 400)
        self.assertIn("nejsou Faktury", body["error"])
        self.assertTrue(all(e["billing_id"] is None for e in self.stored()["entries"]))  # nic se neoznačilo
        self.assertEqual(self.stored()["billings"], [])

    def mark_only(self, uid, ids):
        """Vyúčtování bez faktury, jaké šlo udělat ve starších verzích („Jen označit“)."""
        with db.open_data(True) as data:
            return db.create_billing(data, db.check_billing(data, {"uid": uid, "entry_ids": ids}))

    def test_bulk_delete_entries(self):
        _, ids = self.make_entries()
        self.assertEqual(self.call("POST", "/api/entries/delete", {"entry_ids": ids}), (200, {"deleted": 2}))
        self.assertEqual(self.stored()["entries"], [])
        self.assertEqual(self.call("POST", "/api/entries/delete", {"entry_ids": [1]})[0], 404)

    def test_billing_creates_invoice_in_faktury(self):
        fake = FakeFaktury(mejvos.HOME)
        self.addCleanup(fake.close)
        MejvosTests.manifest(self, "faktury", api=fake.api, provides=["contacts", "invoices"])
        _, ids = self.make_entries()
        _, preview = self.call("POST", "/api/billings/preview", {"entry_ids": ids})
        body = {"uid": "u-1", "entry_ids": ids, "items": preview["items"],
                "customer": {**preview["customer"], "name": "Holding a.s."}, "note": preview["note"]}
        status, b = self.call("POST", "/api/billings", body)
        self.assertEqual((status, b["invoice"]["number"], b["invoice"]["scheme"]), (201, "20260001", "faktury"))
        sent = fake.invoices[0]["body"]
        self.assertEqual((sent["customer"]["name"], sent["customer"]["uid"]), ("Holding a.s.", preview["customer"]["uid"]))
        self.assertEqual(sent["source"], {"app": "hodinovka", "name": "Hodinovka", "ref": "u-1", "link": "hodinovka://vyuctovani/u-1"})
        self.assertEqual(set(sent["items"][0]), {"description", "quantity", "unit", "price"})
        self.assertEqual(self.call("POST", "/api/billings", body)[1]["id"], b["id"])  # opakování nic nezdvojí
        self.assertEqual(len(fake.invoices), 1)
        _, listed = self.call("GET", "/api/billings")
        self.assertEqual(listed[0]["invoice_state"]["status"], "issued")
        fake.invoices[0]["status"] = "paid"
        fake.publish()
        self.assertEqual(self.call("GET", "/api/billings/u-1")[1]["invoice_state"]["status"], "paid")
        fake.invoices.clear()  # faktura ve Fakturách smazaná
        fake.publish()
        self.assertEqual(self.call("GET", "/api/billings/u-1")[1]["invoice_state"]["status"], "deleted")
        peers = self.call("GET", "/api/peers")[1]
        self.assertEqual((peers["apps"][0]["id"], peers["apps"][0]["ready"]), ("faktury", True))

    def test_invoice_later_for_marked_entries(self):
        _, ids = self.make_entries()
        self.mark_only("m-1", ids)
        status, draft = self.call("GET", "/api/billings/m-1/draft")
        self.assertEqual((status, draft["billing"], draft["entry_ids"], draft["total"]), (200, "m-1", ids, 3000.0))
        self.assertEqual(draft["customer"]["name"], "Kavárna")
        self.assertTrue(draft["note"].startswith("Období: "))
        body = {"customer": draft["customer"], "items": [{**draft["items"][0], "price": 1200}], "note": draft["note"]}
        status, err = self.call("POST", "/api/billings/m-1/invoice", body)
        self.assertEqual(status, 400)
        self.assertIn("nejsou Faktury", err["error"])
        self.assertIsNone(self.stored()["billings"][0]["invoice"])

        fake = FakeFaktury(mejvos.HOME)
        self.addCleanup(fake.close)
        MejvosTests.manifest(self, "faktury", api=fake.api, provides=["contacts", "invoices"])
        status, b = self.call("POST", "/api/billings/m-1/invoice", body)
        self.assertEqual((status, b["invoice"]["number"], b["total"], b["invoice_state"]["status"]), (200, "20260001", 3600.0, "issued"))
        self.assertEqual(fake.invoices[0]["body"]["source"]["ref"], "m-1")
        self.assertEqual(self.call("POST", "/api/billings/m-1/invoice", body)[1]["invoice"]["id"], 1)  # druhé kliknutí
        self.assertEqual(len(fake.invoices), 1)
        self.assertTrue(all(e["billing_id"] == b["id"] for e in self.stored()["entries"]))

        fake.invoices.clear()  # ve Fakturách chybí (smazaná dřív, než to Faktury hlásily) – jde vystavit znovu
        fake.publish()
        status, again = self.call("POST", "/api/billings/m-1/invoice", {})
        self.assertEqual((status, again["invoice_state"]["status"], fake.invoices[0]["total"]), (200, "issued", 3600.0))
        self.assertEqual(self.call("DELETE", "/api/billings/m-1")[1], {"returned": 2})
        self.assertEqual(fake.invoices, [])  # vrácením mezi nevyfakturované zmizela i faktura

    def billed(self, uid, ids):
        status, b = self.call("POST", "/api/billings", {"uid": uid, "entry_ids": ids})
        self.assertEqual((status, b["invoice"]["app"]), (201, "faktury"))

    def test_unbilling_deletes_invoice_in_faktury(self):
        fake = FakeFaktury(mejvos.HOME)
        self.addCleanup(fake.close)
        MejvosTests.manifest(self, "faktury", api=fake.api, provides=["contacts", "invoices"])
        _, ids = self.make_entries()
        self.billed("u-1", ids)
        fake.invoices[0]["status"] = "paid"
        fake.publish()
        status, err = self.call("DELETE", "/api/billings/u-1")
        self.assertEqual(status, 400)
        self.assertIn("zaplacená", err["error"])  # zaplacenou fakturu Hodinovka nesmaže
        self.assertEqual(len(self.stored()["billings"]), 1)
        fake.invoices[0]["status"] = "cancelled"
        fake.publish()
        self.assertEqual(self.call("DELETE", "/api/billings/u-1"), (200, {"returned": 2}))
        self.assertEqual(len(fake.invoices), 1)  # stornovaná zůstane v číselné řadě
        self.billed("u-2", ids)
        self.assertEqual(self.call("DELETE", "/api/billings/u-2"), (200, {"returned": 2}))
        self.assertEqual([i["ref"] for i in fake.invoices], ["u-1"])
        self.assertTrue(all(e["billing_id"] is None for e in self.stored()["entries"]))

    def test_unbilling_needs_new_faktury(self):
        fake = FakeFaktury(mejvos.HOME)
        self.addCleanup(fake.close)
        MejvosTests.manifest(self, "faktury", api=fake.api, provides=["contacts", "invoices"], version="1.3.0")
        self.billed("u-1", self.make_entries()[1])
        status, err = self.call("DELETE", "/api/billings/u-1")
        self.assertEqual(status, 400)
        self.assertIn("aktualizovat", err["error"])
        self.assertEqual(len(fake.invoices), 1)

    def test_invoice_deleted_in_faktury_returns_entries(self):
        fake = FakeFaktury(mejvos.HOME)
        self.addCleanup(fake.close)
        MejvosTests.manifest(self, "faktury", api=fake.api, provides=["contacts", "invoices"])
        _, ids = self.make_entries()
        self.billed("u-1", ids[:1])
        self.billed("u-2", ids[1:])
        fake.invoices.clear()  # jen chybí (třeba přeinstalované Faktury): nic se neruší
        fake.publish()
        self.assertEqual(len(self.call("GET", "/api/billings")[1]), 2)
        fake.delete("u-1")  # smazaná ve Fakturách
        _, billings = self.call("GET", "/api/billings")
        self.assertEqual([b["uid"] for b in billings], ["u-2"])
        entries = self.stored()["entries"]
        self.assertEqual([e["billing_id"] is None for e in entries], [True, False])

    def test_revision_follows_changes(self):
        _, first = self.call("GET", "/api/rev")
        self.assertEqual(self.call("GET", "/api/rev")[1], first)
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/api/clients", data=json.dumps({"name": "A"}).encode(),
                                     method="POST", headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req) as r:
            own = r.headers["X-Rev"]  # okno pozná svoji změnu
        _, now = self.call("GET", "/api/rev")
        self.assertNotEqual(now, first)
        self.assertEqual(own, now["rev"])
        mejvos._write_json(mejvos.HOME / "invoices/faktury.json", {"items": []})  # Faktury zveřejnily stav
        self.assertNotEqual(self.call("GET", "/api/rev")[1], now)

    def test_failed_invoice_marks_nothing(self):
        fake = FakeFaktury(mejvos.HOME)
        fake.fail_with = "Chybí položky."
        self.addCleanup(fake.close)
        MejvosTests.manifest(self, "faktury", api=fake.api, provides=["invoices"])
        _, ids = self.make_entries()
        status, body = self.call("POST", "/api/billings", {"uid": "u-2", "entry_ids": ids})
        self.assertEqual(status, 400)
        self.assertIn("Chybí položky", body["error"])
        self.assertEqual(self.stored()["billings"], [])

    def test_csv_export(self):
        _, ids = self.make_entries()
        status, text = self.call("GET", "/api/export/csv?stav=nevyfakturovane", raw=True)
        self.assertEqual(status, 200)
        self.assertEqual(len(text.strip().splitlines()), 3)
        self.assertEqual(self.call("GET", "/api/export/csv?stav=vyfakturovane", raw=True)[1].count("\n"), 1)

    def test_rejects_foreign_sites(self):
        status, _ = self.call("POST", "/api/clients", {"name": "X"}, headers={"Origin": "https://evil.example"})
        self.assertEqual(status, 403)
        status, _ = self.call("POST", "/api/clients", b'{"name": "X"}', ctype="text/plain")
        self.assertEqual(status, 400)
        self.assertEqual(self.stored()["clients"], [])

    def test_os_info_and_contacts(self):
        self.call("POST", "/api/clients", {"name": "Kavárna"})
        self.assertEqual(self.call("GET", "/api/os")[1]["provides"], ["contacts", "time"])
        self.assertEqual([c["name"] for c in self.call("GET", "/api/os/contacts")[1]], ["Kavárna"])

    def test_version_and_update_status(self):
        self.assertEqual(self.call("GET", "/api/version")[1], {"version": update.current_version()})
        with mock.patch.object(update, "latest_release", return_value=None):
            status, body = self.call("GET", "/api/update")
        self.assertEqual((status, body["available"]), (200, False))
        status, _ = self.call("POST", "/api/update", {}, headers={"Origin": "https://evil.example"})
        self.assertEqual(status, 403)

    def test_static_files_cannot_escape(self):
        self.assertEqual(self.call("GET", "/../db.py")[0], 404)
        self.assertEqual(self.call("GET", "/api/entries/999")[0], 404)


if __name__ == "__main__":
    unittest.main()
