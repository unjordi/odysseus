# widget-biblioteca — Biblioteca Kavita + lectura en voz alta (#31)

> Borrador inicial DESPLEGADO en develop del fork (con overlay GPU), pendiente QA visual de unjordi.
> La biblioteca DESCANSA (2026-09-19): funciona lo mecánico; el UX es proyecto de ~1 mes mínimo.

## Qué es
Navegador de la biblioteca de Kavita dentro de Odysseus + lector del HTML que Kavita renderiza +
lectura en voz alta (TTS). Avance por (usuario, libro) delegado a Kavita, sin dueño central.

## Arquitectura (dónde tocar)
- `services/kavita_client.py` — cliente HTTP defensivo. `get_kavita_url/api_key`: settings GANA sobre env.
  Los endpoints `/api/Image/*` de Kavita EXIGEN `apiKey` como query param (con solo JWT dan 400).
- `services/kavita_library.py` — list_libraries/series/volumes/progress, get_book_info/toc/page/resource
  (rendering DELEGADO a Kavita), get_series_cover, list_people, list_series_by_person.
- `routes/kavita_routes.py` — `/api/kavita/{libraries, series, people, people/{id}/series,
  series/{id}/cover, series/{id}/volumes, progress, book/{id}[/info,/toc,/page,/resource]}`.
- `services/tts/tts_service.py` — TTS multi-provider (kokoro sidecar/local/endpoint/browser);
  `/api/tts/{stats,synthesize,clear-cache}`. Voz/velocidad viven en settings (tts_voice/tts_speed).
- `static/js/kavita-reader.js` — el visor: nav bibliotecas→series→cap→lector + bookTTS + controles
  voz/velocidad en la barra + toggle lista/cuadrícula + toggle Bibliotecas/Autores.
- `static/js/settings.js` — pestaña Biblioteca (URL+apiKey Kavita). `static/js/workspaceRestore.js` —
  clamp de tool-windows al viewport (host-stats).
- `src/settings.py` — kavita_url + kavita_api_key (api_key enmascarado por el scrub).
- Filtro por autor: `POST /api/Series/all-v2` con **FilterField 17 = writers** (verificado en vivo).
- Deploy: `docker compose -f docker-compose.yml -f docker/gpu.nvidia.yml up -d --build odysseus`
  (sin el overlay GPU, host-stats revierte a "GPU —"). Static va BAKED en la imagen, no montado.

## Slices cerrados (PRs del fork, en develop, desplegados)
- #76/#77/#78 conector + rutas + rendering delegado · #79/#80 visor + cableado compose · #81 TTS del libro
- #82 Settings (pestaña Biblioteca) · #83 write-back de progreso (ProgressDto, HTTP 200)
- #87 fix "Cargando" trabado al detener TTS · #88 host-stats clamp durable al viewport
- #89 voz+velocidad en la barra del lector · #90 cuadrícula con portadas + toggle ☰/▦
- #91 fix portada 400→apiKey · #92 organizar por biblioteca/por autor · #93 TTS no filtra AbortError a consola

## Pendiente (el proyecto de 1 mes)
- **UX**: falta MUCHO pulido de navegación y de la organización (por libro/por autor está funcional pero
  hay que DISEÑARLA con calma). Portadas: lo mecánico PERFECTO, el UX por pulir.
- **Voz**: ya mejoró mucho (unjordi QA 2026-09-19). Kokoro es: ef_dora/em_alex/em_santa.
- **Epubs**: la calidad del catálogo la mantiene un **book-master** aparte (no es de este módulo).
  Ver `epub-exemplars.md` para los mejores ejemplares de PRUEBA (ranking de 2044 epubs) y los criterios.
- **④ perf** (no urgente): la lista/grid de ~3558 series renderiza OK con `loading=lazy`.
- QA visual de unjordi de todo lo desplegado (su compuerta natural, no un item que yo tracke).

## Notas de infra
- apiKey Kavita (NO exponer): `KAVITA_API_KEY` en `~/code/odysseus/.env` (gitignored, cableado al compose).
- Epubs del catálogo: `/run/media/unjordi/SteamAndFiles/GoogleDrive/KavitaBiblioteca` (→ /data en el
  contenedor kavita). Red kavita puenteada a odysseus_default (persistente vía compose).
- Contenedor de pruebas: `odysseus-odysseus-1` (127.0.0.1:7000), proxy `https://unjordi.pisa.mx:7001`.
