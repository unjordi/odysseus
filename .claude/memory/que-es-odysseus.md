---
name: que-es-odysseus
description: Qué es Odysseus y de dónde viene — el workspace AI self-hosted de PewDiePie cuyo agent-loop está "robado" de opencode. La UI que axon-master opera para dogfoodear axon. Distingue los dos touchpoints homónimos con opencode.
metadata:
  node_type: memory
  type: reference
---

# Qué es Odysseus (y su procedencia)

**Odysseus = el workspace AI self-hosted open-source de PewDiePie** (Felix Kjellberg), lanzado 2026-05-31
(~30k estrellas de GitHub en 3 días). Chat + agentes + research + modelos locales; local-first/privacy-first.
Upstream `odysseus-dev/odysseus`; nuestro fork `unjordi/odysseus` (base `develop`, no `dev`).

**Stack:** FastAPI + uvicorn + httpx, con SPA propia en JS. NO es "todo opencode".

**Su agent-loop SÍ es opencode (robado, dixit el autor).** PewDiePie en su video de lanzamiento:
*"I literally just stole open code."* (transcript `rAzT5lcezPs` en `~/code/axon/docs/youtube/`; las captions
parten "opencode" en "open code"). Confirmado por el `ACKNOWLEDGMENTS.md` del repo: la capa de
**agent-loop / tool-execution** está *adapted from opencode* (linaje sst `opencode-ai`→`anomalyco/opencode`,
MIT), con partes byte-identical a upstream.

**Dos touchpoints homónimos — NO confundir:**
- **opencode-CÓDIGO** = el bucle de agente adaptado DENTRO de odysseus (lo de arriba).
- **provider "opencode"** = OpenCode **Zen/Go** (`*.opencode.ai`, `/zen`), un backend de modelos OpenAI-compat
  que odysseus lista como un proveedor más (`specs/model-providers/opencode.md`). Es la API hospedada, no el código.

**Por qué me importa (axon-master):** Odysseus es la UI que OPERO para dogfoodear axon (axon = harness puro;
odysseus = una UI de prueba). Como su motor ES opencode, el comparativo "opencode vanilla vs axon" mide, literal,
el harness que PewDiePie eligió contra el nuestro. `axon serve` habla OpenAI-compat (shim
`src/server/openai-compat.ts` en axon) → enchufa a odysseus (como provider) y a opencode-CLI por el mismo protocolo.
