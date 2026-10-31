#!/usr/bin/env bash
# Comprueba que el stack reordena la memoria con el cross-encoder en CPU y no con el LLM (axon #95).
# El contenedor de axon no alcanza el reranqueador del HOST (127.0.0.1:8090), así que el servicio tiene
# que existir en la red interna y el main car tiene que apuntarle. Sin esto, la memoria cae en silencio
# al reranqueo generativo con qwen3:4b: no falla nada, solo ordena peor.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
fallos=0
ok() { if [ "$2" = "0" ]; then echo "ok   $1"; else echo "FAIL $1${3:+$'\n     '$3}"; fallos=$((fallos+1)); fi; }

cfg=$(docker compose -f docker-compose.yml -f docker/axon.yml config 2>/dev/null)
[ -n "$cfg" ] || { echo "FAIL escenario: 'docker compose config' no resolvió el stack"; exit 1; }
ok "escenario: el compose del stack resuelve" 0

grep -q '^  reranker:' <<<"$cfg"; ok "el stack declara el servicio reranker" $?
grep -A 20 '^  reranker:' <<<"$cfg" | grep -q -- '--reranking'; ok "el reranker corre en modo reranking" $?
# `config` normaliza el command a una lista: el flag y su valor caen en LÍNEAS distintas.
grep -A 20 '^  reranker:' <<<"$cfg" | grep -A 1 -- '- -ngl' | grep -qE '^\s*- "?0"?\s*$'; ok "y en CPU (-ngl 0), sin pedir VRAM" $?

url=$(grep -oE 'AXON_MEM_RERANK_URL: [^[:space:]]+' <<<"$cfg" | head -1 | cut -d' ' -f2)
[ -n "$url" ]; ok "el main car lleva AXON_MEM_RERANK_URL" $? "no aparece en el compose resuelto"
[[ "$url" == http://reranker:* ]]; ok "y apunta al servicio de la red interna, no al host" $? "es '$url'"
[ -n "$url" ] && [[ "$url" != *127.0.0.1* && "$url" != *host.docker.internal* ]]; ok "no apunta a un puerto del host que el contenedor no alcanza" $? "es '$url'"

[ "$fallos" = 0 ] && echo && echo "PASS" || { echo; echo "❌ $fallos fallo(s)"; }
exit $((fallos > 0))
