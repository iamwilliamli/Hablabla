#!/bin/sh
set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
package_directory=$(dirname "$script_directory")
derived_data="$package_directory/.xcode-derived"

DEVELOPER_DIR=${DEVELOPER_DIR:-$(xcode-select -p)} \
  xcodebuild \
    -scheme HablablaModelWorker \
    -destination 'platform=macOS,arch=arm64' \
    -configuration Release \
    -derivedDataPath "$derived_data" \
    COMPILATION_CACHE_CAS_PATH="$derived_data/CompilationCache.noindex" \
    SYMROOT="$derived_data/Build/Products" \
    OBJROOT="$derived_data/Build/Intermediates.noindex" \
    build

printf '%s\n' "$derived_data/Build/Products/Release/hablabla-model-worker"
