// Hodinovka.app – vlastní okno aplikace. Spustí lokální server (spustit.sh) a zobrazí ho ve WebKitu.
// Běžící časovač ukazuje i v horní liště Macu, kde ho jde zastavit nebo spustit.
// Sestavuje ho macos/sestavit.sh ve dvou podobách:
// - vývojová (instalovat.sh): spouští Hodinovku ze složky projektu, cestu má v Info.plist (HodinovkaFolder),
// - ke stažení z GitHubu: kód nese v Resources/app a při spuštění ho nakopíruje do Application Support,
//   kde žijí i data a vlastní Python. Aktualizace pak mění jen tu složku, samotná aplikace zůstává.
// Odkazy hodinovka://cesta (třeba z Faktur) otevřou okno na stránce #/cesta.
import AppKit
import QuartzCore
import WebKit

/// Složka s kódem a daty Hodinovky.
func hodinovkaFolder() -> URL {
    if let path = Bundle.main.object(forInfoDictionaryKey: "HodinovkaFolder") as? String {
        return URL(fileURLWithPath: path)
    }
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return support.appendingPathComponent("Hodinovka")
}

/// Verze ze souboru VERSION, třeba [1, 2, 0]. Prázdná, když soubor chybí.
func hodinovkaVersion(_ folder: URL) -> [Int] {
    let text = (try? String(contentsOf: folder.appendingPathComponent("VERSION"), encoding: .utf8)) ?? ""
    return text.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: ".").map { Int($0) ?? 0 }
}

/// Spustí program a vrátí jeho návratový kód a chybový výstup.
func runTool(_ path: String, _ arguments: [String], environment: [String: String]? = nil) -> (status: Int32, error: String) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: path)
    process.arguments = arguments
    if let environment = environment {
        process.environment = environment
    }
    let pipe = Pipe()
    process.standardError = pipe
    do {
        try process.run()
    } catch {
        return (-1, error.localizedDescription)
    }
    let output = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return (process.terminationStatus, String(decoding: output, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines))
}

/// Připraví složku Hodinovky a spustí server přes spustit.sh, pokud ještě neběží. Vrátí popis chyby, nebo nil.
/// Běží mimo hlavní vlákno: při prvním spuštění se stahuje Python a přístup ke složkám může čekat na macOS.
func startServer(folder: URL) -> String? {
    var environment = ProcessInfo.processInfo.environment
    let launcher = folder.appendingPathComponent("spustit.sh")
    if Bundle.main.object(forInfoDictionaryKey: "HodinovkaFolder") != nil {
        guard FileManager.default.isReadableFile(atPath: launcher.path) else {
            return "Složka aplikace není na svém místě:\n\(folder.path)\n\n"
                + "Pokud se přesunula, spusť v ní znovu instalovat.sh. "
                + "Pokud má Hodinovka zakázaný přístup ke složce, povol ho v Nastavení systému → "
                + "Soukromí a zabezpečení → Soubory a složky."
        }
    } else {
        // Aplikace z GitHubu přinesla novější kód, než je ve složce (nebo složka ještě není): nakopíruje ho tam.
        let bundled = Bundle.main.resourceURL!.appendingPathComponent("app")
        if hodinovkaVersion(folder).lexicographicallyPrecedes(hodinovkaVersion(bundled)) {
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let copy = runTool("/usr/bin/ditto", ["--noqtn", bundled.path, folder.path])
            if copy.status != 0 {
                return "Nepodařilo se připravit složku \(folder.path). \(copy.error)"
            }
        }
        environment["HODINOVKA_APP"] = Bundle.main.bundlePath
    }
    let result = runTool("/bin/bash", [launcher.path], environment: environment)
    if result.status != 0 {
        let detail = result.error.isEmpty ? "Podrobnosti jsou v souboru data/server.log ve složce Hodinovky." : result.error
        return "Server se nepodařilo spustit. \(detail)"
    }
    return nil
}

