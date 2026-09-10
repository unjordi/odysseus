"""Runs the rail-projection suite under pytest.

Behavior lives in tests/rail_projection.test.mjs (node:test, no DOM). This wrapper
only exists so the JS suite runs in the normal pytest job — same pattern as
tests/test_edge_regions_js.py.

The suite pins the pure projection of the workspace state onto the rail: an open
non-minimized module projects active:true, an open minimized one projects
active:false, a closed or absent module projects everything false with
instanceCount 0, the output order matches the input order, and an invalid input
(railItems not an array, a railItem missing railId/moduleId, moduleStates not an
object) neither throws nor fabricates a view.
"""

import shutil
import subprocess
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parent.parent
_HAS_NODE = shutil.which("node") is not None


@pytest.mark.skipif(not _HAS_NODE, reason="node binary not on PATH")
def test_rail_projection():
    result = subprocess.run(
        ["node", "--test", "tests/rail_projection.test.mjs"],
        cwd=_REPO,
        capture_output=True,
        timeout=30,
        text=True,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"node --test failed:\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
        )
