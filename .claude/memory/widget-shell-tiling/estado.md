# widget-shell-tiling — shell de ventanas (#29)

> Tiling/mosaico + geom-restore + edge-dock + gesto Escape. QA'd en el sweep 2026-09-18 (edge-dock
> funciona; host-stats ya no se desfasa con el clamp #88).

## Piezas
- `static/js/windowDrag.js` — drag + edge-dock L/R + captura de geom (#29e). enableFullscreen=false
  (cede el fullscreen a tileManager).
- `static/js/workspaceRestore.js` — restore de geom al reabrir + `clampOpenWindowsToViewport()` (#88):
  re-clampa tool-windows flotantes al viewport en resize + ~1.2s post-restore, persiste la geom corregida.
- `static/js/modalSnap.js` / `tileManager.js` — edge-dock rico (colapso sidebar) vs mosaico.
- Gesto Escape (#29g): árbitro tap-vs-hold.

## PRs
fork #31/#67/#68 (mosaico/geom base), #88 (clamp durable). axon #140/#144 relacionados.
Pendiente: pulido UX general del shell (parte del proyecto grande de UX de Odysseus).
