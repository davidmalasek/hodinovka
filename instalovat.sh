#!/bin/bash
# Vývojová instalace: sestaví Hodinovka.app do složky Aplikace (nebo do složky z 1. argumentu).
# Aplikace spouští Hodinovku z této složky a data má v data/. Když složku přesuneš, spusť instalaci znovu.
# (Běžní uživatelé si stáhnou hotový Hodinovka.zip z GitHubu, viz README.)
set -euo pipefail
cd "$(dirname "$0")"
APP="${1:-/Applications}/Hodinovka.app"

if ! xcrun --find swiftc >/dev/null 2>&1; then
  xcode-select --install 2>/dev/null || true
  echo "Chybí vývojářské nástroje od Applu (Command Line Tools)." >&2
  echo "Nainstaluj je v okně, které se otevřelo (nebo příkazem xcode-select --install), a pak spusť instalaci znovu." >&2
  exit 1
fi

echo "Sestavuji Hodinovka.app…"
bash macos/sestavit.sh "$APP" "$(pwd)"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"
echo "Hotovo: $APP"
