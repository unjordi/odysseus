# widget-whichllm — refresco del catálogo de modelos (#22c-2 / #133)

> Botón de refrescar el catálogo de modelos, host-side. Movido al fork odysseus (#133). EN develop.

## Estado
- Adaptador construido+cableado (odysseus #18/#22). #133b: refresh ASÍNCRONO + polling para evitar el
  REQUEST_HARD_TIMEOUT=45s (un catálogo lento tumbaba la request síncrona).
- Pendiente: QA visual de unjordi del botón de refrescar. Sin decisiones abiertas.
