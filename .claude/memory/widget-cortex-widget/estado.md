# widget-cortex-widget — pestaña Cortex en Odysseus

> Read-only del broker + knobs, VENDORIZADA de cortex con hashes (patrón del term-broker: cortex EMITE
> el artefacto, odysseus lo VENDORIZA con hashes → anti-drift). PRs #144/#146/#147/#148. EN develop.

## Qué es
Pestaña "Cortex" del widget web en Odysseus: Límites (cuota real oauth), Resumen, Modelos, Proyectos,
Chats, Cerebro y **Broker** (estado del cortex-term-broker: servicio/puerto/socket/token/memoria + knobs).

## Dónde
- Frontend: el widget vendorizado (artefacto emitido por cortex, hashes verificados al importar).
- Backend axon: endpoint `GET /api/cortex/broker` (lo consume la pestaña, read-only).

## Estado
Desplegado, QA visual verificado en el sweep 2026-09-18 (Broker: responde ✓, cuota real fresca).
Anti-drift: si cambia el artefacto en cortex, se re-vendoriza con hashes — no editar la copia a mano.
