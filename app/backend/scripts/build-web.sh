#!/usr/bin/env bash
# Flutter Web をビルドして public/ に出力する。Vercel のビルドとローカルで同じ手順を使う。
set -euo pipefail

FLUTTER_VERSION="3.47.5"
# タグは付け替えられる可能性があるため、取得したコミットも照合する
FLUTTER_COMMIT="6a19cca56475dbfba1478ee68d7bd0c2ef891da1"

BACKEND_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$(cd "$BACKEND_DIR/../mobile-app" && pwd)"

if ! command -v flutter >/dev/null 2>&1; then
  # Vercel のビルド環境には Flutter がないので取得する。
  # node_modules/.cache は Vercel のビルドキャッシュで引き継がれるので、2回目以降は再取得しない
  # （キャッシュが消えた場合やサイズ上限を超えた場合は毎回取得になる。ビルド時間が延びるだけ）
  # 取得先はこのスクリプト専用の場所に固定する（任意のパスを削除しないため）
  FLUTTER_HOME="$BACKEND_DIR/node_modules/.cache/flutter-$FLUTTER_VERSION"
  if [ ! -x "$FLUTTER_HOME/bin/flutter" ]; then
    echo "Installing Flutter $FLUTTER_VERSION ..."
    # Dart SDK の展開に unzip が必要
    command -v unzip >/dev/null 2>&1 || dnf install -y unzip
    rm -rf "$FLUTTER_HOME"
    git clone --depth 1 --branch "$FLUTTER_VERSION" \
      https://github.com/flutter/flutter.git "$FLUTTER_HOME"
  fi
  # キャッシュされた SDK が改変されていないこと（コミットと追跡ファイル）を確認する
  if [ "$(git -C "$FLUTTER_HOME" rev-parse HEAD)" != "$FLUTTER_COMMIT" ] ||
    [ -n "$(git -C "$FLUTTER_HOME" status --porcelain --untracked-files=no)" ]; then
    echo "error: cached Flutter $FLUTTER_VERSION does not match $FLUTTER_COMMIT; reinstalling" >&2
    rm -rf "$FLUTTER_HOME"
    git clone --depth 1 --branch "$FLUTTER_VERSION" \
      https://github.com/flutter/flutter.git "$FLUTTER_HOME"
    if [ "$(git -C "$FLUTTER_HOME" rev-parse HEAD)" != "$FLUTTER_COMMIT" ]; then
      echo "error: Flutter $FLUTTER_VERSION is not at the expected commit $FLUTTER_COMMIT" >&2
      exit 1
    fi
  fi
  export PATH="$FLUTTER_HOME/bin:$PATH"
  # 取得先を既定（公式）に固定する
  unset FLUTTER_STORAGE_BASE_URL PUB_HOSTED_URL
fi

flutter config --no-analytics >/dev/null 2>&1 || true
# 初回実行時の案内などが混ざらないよう、先に一度実行しておく
flutter --version >/dev/null
ACTUAL_VERSION="$(flutter --version --machine | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).frameworkVersion))')"
if [ "$ACTUAL_VERSION" != "$FLUTTER_VERSION" ]; then
  echo "error: Flutter $FLUTTER_VERSION is required (found $ACTUAL_VERSION)" >&2
  exit 1
fi

cd "$APP_DIR"
# pubspec.lock どおりの依存だけを使う
flutter pub get --enforce-lockfile
# --no-web-resources-cdn: CanvasKit を外部 CDN ではなく自ドメインから配信する
# API の接続先は既定で同一オリジンの /api/v1（Env.apiBaseUrl）
flutter build web --release --no-web-resources-cdn --output "$BACKEND_DIR/public"
