"""Runs the Broker-tab suite of the cortex web widget under pytest.

Behavior lives in tests/broker_tab.test.mjs (node:test, DOM stubbed, no
network). This wrapper only exists so the JS suite runs in the normal pytest
job — same pattern as tests/test_esc_gesture_js.py.

Why the suite is worth its own wrapper: the tab renders the live state of a
HOST service that executes commands, and its two load-bearing invariants fail
SILENTLY rather than loudly. The broker token must never reach the HTML (the
helper does not emit it; this checks the tab does not paint it either), and the
tab must keep saying it is read-only and lock the `gui=lee` knobs — axon's
endpoint only ever calls `list`, so an editable-looking control would promise
something no route implements.
"""

import shutil
import subprocess
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parent.parent
_HAS_NODE = shutil.which("node") is not None


@pytest.mark.skipif(not _HAS_NODE, reason="node binary not on PATH")
def test_broker_tab_render():
    result = subprocess.run(
        ["node", "--test", "tests/broker_tab.test.mjs"],
        cwd=_REPO,
        capture_output=True,
        timeout=60,
        text=True,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"node --test failed:\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
        )
