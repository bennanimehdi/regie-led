#!/bin/bash
# Double-clic : démarre la Régie LED et l'ouvre dans Chrome. Fermer cette fenêtre arrête la régie.
cd "$(dirname "$0")" || exit 1
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
URL="http://localhost:4400"
ouvrir() { open -a "Google Chrome" "$URL" 2>/dev/null || open "$URL"; }

if curl -s -o /dev/null "$URL/api/media"; then
  echo "La Régie LED tourne déjà : ouverture dans le navigateur."
  ouvrir
  exit 0
fi
if ! command -v node >/dev/null; then
  echo "Node.js est introuvable sur cet ordinateur. Installe-le depuis https://nodejs.org puis relance."
  read -r -p "Entrée pour fermer…"
  exit 1
fi
( sleep 1; ouvrir ) &
echo "Régie LED démarrée — garde cette fenêtre ouverte pendant l'événement."
exec node serve.js
