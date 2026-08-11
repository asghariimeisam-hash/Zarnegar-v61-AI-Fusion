#!/usr/bin/env bash
set -euo pipefail
if [[ -x ./gradlew ]]; then
  ./gradlew assembleDebug
elif command -v gradle >/dev/null 2>&1; then
  gradle assembleDebug
else
  echo "Gradle/Android SDK not found here. Open this project in Android Studio and use Build > Build APK(s)." >&2
  exit 2
fi
