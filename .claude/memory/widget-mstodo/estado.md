# widget-mstodo — conector MS To-Do (#30)

> Mapeo Graph↔RemoteTodo. Conector CONSTRUIDO en rama `feat/30-mstodo-connector` (origin), NO mergeado.

## Estado
- Mapeo puro Graph↔RemoteTodo ya EN develop (axon #303).
- Conector completo (mstodo_auth + mstodo_sync + tests + db), compileall verde, en su rama.
- **BLOQUEADO para merge**: falta (a) pytest EN EL CONTENEDOR (el host no tiene pytest) + (b) client_id
  de Azure para QA end-to-end. No mergear hasta pytest verde.

## Cómo correr pytest en el contenedor (host sin pytest)
`docker run --rm -v "$PWD":/app -w /app --entrypoint sh odysseus-odysseus:latest -c 'python -m pytest tests/ -k mstodo -q'`
Ojo: deja archivos root-owned → chown/rm por contenedor root antes de `git worktree remove`.
