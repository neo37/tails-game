#!/usr/bin/env bash
# Снимки экрана для App Store из симулятора: ./screenshots.sh ПАПКА → ПАПКА/iphone-6.9/*.png (2868×1320) и ПАПКА/ipad-13/*.png (2752×2064)
# Сцены расставляет отладочный аргумент -js (только в Debug-сборке): ставит защитников, запускает волну, ведёт корабль автопилотом.
# iPad берётся на iOS 18: iPadOS 26 показывает игру «только горизонтально» с полями, пока симулятор стоит вертикально,
# а повернуть его из командной строки нельзя. Свои устройства: IPHONE="iPhone 16 Pro Max" IPAD="iPad Pro 13-inch (M4)@iOS-18" ./screenshots.sh …
set -euo pipefail
OUT=${1:?папка для снимков}; mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
cd "$(dirname "$0")"; . ../android/version.properties
IPHONE=${IPHONE:-iPhone 17 Pro Max}
IPAD=${IPAD:-iPad Pro 13-inch (M4)@iOS-18}
APP=build/Build/Products/Debug-iphonesimulator/Tails.app
ID=business.spacecode.tails

# «Имя[@iOS-18]» → UDID: самая новая подходящая iOS, на которой есть такое устройство
udid() {
  xcrun simctl list devices available -j 2>/dev/null | /usr/bin/python3 -c '
import json, re, sys
name, _, rt = sys.argv[1].partition("@")
runtimes = json.load(sys.stdin)["devices"]
ver = lambda r: [int(x) for x in re.findall(r"\d+", r.rsplit("iOS", 1)[-1])]
for r in sorted((r for r in runtimes if ".iOS-" in r and rt in r), key=ver, reverse=True):
    for d in runtimes[r]:
        if d["name"] == name: print(d["udid"]); sys.exit()
sys.exit("нет симулятора: " + sys.argv[1])' "$1"
}

# защита замка: побольше ракушек, 7 защитников разного роста, волна — и снимок, когда тени уже на дорожке
TD='(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  while (!window.__td) await wait(200);
  const T = window.__td, me = T.sim.players.get(T.myId), fr = T.level.friends;
  me.shells = 1e5;
  const free = T.SPOTS.map((_, i) => i).filter((i) => T.sim.spots[i].ok);
  free.slice(0, 7).forEach((s, j) => { T.doAct({ k: "build", s, f: fr[j % fr.length] }); for (let u = 0; u < j % 3; u++) T.doAct({ k: "up", s }); });
  me.shells = 185;
  await wait(1500);
  T.doAct({ k: "wave" });
})();'
# гонка: свой корабль летит тем же автопилотом, что и боты (import — по полному адресу: у пользовательского скрипта свой базовый адрес)
RACE='(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  while (!window.__race) await wait(200);
  const { botInput } = await import(new URL("src/race-sim.js", location.href).href);
  const R = window.__race, skill = { miss: 0, vmaxK: 1, sloppy: 0, seed: 1 }, inp = { x: 0, y: 0, brake: false };
  const fly = () => { if (R.state === "go") { botInput(R.mine.p, R.course, R.raceT, skill, inp); Object.assign(R.joy, { active: true, x: inp.x, y: inp.y }); } requestAnimationFrame(fly); };
  fly();
})();'
# конструктор трасс: открыть пример «Крутая спираль»
BUILDER='(async () => {
  if (location.search.includes("code=")) return;
  const m = await import(new URL("src/race-design.js", location.href).href);
  location.replace("race-editor.html?code=" + encodeURIComponent(m.encode(m.EXAMPLES[m.EXAMPLES.length - 1])));
})();'

# имя | страница | секунд до снимка | переменная со скриптом (сам скрипт многострочный — в строку сцены не влезает)
SCENES=(
  "01-castle|play.html?map=castle&level=3&debug|17|TD"
  "02-race|race.html?level=2&debug|11|RACE"
  "03-quay|play.html?map=quay&level=4&debug|17|TD"
  "04-menu|index.html|6|"
  "05-track-builder|race-editor.html|9|BUILDER"
  "06-level-editor|editor.html|9|"
)
# герой на снимках — Призрак: «Танцовщица» в аудите контента (docs/CONTENT_AUDIT.md) отмечена как спорная для детского магазина
HERO='(() => { const m = JSON.parse(localStorage.getItem("tg.me") || "{}"); localStorage.setItem("tg.me", JSON.stringify({ ...m, hero: "ghost" })); })();'

# на снимок иногда попадает чёрная «капля» Dynamic Island (система на миг показывает её, например, когда игра заговорила) —
# тогда снимаем ещё раз. Проверка через PIL; если его нет, снимок берётся как есть.
island() {
  python3 -I - "$1" 2>/dev/null <<'PY'
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB'); w, h = im.size
black = lambda x: all(im.getpixel((x, y)) == (0, 0, 0) for y in (h // 2 - 60, h // 2, h // 2 + 60))
sys.exit(0 if black(80) or black(w - 81) else 1)
PY
}

shoot() {   # shoot ПАПКА УСТРОЙСТВО
  local dir=$OUT/$1 dev=$2 name page secs js
  mkdir -p "$dir"
  xcrun simctl bootstatus "$dev" -b >/dev/null 2>&1
  xcrun simctl install "$dev" "$APP" 2>/dev/null
  xcrun simctl terminate "$dev" "$ID" 2>/dev/null || true
  xcrun simctl launch "$dev" "$ID" -page index.html -js "$HERO" >/dev/null 2>&1; sleep 4
  for s in "${SCENES[@]}"; do
    IFS='|' read -r name page secs js <<<"$s"
    xcrun simctl terminate "$dev" "$ID" 2>/dev/null || true
    if [ -n "$js" ]; then xcrun simctl launch "$dev" "$ID" -page "$page" -js "${!js}" >/dev/null 2>&1
    else xcrun simctl launch "$dev" "$ID" -page "$page" >/dev/null 2>&1; fi
    sleep "$secs"
    for try in 1 2 3 4 5 6; do
      xcrun simctl io "$dev" screenshot --type=png "$dir/$name.png" >/dev/null 2>&1
      island "$dir/$name.png" || break
      sleep 1.5
    done
    # App Store: JPEG — без альфа-канала, который есть у снимков симулятора
    sips -s format jpeg -s formatOptions best "$dir/$name.png" --out "$dir/$name.jpg" >/dev/null && rm "$dir/$name.png"
    echo "$1/$name.jpg $(sips -g pixelWidth -g pixelHeight "$dir/$name.jpg" | awk '/pixel/ {printf "%s ", $2}')"
  done
  xcrun simctl terminate "$dev" "$ID" 2>/dev/null || true
}

PHONE=$(udid "$IPHONE"); PAD=$(udid "$IPAD")
xcodebuild -project Tails.xcodeproj -scheme Tails -configuration Debug -destination "id=$PHONE" -derivedDataPath build \
  MARKETING_VERSION="$NAME" CURRENT_PROJECT_VERSION="$CODE" -quiet build
shoot iphone-6.9 "$PHONE"
shoot ipad-13 "$PAD"
