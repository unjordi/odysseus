# FreeToken Provider Shape

Last updated: dev@4f0ab38 | 2026-09-06

## Scope

Canonical explicit identity `freetoken`; local MoE (Mixture-of-Experts) serving
engine exposing an OpenAI-compatible `/v1` surface, normally reachable on the
Docker host at port 7090 (not one of the ports Odysseus already fingerprints
natively). No dedicated reader; uses the generic identity-only inventory
normalization (`src/model_capability_readers/generic_openai.py`).

## Registration

Auto-registered as a `model_endpoints` row on every Odysseus boot by
`app.py` `_seed_freetoken_endpoint` (fire-and-forget startup task, mirrors the
Cookbook auto-register pattern in `routes/cookbook_routes.py`
`_auto_register_llm_endpoint`, but for an always-on external service Odysseus
never launches itself). Default base URL is
`http://host.docker.internal:7090/v1` inside the container (`http://127.0.0.1:7090/v1`
on a native/non-Docker install); override with `FREETOKEN_BASE_URL` (full
`.../v1` base) or `FREETOKEN_PORT`. Disable the seed entirely with
`ODYSSEUS_FREETOKEN_ENDPOINT=0`. The seed probes `/v1/models` live via the
existing `_probe_endpoint` helper — it never hardcodes a model id — and is a
silent no-op (one short connect timeout) when FreeToken is not running, so it
never blocks or slows down startup.

Also present in `ModelDiscovery`'s well-known port list (`src/model_discovery.py`)
as a manual "Scan for Servers" fallback, alongside the other local engines
(vLLM/SGLang/llama.cpp/LM Studio/Ollama).

## Catalog Shape

Observed `GET /v1/models` (2026-09-06, one model loaded):

```json
{"object":"list","data":[{"id":"gpt-oss-120b","object":"model","created":1788731233,
  "owned_by":"FreeToken","root":"openai/gpt-oss-120b","max_model_len":131072,
  "context_length":131072,"supported_reasoning_efforts":["high","medium","low"],
  "default_reasoning_effort":"medium"}]}
```

Shares vLLM's card fields (`max_model_len`, `root`) plus `owned_by: "FreeToken"`
identifying the engine, and adds reasoning-effort control fields
(`supported_reasoning_efforts`, `default_reasoning_effort`) not present in
plain vLLM. The generic reader retains only identity (`id`); the reasoning and
`max_model_len` fields are raw/unread — a dedicated reader is not implemented.

## Running the FreeToken backend (host setup)

FreeToken is a HOST service Odysseus never launches itself; the endpoint above
only *points at* it, and treats it as an always-on external engine (the boot
seed is a silent no-op when it is down).

> ### 🛑 REGLA DURA: gpt-oss-120b es ON-DEMAND, **NUNCA pineado/always-on en RAM**
> Decisión de unjordi (ver axon `.claude/memory/` bitácora 2026-08-27 «no pinear
> 66GB por sorpresa» + estado-proyecto 2026-08-28 «no pinear en RAM/SSD modelos
> enormes sin usar»). El 120b se invoca **explícitamente cuando hace falta**; su
> pool de expertos vive en un **hueco dedicado del SSD NVMe** para cargar rápido,
> **no** copiado/pineado en RAM ni mezclado con el blob que `ollama-ram-pin`
> mlockea. **PROHIBIDO** correr `ft serve` como servicio always-on con
> `--moe-cache-auto`/`--moe-backend offload` sin tope: eso mete ~60GB en RAM
> compartida (`Shmem`) + ~14GB de VRAM de forma permanente y satura la máquina.
> (Incidente 2026-09-06: un `freetoken.service` always-on subió la RAM usada a
> 97/123GB y casi la crashea; se detuvo y deshabilitó.)
>
> **Cómo SÍ:** arrancar `ft serve` **on-demand** (cuando un chat/agente va a usar
> el 120b) y bajarlo al terminar, con el modelo en el NVMe rápido y **sin** cache
> de expertos pineada (dejar que las páginas del modelo sean page-cache
> reclamable, no `Shmem` committed). El comando exacto/mecanismo on-demand
> (socket-activation, wrapper de arranque-bajo-demanda, o flags de cache
> acotada) **queda por confirmar con unjordi** — hasta entonces NO dejarlo
> corriendo. `--host 0.0.0.0` es necesario para que el contenedor lo alcance;
> ver la regla de firewall en los gaps de abajo.
>
> Instalación (una vez): `uv pip install "freetoken[accel]"` en un venv; `ft
> bench bw` una vez por máquina antes de servir modelos grandes.

## Fallback And Current Gaps

- No native/dedicated capability reader; generic OpenAI-compatible inventory
  only.
- `supported_reasoning_efforts`/`default_reasoning_effort` are observed but not
  wired into any runtime reasoning-effort control path.
- Docker reachability from the container to the host's FreeToken port depends
  on the host firewall permitting Docker-forwarded traffic on that port — same
  requirement as any other host-bound local engine. **Without the rule the
  container's request to `:7090` TIMES OUT** (packets dropped) even though
  FreeToken binds `0.0.0.0`. Mirror the rule that already allows Ollama's 11434.
  With `ufw` (the reference host): `sudo ufw allow from 172.16.0.0/12 to any
  port 7090 proto tcp comment 'FreeToken for Docker nets — LAN blocked'`
  (`172.16.0.0/12` covers Docker's default bridge ranges; LAN stays blocked).
