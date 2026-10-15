<p align="center">
  <img src="static/icon.svg" width="112" alt="Ikona aplikace Hodinovka">
</p>

<h1 align="center">Hodinovka</h1>

<p align="center">
  Měření odpracovaného času pro Mac.<br>
  Zapneš, pracuješ, vypneš. A na konci měsíce víš, kolik komu vyfakturovat.
</p>

<p align="center">
  <a href="https://github.com/davidmalasek/hodinovka/releases/latest/download/Hodinovka.zip"><b>Stáhnout pro Mac</b></a>
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/cas-dark.png">
  <img src="docs/cas-light.png" alt="Běžící časovač a odpracovaný čas po dnech">
</picture>

## Co za tebe vyřeší

- **Nemusíš si nic pamatovat.** Napíšeš, na čem pracuješ, a spustíš časovač. Běží, i když zavřeš okno nebo uspíš Mac, a vidíš ho v horní liště, odkud ho i zastavíš.
- **Víš, kolik ti práce vynáší.** U projektu nastavíš hodinovou sazbu nebo pevnou cenu. U pevné ceny pak vidíš, kolik ti vychází na hodinu.
- **Nic nezapomeneš vyfakturovat.** Hodinovka ukazuje, co ještě čeká na fakturu, a jedním kliknutím z toho uděláš fakturu ve [Fakturách](https://github.com/davidmalasek/faktury) i s hodinami a cenami.
- **Klient chce vidět, co se dělalo?** Stáhneš mu výkaz práce, který si otevře v Excelu.

Když zapomeneš časovač zapnout, záznam dopíšeš ručně.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/prehled-dark.png">
  <img src="docs/prehled-light.png" alt="Přehled za měsíc: hodiny po dnech, projekty, klienti a vyúčtování">
</picture>

## Instalace

Potřebuješ Mac s macOS 12 nebo novějším.

1. Stáhni **[Hodinovka.zip](https://github.com/davidmalasek/hodinovka/releases/latest/download/Hodinovka.zip)**. Safari ho samo rozbalí, jinak na něj dvakrát klikni.
2. Přetáhni **Hodinovku** do složky **Aplikace** a otevři ji.
3. Napoprvé macOS napíše, že aplikaci nemůže ověřit, protože není placeně podepsaná u Applu. Klikni na **Hotovo**, otevři **Nastavení systému → Soukromí a zabezpečení**, sjeď dolů a u Hodinovky klikni na **Přesto otevřít**. Tohle je potřeba jen jednou.

Při prvním otevření se Hodinovka chvíli připravuje. Když se macOS zeptá na přístup k iCloud Drive, klikni na **Povolit**, ať se ti tam data zálohují.
Faktury ti Hodinovka nabídne nainstalovat, až budeš poprvé fakturovat.

Časovač spustíš a zastavíš i zkratkou ⇧⌘T. Zavřením okna Hodinovka běží dál, ukončíš ji ⌘Q. Nové verze se instalují samy.

## Tvoje data

Záznamy, projekty i klienty máš jen u sebe na Macu. Každý den se zálohují a po každé změně se kopie uloží do tvého iCloud Drive (složka **Hodinovka záloha**).
Hodinovka nemá žádný účet a nic nikam neposílá. Na internet se ptá jen registru firem ARES, když hledáš klienta podle IČO, a jestli nevyšla nová verze.

## Pro vývojáře

Jak Hodinovka funguje uvnitř a jak na ní pracovat, popisuje [docs/vyvoj.md](docs/vyvoj.md).

Licence [MIT](LICENSE).
