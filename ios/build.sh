#!/usr/bin/env bash
# IPA «Хвостов» для App Store: TEAM=<Team ID> ./build.sh → dist/tails-<CODE>.ipa (загрузить — Transporter или Xcode Organizer)
# Версия общая с Android — ../android/version.properties. Подпись автоматическая: в Xcode → Settings → Accounts
# должен быть вход в аккаунт этой команды, а пакет business.spacecode.tails — заведён в App Store Connect.
set -euo pipefail
cd "$(dirname "$0")"; . ../android/version.properties
TEAM=${TEAM:?"нужен Team ID (developer.apple.com → Membership): TEAM=XXXXXXXXXX ./build.sh"}
rm -rf build/Tails.xcarchive build/export
xcodebuild -project Tails.xcodeproj -scheme Tails -configuration Release -destination generic/platform=iOS \
  -archivePath build/Tails.xcarchive -allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM" \
  MARKETING_VERSION="$NAME" CURRENT_PROJECT_VERSION="$CODE" -quiet archive
cat > build/export.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>teamID</key><string>$TEAM</string>
</dict></plist>
EOF
xcodebuild -exportArchive -archivePath build/Tails.xcarchive -exportOptionsPlist build/export.plist \
  -exportPath build/export -allowProvisioningUpdates -quiet
mkdir -p dist
cp build/export/Tails.ipa "dist/tails-$CODE.ipa"
echo "готово: dist/tails-$CODE.ipa (v$NAME, build $CODE)"
