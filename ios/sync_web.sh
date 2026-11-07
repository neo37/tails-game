#!/usr/bin/env bash
# Копирует веб-игру в приложение: тот же набор файлов, что android/sync_web.sh (*.html, *.css, src, assets, models, нужные части three).
# Запускает Xcode на каждой сборке (фаза «Sync web game») — кладёт прямо в Tails.app/www, отдельной копии в репозитории нет.
# Вручную: ./sync_web.sh ПАПКА
set -euo pipefail
W=${1:-"${TARGET_BUILD_DIR:?}/${UNLOCALIZED_RESOURCES_FOLDER_PATH:?}/www"}
cd "$(dirname "$0")/.."
rm -rf "$W"; mkdir -p "$W"
cp ./*.html ./*.css "$W"/; cp -r src assets models "$W"/
mkdir -p "$W/vendor/three/build" "$W/vendor/three/examples"
cp vendor/three/build/three.module.js vendor/three/build/three.core.js "$W/vendor/three/build/"; cp -r vendor/three/examples/jsm "$W/vendor/three/examples/"
[ -f favicon.ico ] && cp favicon.ico "$W"/ || true
find "$W" -name .DS_Store -delete
du -sh "$W"
