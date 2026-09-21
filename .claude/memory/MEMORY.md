# Cerebro del fork odysseus — índice

> Los módulos que construimos SOBRE el fork de Odysseus, uno por carpeta `widget-<módulo>/`.
> Vive en el fork para VIAJAR con el código (decisión unjordi 2026-09-19). El hilo de trabajo
> volátil y la sesión master siguen en axon (`~/code/axon/.claude`); aquí va lo DURABLE por módulo.
> Flujo git del fork: worktree → PR → develop (base `develop`, no `dev`). Deploy = SIEMPRE con overlay GPU:
> `docker compose -f docker-compose.yml -f docker/gpu.nvidia.yml up -d --build odysseus`.

- [widget-biblioteca](widget-biblioteca/estado.md) — Biblioteca Kavita + lectura en voz alta (#31). Borrador inicial desplegado; UX = proyecto de ~1 mes.
- [widget-cortex-widget](widget-cortex-widget/estado.md) — pestaña Cortex en Odysseus (broker read-only + knobs), vendorizada de cortex.
- [widget-shell-tiling](widget-shell-tiling/estado.md) — shell #29: geom-restore, mosaico, edge-dock, gesto Escape.
- [widget-mstodo](widget-mstodo/estado.md) — conector MS To-Do (#30), Graph↔RemoteTodo.
- [widget-whichllm](widget-whichllm/estado.md) — refresco del catálogo de modelos (#22c-2/#133).
