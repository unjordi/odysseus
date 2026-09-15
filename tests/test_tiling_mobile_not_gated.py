"""Regresión #29 — el tiling NO se apaga por ancho de viewport móvil.

Un agente metió sin autorización un guard `if (window.innerWidth <= 768) return;`
en tileShortcuts.js que DESACTIVABA el tiling en teléfono. El dueño lo quiere
revertido de forma permanente: el tiling debe operar también en móvil (tileSlots
trae las fracciones ½/⅔/⅓ diseñadas justo para partir pantallas chicas).

Este test es el MECANISMO que impide que el guard reaparezca: escanea la fuente
de tileShortcuts.js y falla si vuelve a aparecer un corte ejecutable por
`window.innerWidth <= 768` (o `< 768`) que haga `return` / `break`. Es
comment-safe: solo matchea el statement ejecutable, no la prosa que explica por
qué se revirtió.
"""

import re
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
_SRC = _REPO / "static" / "js" / "tileShortcuts.js"


def _strip_comments(js: str) -> str:
    """Quita comentarios de bloque y de línea para no matchear la prosa."""
    js = re.sub(r"/\*.*?\*/", "", js, flags=re.DOTALL)
    js = re.sub(r"//[^\n]*", "", js)
    return js


def test_tileshortcuts_has_no_mobile_width_gate():
    code = _strip_comments(_SRC.read_text(encoding="utf-8"))
    # Un guard de ancho móvil: `window.innerWidth <= 768` (o `< 768`) seguido de
    # un corte de flujo (return/break) o dentro de un `if (...)` que corta.
    gate = re.compile(
        r"window\.innerWidth\s*<=?\s*768[^\n]*\b(return|break)\b",
        re.IGNORECASE,
    )
    m = gate.search(code)
    assert m is None, (
        "Reapareció un guard de ancho móvil en tileShortcuts.js "
        f"(el tiling NO debe apagarse en teléfono): {m.group(0)!r}"
    )

    # Y de forma más amplia: NINGÚN `<= 768`/`< 768` ejecutable en el módulo de
    # atajos (todo el gating por ancho de escritorio debe estar fuera de aquí).
    assert re.search(r"\b768\b", code) is None, (
        "tileShortcuts.js no debe contener ningún gate por 768 en código "
        "ejecutable; el área se calcula desde innerWidth/innerHeight reales."
    )
