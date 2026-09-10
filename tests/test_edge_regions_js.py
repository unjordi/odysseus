"""Runs the edge-region reservation suite under pytest.

Behavior lives in tests/edge_regions.test.mjs (node:test, no DOM). This wrapper
only exists so the JS suite runs in the normal pytest job — same pattern as
tests/test_tile_slots_js.py.

The suite pins the composition rule that generalizes hostStats.js's single-widget
dock: two widgets on the SAME edge STACK (sum), release drops the total to the
remaining one, re-reserving the same id REPLACES (does not accumulate), and an
invalid edge or a non-finite/negative size neither throws nor moves the totals.
"""

import shutil
import subprocess
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parent.parent
_HAS_NODE = shutil.which("node") is not None


@pytest.mark.skipif(not _HAS_NODE, reason="node binary not on PATH")
def test_edge_regions():
    result = subprocess.run(
        ["node", "--test", "tests/edge_regions.test.mjs"],
        cwd=_REPO,
        capture_output=True,
        timeout=30,
        text=True,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"node --test failed:\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
        )
