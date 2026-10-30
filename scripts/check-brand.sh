#!/usr/bin/env bash
# Les icônes du nœud sont COPIÉES du paquet `@agentova-ai-company/brand`
# (assets/logo/mark-ink.svg et mark-white.svg), jamais retouchées. Ce dépôt
# est public : il n'a pas accès au registre privé du paquet. Il compare donc
# ses copies à celles que sert l'application, elles-mêmes vérifiées contre
# le paquet par `pnpm check:brand` dans saas-agentova-ai.
set -euo pipefail

BASE_URL="${BRAND_BASE_URL:-https://app.agentova.ai/brand/logo}"
status=0
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

for file in mark-ink.svg mark-white.svg; do
  curl --fail --silent --show-error --retry 3 "$BASE_URL/$file" --output "$tmp/$file"
  if cmp --silent "$tmp/$file" "nodes/Agentova/$file"; then
    echo "OK  nodes/Agentova/$file"
  else
    echo "KO  nodes/Agentova/$file diffère du paquet de marque : recopier assets/logo/$file"
    status=1
  fi
done
exit "$status"
