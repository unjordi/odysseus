# stack/ — notas operativas del stack de ESTE fork

Documentación específica del fork sobre cómo corre nuestro stack unificado (Odysseus + axon + TTS +
la terminal/shell del workspace). Las citan los compose y `docker/*.yml` (p. ej. `stack-unificado.md`
es el grafo de dependencias del stack).

**Por qué aquí y no en `docs/`:** upstream reserva `docs/` para el modelo de propiedad del sitio de
GitHub Pages — `tests/test_docs_no_orphan_images.py::test_pages_site_owns_its_entrypoint_and_media`
prohíbe cualquier `.md` bajo `docs/` (el markdown público vive en `website/`). Estas notas no son
públicas ni son specs de subsistema (`specs/` es upstream, con su propio contrato/DocumentMap): son del
fork, así que viven en su propia carpeta.
