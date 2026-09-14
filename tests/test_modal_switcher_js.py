"""Runs the modal-switcher suite under pytest.

Behavior lives in tests/modal_switcher.test.mjs (node:test, no DOM). This wrapper
only exists so the JS suite runs in the normal pytest job — same pattern as
tests/test_rail_projection_js.py.

The suite pins the pure core of the phone-mode modal switcher (#29f): the open
list keeps its input order, labels resolve module→id when missing, `active` marks
only the active id, several instances of the same module type list separately
(#29a), next/prev navigate with wrap in both directions, an absent currentId
starts at the right end, and invalid input neither throws nor fabricates rows.
"""

import shutil
import subprocess
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parent.parent
_HAS_NODE = shutil.which("node") is not None


@pytest.mark.skipif(not _HAS_NODE, reason="node binary not on PATH")
def test_modal_switcher():
    result = subprocess.run(
        ["node", "--test", "tests/modal_switcher.test.mjs"],
        cwd=_REPO,
        capture_output=True,
        timeout=30,
        text=True,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"node --test failed:\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
        )
