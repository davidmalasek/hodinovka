# Hodinovka

Měření odpracovaného času pro Mac. Patří do systému aplikací MejvOS spolu s Fakturami (github.com/davidmalasek/faktury).

- Vzhled a technika podle `docs/styl.md` – musí vypadat a fungovat stejně jako Faktury. Platí i pro každou další aplikaci systému.
- Propojení aplikací podle `docs/mejvos.md`. Soubory `mejvos.py`, `docs/mejvos.md` a `docs/styl.md` jsou stejné ve všech aplikacích: když je měníš, změň je všude.
- Bez závislostí: Python 3.9+ jen se standardní knihovnou, čistý JavaScript bez buildu. Testy `python3 -m unittest discover tests` musí projít i na Pythonu 3.9.
- Texty v aplikaci i komentáře v kódu česky, uživateli se tyká.
- Okno pro macOS (`macos/Hodinovka.swift`) jde zkompilovat jen na Macu, ověřuje ho GitHub Actions.
- Vydání: zvýšit `VERSION` a pushnout do `main`.
