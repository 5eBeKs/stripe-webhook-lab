#!/bin/sh
# Packs each function of each version, with its imports, into one eszip file:
#   app/<version>/supabase/functions/<name>/index.ts -> /bundles/<version>/<name>.eszip
# Folders whose names start with _ hold shared code and are packed into the functions that import them.
# This is the stand's only step with network access: it downloads the imports and packs them. The two
# top-level npm packages are pinned in the code; their dependencies resolve at bundle time (there is no lock
# file). It does not run the functions; they run only inside the stand's closed network.
set -e
for v in $VERSIONS; do
  rm -rf "/bundles/$v"
  mkdir -p "/bundles/$v"
  for dir in /app/"$v"/supabase/functions/*/; do
    name=$(basename "$dir")
    case "$name" in _*) continue ;; esac
    [ -f "${dir}index.ts" ] || continue
    edge-runtime bundle --quiet --entrypoint "${dir}index.ts" --output "/bundles/$v/$name.eszip"
    echo "bundled $v/$name"
  done
done
