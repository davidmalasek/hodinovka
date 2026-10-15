# Hodinovka pro vývojáře

Jak Hodinovka funguje uvnitř a jak na ní pracovat. Pro běžné používání stačí [README](../README.md).

## Vývojová instalace

Vývojová instalace běží přímo ze složky projektu a data má v její podsložce `data`.
Potřebuje Python 3.9+ a vývojářské nástroje od Applu (`xcode-select --install`), ze kterých se sestaví okno aplikace:

```sh
git clone https://github.com/davidmalasek/hodinovka && cd hodinovka
./instalovat.sh                           # sestaví Hodinovka.app do Aplikací (spouští Hodinovku z této složky)
python3 server.py --open                  # ruční spuštění v prohlížeči
python3 -m unittest discover tests        # testy
```

Bez závislostí: backend na standardní knihovně Pythonu a frontend v čistém JavaScriptu.
Testovací data: `HODINOVKA_DATA=/jina/slozka HODINOVKA_PORT=8799 python3 server.py`. Do iCloudu se zálohují, jen když nastavíš `HODINOVKA_ICLOUD`, a do sdílené složky propojených aplikací se přihlásí, jen když nastavíš `MEJVOS_DIR`.

Vzhled, technika i texty jsou stejné jako u Faktur a popisuje je [styl.md](styl.md).
Propojení s Fakturami a dalšími aplikacemi (vnitřně MejvOS) popisuje [mejvos.md](mejvos.md) a obstarává ho `mejvos.py`. Ten soubor je stejný ve všech aplikacích, takže když ho měníš, změň ho i ve Fakturách.

## Okno aplikace

Okno je v `macos/Hodinovka.swift` (AppKit a WebKit) a sestavuje ho `macos/sestavit.sh`, stejně jako u Faktur ve dvou podobách.
Vývojová podoba (`instalovat.sh`) spouští Hodinovku ze složky projektu. Podoba ke stažení (`Hodinovka.zip` z GitHub Actions) nese kód v sobě a při spuštění ho nakopíruje do `~/Library/Application Support/Hodinovka`.
Použije Python 3.9+, který na Macu už je. Když žádný není, stáhne si vlastní (asi 25 MB, verze a kontrolní součty jsou v `spustit.sh`).

Zavřením okna se Hodinovka neukončí, časovač dál ukazuje horní lišta Macu. Server běží na pozadí i po ukončení, takže se nic neztratí a další otevření je hned. Dokud běží, appka funguje i v prohlížeči na adrese http://localhost:8766.
Poslouchá jen na `127.0.0.1`, takže se k ní nedostane nikdo jiný ze sítě. Ven jde jen dotaz do registru ARES a na GitHub kvůli aktualizacím a instalaci Faktur.

## Data

Data jsou ve složce `~/Library/Application Support/Hodinovka/data` (ve vývojové instalaci ve složce `data` projektu). Přesnou cestu ukazuje Nastavení.

| Cesta | Co obsahuje |
|---|---|
| `data/hodinovka.json` | záznamy času, projekty, klienti, vyúčtování, nastavení (čitelný text) |
| `data/zalohy/` | automatická záloha před první změnou každého dne (30 dní) a před každou aktualizací |
| iCloud Drive → `Hodinovka záloha` | kopie všeho výše, aktualizuje se po každé změně |
| `~/Library/Application Support/MejvOS` | co si Hodinovka a Faktury navzájem ukazují (klienti, stav faktur) |

Složka `data` se do gitu záměrně neukládá, protože obsahuje osobní údaje klientů.

**Obnovení ze zálohy:** ukonči Hodinovku, vypni server (v Terminálu `kill $(cat ~/Library/Application\ Support/Hodinovka/data/server.pid)`) a na místo `data/hodinovka.json` zkopíruj vybraný soubor ze `data/zalohy` nebo z iCloud Drive.

## Aktualizace a vydání

Hodinovka se při každém otevření podívá na GitHub, jestli nevyšla nová verze, a sama ji nainstaluje. Běžící časovač to nepřeruší. Před aktualizací se data zazálohují a data aktualizace nikdy nepřepíše.
Výjimečně se změní i okno aplikace. Pak se stáhne nová Hodinovka.app a appku je potřeba ukončit a otevřít znovu.

**Vydání nové verze:** zvyš číslo v souboru `VERSION` a pushni do `main`.
Když projdou testy a zkouška aplikace na macOS, GitHub Actions vytvoří vydání s `Hodinovka.zip` a ostatním se nová verze nainstaluje při dalším otevření.
Ve vývojové kopii z gitu se aktualizace neinstalují, aby nepřepsaly rozdělanou práci.
