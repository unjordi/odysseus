"""Runs the Rectangle-style tiling suite under pytest.

Behavior lives in tests/tile_slots.test.mjs (node:test, no DOM). This wrapper
only exists so the JS suite runs in the normal pytest job — same pattern as
tests/test_live_thinking_scheduler_js.py.

Two defects this suite already caught, which is why it is wired here and not
left as a file someone remembers to run: an area with `width: Infinity` passed
a bare `width > 0` and produced a window of infinite width, and a `null` area
threw a TypeError out of a module that promises never to throw.
"""

import shutil
import subprocess
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parent.parent
_HAS_NODE = shutil.which("node") is not None


@pytest.mark.skipif(not _HAS_NODE, reason="node binary not on PATH")
def test_tile_slots_geometry():
    result = subprocess.run(
        ["node", "--test", "tests/tile_slots.test.mjs"],
        cwd=_REPO,
        capture_output=True,
        timeout=30,
        text=True,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"node --test failed:\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
        )
