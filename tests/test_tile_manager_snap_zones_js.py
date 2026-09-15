"""Regression coverage for desktop modal tile snap edge zones."""

import json
import shutil
import subprocess
import textwrap
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parent.parent
_HELPER = _REPO / "static" / "js" / "tileManager.js"
_HAS_NODE = shutil.which("node") is not None


def _run_tile_case():
    script = textwrap.dedent(
        f"""
        globalThis.window = {{
          innerWidth: 1200,
          innerHeight: 800,
          addEventListener() {{}},
        }};
        globalThis.document = {{
          readyState: 'loading',
          body: {{ appendChild() {{}} }},
          documentElement: {{ style: {{ setProperty() {{}}, removeProperty() {{}} }} }},
          addEventListener() {{}},
          getElementById() {{ return null; }},
          querySelector() {{ return null; }},
          querySelectorAll() {{ return []; }},
          createElement() {{
            return {{
              style: {{}},
              classList: {{ add() {{}}, remove() {{}} }},
              remove() {{}},
            }};
          }},
        }};
        globalThis.requestAnimationFrame = (fn) => fn();
        globalThis.MutationObserver = class {{
          observe() {{}}
          disconnect() {{}}
        }};

        const mod = await import('{_HELPER.as_posix()}');
        const pick = (zone) => zone ? {{
          name: zone.name,
          rect: {{
            left: zone.rect.left,
            top: zone.rect.top,
            width: zone.rect.width,
            height: zone.rect.height,
          }},
        }} : null;

        const memoryModal = {{ id: 'memory-modal' }};
        const memoryContent = {{ closest() {{ return memoryModal; }} }};
        const settingsModal = {{ id: 'settings-modal' }};
        const settingsContent = {{ closest() {{ return settingsModal; }} }};

        // Modal dock-capaz (windowDrag le pone `_hasEdgeDock`): tileManager cede
        // L/R al edge-dock de modalSnap → excludeSides=true.
        const dockModal = {{ id: 'terminal-modal', _hasEdgeDock: true }};
        const dockContent = {{ closest() {{ return dockModal; }} }};

        console.log(JSON.stringify({{
          fullscreen: pick(mod._zoneForPointerForTests(500, 0)),
          maximize: pick(mod._zoneForPointerForTests(500, 8)),
          top: pick(mod._zoneForPointerForTests(500, 20)),
          left: pick(mod._zoneForPointerForTests(20, 300)),
          right: pick(mod._zoneForPointerForTests(1190, 300)),
          bottom: pick(mod._zoneForPointerForTests(500, 790)),
          memoryBottom: pick(mod._zoneForContentForTests(memoryContent, 500, 790)),
          settingsTop: pick(mod._zoneForContentForTests(settingsContent, 500, 20)),
          settingsRight: pick(mod._zoneForContentForTests(settingsContent, 1190, 300)),
          // excludeSides: L/R se ceden pero el resto de zonas se conservan.
          exLeft: pick(mod._zoneForPointerForTests(20, 300, true)),
          exRight: pick(mod._zoneForPointerForTests(1190, 300, true)),
          exTop: pick(mod._zoneForPointerForTests(500, 20, true)),
          exBottom: pick(mod._zoneForPointerForTests(500, 790, true)),
          exMax: pick(mod._zoneForPointerForTests(500, 8, true)),
          exFull: pick(mod._zoneForPointerForTests(500, 0, true)),
          // Un modal dock-capaz cede L/R también vía _zoneForContent(excludeSides).
          dockLeft: pick(mod._zoneForContentForTests(dockContent, 20, 300, true)),
          dockRight: pick(mod._zoneForContentForTests(dockContent, 1190, 300, true)),
          dockTop: pick(mod._zoneForContentForTests(dockContent, 500, 20, true)),
        }}));
        """
    )
    proc = subprocess.run(
        ["node", "--input-type=module"],
        input=script,
        capture_output=True,
        text=True,
        cwd=str(_REPO),
        timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout.strip())


@pytest.mark.skipif(not _HAS_NODE, reason="node binary not on PATH")
def test_tile_manager_detects_all_four_workspace_edges():
    zones = _run_tile_case()

    assert zones["fullscreen"]["name"] == "fullscreen"
    assert zones["maximize"]["name"] == "maximize"
    assert zones["top"] == {
        "name": "top-half",
        "rect": {"left": 4, "top": 4, "width": 1192, "height": 396},
    }
    assert zones["left"] == {
        "name": "left-half",
        "rect": {"left": 4, "top": 4, "width": 596, "height": 792},
    }
    assert zones["right"] == {
        "name": "right-half",
        "rect": {"left": 600, "top": 4, "width": 596, "height": 792},
    }
    assert zones["bottom"] == {
        "name": "bottom-half",
        "rect": {"left": 4, "top": 400, "width": 1192, "height": 396},
    }


@pytest.mark.skipif(not _HAS_NODE, reason="node binary not on PATH")
def test_regular_tool_modals_are_not_limited_to_fullscreen_only():
    zones = _run_tile_case()

    assert zones["memoryBottom"]["name"] == "bottom-half"
    assert zones["settingsTop"] is None
    assert zones["settingsRight"]["name"] == "right-half"


@pytest.mark.skipif(not _HAS_NODE, reason="node binary not on PATH")
def test_edge_dock_capable_modal_yields_left_right_to_modalsnap():
    """Bug #29 — dos sistemas de edge-dock competían en el mismo drag-release.

    Con la reconciliación, un modal dock-capaz (marcado `_hasEdgeDock` por
    windowDrag) hace que tileManager CEDA las zonas left-half/right-half al
    edge-dock de modalSnap (fuente única de verdad del edge-dock), pero
    conserva top/bottom/maximize/fullscreen, que modalSnap no cubre.
    """
    zones = _run_tile_case()

    # L/R cedidas cuando excludeSides.
    assert zones["exLeft"] is None
    assert zones["exRight"] is None
    assert zones["dockLeft"] is None
    assert zones["dockRight"] is None
    # El resto de zonas se conservan — NO se pierde funcionalidad.
    assert zones["exTop"]["name"] == "top-half"
    assert zones["exBottom"]["name"] == "bottom-half"
    assert zones["exMax"]["name"] == "maximize"
    assert zones["exFull"]["name"] == "fullscreen"
    assert zones["dockTop"]["name"] == "top-half"
    # Sin excludeSides (p. ej. el drag del chip minimizado, único dueño ahí)
    # las zonas L/R SIGUEN existiendo — no se rompió el otro camino.
    assert zones["left"]["name"] == "left-half"
    assert zones["right"]["name"] == "right-half"
