"""Runs the Escape tap-vs-hold arbiter suite under pytest.

Behavior lives in tests/esc_gesture.test.mjs (node:test, no DOM, injected
clock). This wrapper only exists so the JS suite runs in the normal pytest job
— same pattern as tests/test_esc_menu_stack_js.py.

Why the suite is worth its own wrapper: the two invariants that decide whether
the feature works at all cannot be asserted through the DOM with a real clock
without slow, flaky tests — that keyboard auto-repeat does NOT restart the hold
timer (otherwise a held Escape never completes, silently), and that a hold does
not ALSO fire a tap on release (otherwise it closes two things, which is worse
than the instant Escape this replaces).
"""

import shutil
import subprocess
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parent.parent
_HAS_NODE = shutil.which("node") is not None


@pytest.mark.skipif(not _HAS_NODE, reason="node binary not on PATH")
def test_esc_gesture_tap_vs_hold():
    result = subprocess.run(
        ["node", "--test", "tests/esc_gesture.test.mjs"],
        cwd=_REPO,
        capture_output=True,
        timeout=30,
        text=True,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"node --test failed:\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
        )
