#!/bin/bash
# Sestaví Hodinovka.app (okno je v macos/Hodinovka.swift).
#   macos/sestavit.sh CIL.app SLOZKA  vývojová: spouští Hodinovku ze SLOZKY projektu (používá ji instalovat.sh)
#   macos/sestavit.sh CIL.app         ke stažení z GitHubu: kód nese v sobě, pro Apple Silicon i Intel
set -euo pipefail
cd "$(dirname "$0")/.."
TARGET=$1
FOLDER=${2:-}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

CONTENTS="$TMP/Hodinovka.app/Contents"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"
if [ -n "$FOLDER" ]; then ARCHS=$(uname -m); else ARCHS="arm64 x86_64"; fi
for arch in $ARCHS; do
  xcrun swiftc -O -swift-version 5 -target "$arch-apple-macos12.0" -o "$TMP/Hodinovka-$arch" macos/Hodinovka.swift
done
lipo -create "$TMP"/Hodinovka-* -output "$CONTENTS/MacOS/Hodinovka"
cp macos/Hodinovka.icns "$CONTENTS/Resources/Hodinovka.icns"
cat > "$CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>cs</string>
	<key>CFBundleLocalizations</key>
	<array>
		<string>cs</string>
	</array>
	<key>CFBundleExecutable</key>
	<string>Hodinovka</string>
	<key>CFBundleIconFile</key>
	<string>Hodinovka</string>
	<key>CFBundleIdentifier</key>
	<string>local.hodinovka</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>Hodinovka</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>CFBundleURLTypes</key>
	<array>
		<dict>
			<key>CFBundleURLName</key>
			<string>local.hodinovka</string>
			<key>CFBundleURLSchemes</key>
			<array>
				<string>hodinovka</string>
			</array>
		</dict>
	</array>
	<key>LSApplicationCategoryType</key>
	<string>public.app-category.productivity</string>
	<key>LSMinimumSystemVersion</key>
	<string>12.0</string>
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSAllowsLocalNetworking</key>
		<true/>
	</dict>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>NSPrincipalClass</key>
	<string>NSApplication</string>
</dict>
</plist>
PLIST

if [ -n "$FOLDER" ]; then
  plutil -insert HodinovkaFolder -string "$FOLDER" "$CONTENTS/Info.plist"
else
  mkdir "$CONTENTS/Resources/app"
  git archive HEAD | tar -x -C "$CONTENTS/Resources/app"
fi
codesign --force --sign - "$TMP/Hodinovka.app"

rm -rf "$TARGET"
mkdir -p "$(dirname "$TARGET")"
ditto "$TMP/Hodinovka.app" "$TARGET"
