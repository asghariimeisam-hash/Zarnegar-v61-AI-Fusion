#!/bin/sh
# Minimal Gradle wrapper launcher. The jar is generated on CI if missing.
DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
JAR="$DIR/gradle/wrapper/gradle-wrapper.jar"
if [ ! -f "$JAR" ]; then
  echo "gradle-wrapper.jar missing. On CI run: gradle wrapper --gradle-version 8.9" >&2
  exit 2
fi
exec java -Xmx64m -Xms64m -Dorg.gradle.appname=gradlew -classpath "$JAR" org.gradle.wrapper.GradleWrapperMain "$@"
