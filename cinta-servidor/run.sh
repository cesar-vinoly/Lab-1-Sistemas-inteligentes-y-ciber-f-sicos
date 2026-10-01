#!/usr/bin/env sh
# Inicia el servidor desde la carpeta del script y conserva argumentos del usuario.
set -eu
cd -- "$(dirname -- "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo 'Instala Node.js 24 LTS desde https://nodejs.org/en/download'
  exit 1
fi
exec node server.mjs --open "$@"