/// Stopky do horní lišty s ručičkou na dané sekundě. Je to šablona, takže ji macOS obarví podle lišty.
func stopwatchImage(second: Int) -> NSImage {
    let image = NSImage(size: NSSize(width: 16, height: 16), flipped: false) { _ in
        NSColor.black.set()
        let center = NSPoint(x: 8, y: 7.25)
        let radius: CGFloat = 6
        let dial = NSBezierPath(ovalIn: NSRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
        dial.lineWidth = 1.5
        dial.stroke()
        NSBezierPath(rect: NSRect(x: 7.4, y: 13, width: 1.2, height: 1.5)).fill()  // korunka
        NSBezierPath(roundedRect: NSRect(x: 6.3, y: 14.2, width: 3.4, height: 1.5), xRadius: 0.7, yRadius: 0.7).fill()
        let angle = CGFloat.pi / 2 - CGFloat(second) / 60 * 2 * CGFloat.pi
        let hand = NSBezierPath()
        hand.move(to: center)
        hand.line(to: NSPoint(x: center.x + cos(angle) * (radius - 1.8), y: center.y + sin(angle) * (radius - 1.8)))
        hand.lineWidth = 1.4
        hand.lineCapStyle = .round
        hand.stroke()
        NSBezierPath(ovalIn: NSRect(x: center.x - 1.1, y: center.y - 1.1, width: 2.2, height: 2.2)).fill()
        return true
    }
    image.isTemplate = true
    image.accessibilityDescription = "Hodinovka – časovač běží"
    return image
}

/// Co je v okně vidět, než naběhne server. Text se ukáže, až když spuštění trvá déle.
let startPage = """
    <!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark">
    <style>
    body { margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center;
           font: 15px/1.5 -apple-system, sans-serif; background: #f5f5f7; color: #6e6e73; text-align: center; }
    @media (prefers-color-scheme: dark) { body { background: #000; color: #98989d; } }
    p { opacity: 0; animation: show 0.3s 1s forwards; }
    b { color: CanvasText; font-weight: 600; }
    @keyframes show { to { opacity: 1; } }
    </style>
    <p><b>Spouštím Hodinovku…</b><br>Při prvním spuštění se stahují potřebné součásti, může to minutu trvat.</p>
    """

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuDelegate,
    WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler {
    let url = URL(string: "http://localhost:8766/")!
    let folder = hodinovkaFolder()
    let zoomSteps: [CGFloat] = [0.5, 0.67, 0.75, 0.85, 1, 1.1, 1.25, 1.5, 1.75, 2]
    var window: NSWindow!
    var webView: WKWebView!
    var titleObservation: NSKeyValueObservation?
    var canClose = false  // neuložené změny už jsou potvrzené (nebo žádné nebyly)
    var ready = false  // server běží a okno ukazuje appku
    var pendingRoute: String?  // stránka z odkazu hodinovka://, která počká, až server naběhne

    // časovač v horní liště
    var statusItem: NSStatusItem!
    var timerStart: Date?
    var timerTitle = ""
    var ticker: Timer?

    // ---------- spuštění ----------

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSWindow.allowsAutomaticWindowTabbing = false

        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "hodinovka")
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        let zoom = UserDefaults.standard.double(forKey: "zoom")
        webView.pageZoom = zoom > 0 ? CGFloat(zoom) : 1
        titleObservation = webView.observe(\.title) { [weak self] webView, _ in
            let title = (webView.title ?? "").replacingOccurrences(of: " – Hodinovka", with: "")
            self?.window.title = title.isEmpty ? "Hodinovka" : title
        }

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 760),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false  // zavřené okno se jen schová, časovač v liště běží dál
        window.delegate = self
        window.title = "Hodinovka"
        // Barva pozadí stránky z app.css (--bg), než se stránka načte.
        window.backgroundColor = NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
                ? .black : NSColor(srgbRed: 245 / 255, green: 245 / 255, blue: 247 / 255, alpha: 1)
        }
        window.minSize = NSSize(width: 480, height: 400)
        window.contentView = webView
        window.center()
        _ = window.setFrameAutosaveName("Hodinovka")

        NSApp.mainMenu = makeMainMenu()
        setupStatusItem()
        webView.loadHTMLString(startPage, baseURL: nil)
        window.makeKeyAndOrderFront(nil)
        connect()
    }

    /// Spustí server (pokud neběží) a načte do okna appku.
    func connect() {
        let folder = self.folder
        DispatchQueue.global(qos: .userInitiated).async {
            let error = startServer(folder: folder)
            DispatchQueue.main.async {
                if let error = error {
                    self.fail(error)
                } else {
                    self.ready = true
                    let route = self.pendingRoute ?? ""
                    self.pendingRoute = nil
                    self.webView.load(URLRequest(url: URL(string: self.url.absoluteString + "#/" + route)!))
                }
            }
        }
    }

    /// Ukáže chybu a nabídne nový pokus, nebo ukončení.
    func fail(_ message: String) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Hodinovka nejde spustit"
        alert.informativeText = message
        alert.addButton(withTitle: "Zkusit znovu")
        alert.addButton(withTitle: "Ukončit")
        if alert.runModal() == .alertFirstButtonReturn {
            connect()
        } else {
            canClose = true
            NSApp.terminate(nil)
        }
    }

    // ---------- odkazy hodinovka:// ----------

    func application(_ application: NSApplication, open urls: [URL]) {
        guard let target = urls.first else { return }
        // hodinovka://vyuctovani/abc → #/vyuctovani/abc (jen bezpečné znaky)
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/-_")
        let raw = (target.host ?? "") + target.path
        let route = String(String.UnicodeScalarView(raw.unicodeScalars.filter { allowed.contains($0) }))
        showWindow(nil)
        if ready {
            webView.load(URLRequest(url: URL(string: url.absoluteString + "#/" + route)!))
        } else {
            pendingRoute = route
        }
    }

    // ---------- zavření ----------

    /// Zavřením okna se Hodinovka neukončí – časovač v horní liště běží dál. Okno vrátí klik na ikonu v Docku.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            showWindow(nil)
        }
        return true
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
        true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if canClose { return .terminateNow }
        confirmLeave { leave in
            self.canClose = leave
            sender.reply(toApplicationShouldTerminate: leave)
        }
        return .terminateLater
    }

    /// Jako prohlížeč: při neuložených změnách ve formuláři (leaveGuard v app.js) se zeptá.
    func confirmLeave(_ done: @escaping (Bool) -> Void) {
        webView.evaluateJavaScript("typeof leaveGuard === 'function' && !!leaveGuard()") { result, _ in
            guard (result as? Bool) == true else { return done(true) }
            self.showWindow(nil)
            let alert = NSAlert()
            alert.messageText = "Máš neuložené změny. Opravdu odejít?"
            alert.addButton(withTitle: "Odejít")
            alert.addButton(withTitle: "Zrušit")
            alert.beginSheetModal(for: self.window) { done($0 == .alertFirstButtonReturn) }
        }
    }

    @objc func showWindow(_ sender: Any?) {
        window?.makeKeyAndOrderFront(nil)  // odkaz hodinovka:// může přijít ještě před vytvořením okna
        NSApp.activate(ignoringOtherApps: true)
    }

    // ---------- časovač v horní liště ----------

    func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.imagePosition = .imageLeading
            button.font = NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
            button.toolTip = "Hodinovka"
            button.wantsLayer = true  // kvůli jemnému prolnutí při každé sekundě (viz updateStatusItem)
        }
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
        updateStatusItem()
    }

    /// Tiká jen při běžícím časovači, a to těsně po každé celé sekundě od jeho spuštění, ať čas v liště
    /// poskakuje pravidelně a nepřeskočí sekundu.
    func restartTicker() {
        ticker?.invalidate()
        ticker = nil
        guard let start = timerStart else { return }
        let elapsed = Date().timeIntervalSince(start)
        let first = start.addingTimeInterval(max(0, elapsed).rounded(.down) + 1.02)
        let timer = Timer(fire: first, interval: 1, repeats: true) { [weak self] _ in self?.updateStatusItem(animated: true) }
        timer.tolerance = 0.05
        RunLoop.main.add(timer, forMode: .common)
        ticker = timer
    }

    /// V liště: stopky, a když časovač běží, i odpracovaný čas se sekundami. Ručička stopek ukazuje
    /// sekundy a každá změna se krátce prolne, takže čas plynule ubíhá.
    func updateStatusItem(animated: Bool = false) {
        guard let button = statusItem?.button else { return }
        if animated, let layer = button.layer {
            let fade = CATransition()
            fade.type = .fade
            fade.duration = 0.25
            fade.timingFunction = CAMediaTimingFunction(name: .easeOut)
            layer.add(fade, forKey: "tick")
        }
        if let start = timerStart {
            let seconds = max(0, Int(Date().timeIntervalSince(start)))
            button.image = stopwatchImage(second: seconds % 60)
            button.title = String(format: " %d:%02d:%02d", seconds / 3600, (seconds % 3600) / 60, seconds % 60)
        } else {
            let image = NSImage(systemSymbolName: "stopwatch", accessibilityDescription: "Hodinovka")
            image?.isTemplate = true
            button.image = image
            button.title = image == nil ? "Hodinovka" : ""
        }
    }

    /// Menu v liště se sestaví vždy při otevření, ať odpovídá stavu časovače.
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        if timerStart != nil {
            if !timerTitle.isEmpty {
                let info = NSMenuItem(title: timerTitle, action: nil, keyEquivalent: "")
                info.isEnabled = false
                menu.addItem(info)
            }
            menu.addItem(withTitle: "Zastavit časovač", action: #selector(toggleTimer(_:)), keyEquivalent: "").target = self
        } else {
            menu.addItem(withTitle: "Spustit časovač", action: #selector(toggleTimer(_:)), keyEquivalent: "").target = self
        }
        menu.addItem(.separator())
        menu.addItem(withTitle: "Otevřít Hodinovku", action: #selector(showWindow(_:)), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Ukončit Hodinovku", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
    }

    @objc func toggleTimer(_ sender: Any?) {
        webView.evaluateJavaScript("window.hodinovka && hodinovka.toggle(); true", completionHandler: nil)
    }

    /// Zprávy ze stránky (app.js, tellNative): běží časovač, od kdy a na čem.
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        let wasStart = timerStart
        if (body["running"] as? Bool) == true, let start = body["start"] as? Double {
            timerStart = Date(timeIntervalSince1970: start / 1000)
            let parts = [body["title"] as? String ?? "", body["project"] as? String ?? ""]
            timerTitle = parts.filter { !$0.isEmpty }.joined(separator: " · ")
        } else {
            timerStart = nil
            timerTitle = ""
        }
        if timerStart != wasStart {
            restartTicker()
        }
        updateStatusItem(animated: (timerStart == nil) != (wasStart == nil))
    }

    // ---------- navigace ----------

    /// Adresy appky. Ostatní odkazy (i faktury://) se otevřou v prohlížeči nebo v dané aplikaci.
    func isOwn(_ target: URL) -> Bool {
        switch target.scheme ?? "" {
        case "http", "https":
            return target.host == url.host && target.port == url.port
        case "about", "blob", "data":
            return true
        default:
            return false
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let target = navigationAction.request.url, !isOwn(target) {
            NSWorkspace.shared.open(target)
            decisionHandler(.cancel)
        } else {
            decisionHandler(navigationAction.shouldPerformDownload ? .download : .allow)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let http = navigationResponse.response as? HTTPURLResponse
        let disposition = http?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        let download = !navigationResponse.canShowMIMEType || disposition.hasPrefix("attachment")
        decisionHandler(download ? .download : .allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        window.makeFirstResponder(webView)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        let error = error as NSError
        // Zrušené načtení (třeba když se z odkazu stane stahování) není chyba.
        guard error.domain == NSURLErrorDomain, error.code != NSURLErrorCancelled else { return }
        fail("Server Hodinovky neodpovídá (\(error.localizedDescription)).")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    // ---------- dialogy z JavaScriptu ----------

    /// Text „Otázka?\n\nPodrobnosti“ rozdělí na nadpis dialogu a popis pod ním.
    func makeAlert(_ message: String) -> NSAlert {
        let parts = message.components(separatedBy: "\n\n")
        let alert = NSAlert()
        alert.messageText = parts[0]
        alert.informativeText = parts.dropFirst().joined(separator: "\n\n")
        return alert
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        showWindow(nil)
        makeAlert(message).beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        showWindow(nil)
        let alert = makeAlert(message)
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Zrušit")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
    }

    /// Odkazy s target="_blank" otevře v prohlížeči.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let target = navigationAction.request.url {
            NSWorkspace.shared.open(target)
        }
        return nil
    }

    // ---------- stahování (výkaz práce, záloha dat) ----------

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.beginSheetModal(for: window) { result in
            guard result == .OK, let target = panel.url else { return completionHandler(nil) }
            try? FileManager.default.removeItem(at: target)  // přepsání už potvrdil dialog
            completionHandler(target)
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        NSAlert(error: error).beginSheetModal(for: window, completionHandler: nil)
    }

    // ---------- menu ----------

    /// O aplikaci: verze kódu ze složky Hodinovky (aktualizace mění jen ji, ne aplikaci).
    @objc func showAbout(_ sender: Any?) {
        let version = hodinovkaVersion(folder).map(String.init).joined(separator: ".")
        NSApp.orderFrontStandardAboutPanel(options: [.applicationVersion: version, .version: ""])
    }

    @objc func actualSize(_ sender: Any?) { setZoom(1) }
    @objc func zoomIn(_ sender: Any?) { setZoom(zoomSteps.first { $0 > webView.pageZoom + 0.01 } ?? webView.pageZoom) }
    @objc func zoomOut(_ sender: Any?) { setZoom(zoomSteps.last { $0 < webView.pageZoom - 0.01 } ?? webView.pageZoom) }

    func setZoom(_ zoom: CGFloat) {
        webView.pageZoom = zoom
        UserDefaults.standard.set(Double(zoom), forKey: "zoom")
    }

    func makeMainMenu() -> NSMenu {
        let main = NSMenu()
        func item(_ title: String, _ action: Selector, _ key: String,
                  _ modifiers: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) -> NSMenuItem {
            let menuItem = NSMenuItem(title: title, action: action, keyEquivalent: key)
            menuItem.keyEquivalentModifierMask = modifiers
            menuItem.target = target
            return menuItem
        }
        func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
            let menu = NSMenu(title: title)
            menu.items = items
            let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            holder.submenu = menu
            main.addItem(holder)
            return menu
        }

        _ = submenu("Hodinovka", [
            item("O aplikaci Hodinovka", #selector(showAbout(_:)), "", target: self),
            .separator(),
            item("Spustit nebo zastavit časovač", #selector(toggleTimer(_:)), "t", [.command, .shift], target: self),
            .separator(),
            item("Skrýt aplikaci Hodinovka", #selector(NSApplication.hide(_:)), "h"),
            item("Skrýt ostatní", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Zobrazit vše", #selector(NSApplication.unhideAllApplications(_:)), ""),
            .separator(),
            item("Ukončit aplikaci Hodinovka", #selector(NSApplication.terminate(_:)), "q"),
        ])
        _ = submenu("Úpravy", [
            item("Odvolat", Selector(("undo:")), "z"),
            item("Znovu", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Vyjmout", #selector(NSText.cut(_:)), "x"),
            item("Kopírovat", #selector(NSText.copy(_:)), "c"),
            item("Vložit", #selector(NSText.paste(_:)), "v"),
            item("Vybrat vše", #selector(NSText.selectAll(_:)), "a"),
        ])
        _ = submenu("Zobrazení", [
            item("Zpět", #selector(WKWebView.goBack(_:)), "[", target: webView),
            item("Vpřed", #selector(WKWebView.goForward(_:)), "]", target: webView),
            item("Načíst znovu", #selector(WKWebView.reload(_:)), "r", target: webView),
            .separator(),
            item("Skutečná velikost", #selector(actualSize(_:)), "0", target: self),
            item("Zvětšit", #selector(zoomIn(_:)), "+", target: self),
            item("Zmenšit", #selector(zoomOut(_:)), "-", target: self),
        ])
        NSApp.windowsMenu = submenu("Okno", [
            item("Minimalizovat", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Zavřít", #selector(NSWindow.performClose(_:)), "w"),
        ])
        return main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
