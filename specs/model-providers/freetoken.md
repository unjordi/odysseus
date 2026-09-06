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

## Running the FreeToken backend (host setup — reproducible)

FreeToken is a HOST service Odysseus never launches itself; the endpoint above
only *points at* it. To have it available, run FreeToken on the host serving the
MoE model (we use **gpt-oss-120b**, offloaded to RAM). Reproducible steps
(paths shown for the reference host — a Linux box with an NVIDIA RTX 50xx +
ample RAM; adapt `$HOME`/venv path to yours):

1. **Install** the CLI (once): `uv pip install "freetoken[accel]"` into a venv
   (reference host: `~/.local/freetoken-venv`). Model `openai/gpt-oss-120b` is
   pulled to the HF cache on first serve. Run `ft bench bw` once per machine
   before serving large models (Q★ needs the measured bandwidth).
2. **Serve it as a persistent service** (NOT a bare `nohup` — that dies on
   reboot). systemd `--user` unit (`~/.config/systemd/user/freetoken.service`):

   ```ini
   [Unit]
   Description=FreeToken — MoE (gpt-oss-120b) OpenAI-compat server on :7090
   After=network-online.target
   [Service]
   Type=simple
   ExecStart=%h/.local/freetoken-venv/bin/ft serve \
     --model openai/gpt-oss-120b --served-model-name gpt-oss-120b \
     --host 0.0.0.0 --port 7090 --moe-backend auto \
     --tool-call-parser gpt_oss --reasoning-parser gpt_oss
   Restart=on-failure
   RestartSec=10
   TimeoutStartSec=0
   [Install]
   WantedBy=default.target
   ```
   `systemctl --user enable --now freetoken.service`. **`--host 0.0.0.0` is
   required** — loopback-only is unreachable from the Odysseus container.
3. **Open the firewall** for Docker→host on :7090 (see the gap note below).

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
