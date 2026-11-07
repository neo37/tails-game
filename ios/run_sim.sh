#!/usr/bin/env bash
# «Хвосты» в симуляторе iOS: ./run_sim.sh ["iPhone 17"] — собрать Debug, поставить и запустить.
# Без имени берёт первый iPhone на самой новой iOS. Логи страницы (console.*, ошибки JS) — в выводе после запуска, Ctrl+C — выйти.
set -euo pipefail
cd "$(dirname "$0")"; . ../android/version.properties
UDID=$(xcrun simctl list devices available -j | /usr/bin/python3 -c '
import json, re, sys
want = sys.argv[1]
runtimes = json.load(sys.stdin)["devices"]
ver = lambda r: [int(x) for x in re.findall(r"\d+", r.rsplit("iOS", 1)[-1])]
for r in sorted((r for r in runtimes if ".iOS-" in r), key=ver, reverse=True):
    for d in runtimes[r]:
        if (d["name"] == want) if want else d["name"].startswith("iPhone"):
            print(d["udid"]); sys.exit()
sys.exit("нет такого симулятора: " + (want or "iPhone"))' "${1:-}")
xcodebuild -project Tails.xcodeproj -scheme Tails -configuration Debug -destination "id=$UDID" -derivedDataPath build \
  MARKETING_VERSION="$NAME" CURRENT_PROJECT_VERSION="$CODE" -quiet build
xcrun simctl bootstatus "$UDID" -b >/dev/null
# окно симулятора: Simulator.app, в Xcode 27 — DeviceHub
open -a Simulator --args -CurrentDeviceUDID "$UDID" 2>/dev/null || open -a DeviceHub 2>/dev/null || true
xcrun simctl install "$UDID" build/Build/Products/Debug-iphonesimulator/Tails.app
xcrun simctl launch --console-pty --terminate-running-process "$UDID" business.spacecode.tails
