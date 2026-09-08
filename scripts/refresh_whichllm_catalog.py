#!/usr/bin/env python3
"""Regenerate the HW Fit model catalog from whichllm, from a terminal.

Same code path as the "Update catalog" button in Cookbook → Scan/Download, so
what you get here is exactly what the UI would write. Useful to prepare a
machine that will later run offline, or to check the mapping without a browser.

    python3 scripts/refresh_whichllm_catalog.py            # regenerate + seal
    python3 scripts/refresh_whichllm_catalog.py --status   # just show the seal
    python3 scripts/refresh_whichllm_catalog.py --dry-run  # fetch, print, don't write
    python3 scripts/refresh_whichllm_catalog.py --top 200 --gpu "RTX 5090"

whichllm is optional (`pip install whichllm`, or have `uvx` on PATH). Without
it this exits non-zero with the install hint and touches nothing — the bundled
catalog keeps serving.
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.hwfit import whichllm_catalog  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--top", type=int, default=whichllm_catalog.DEFAULT_TOP,
                    help="how many ranked models to ask whichllm for")
    ap.add_argument("--gpu", default=whichllm_catalog.DEFAULT_SIM_GPU,
                    help="GPU to simulate; keep it roomy so the catalog stays hardware-independent")
    ap.add_argument("--profile", default="", help="whichllm ranking profile (general/coding/vision/math)")
    ap.add_argument("--timeout", type=int, default=whichllm_catalog.DEFAULT_TIMEOUT)
    ap.add_argument("--no-refresh", action="store_true",
                    help="let whichllm reuse its own HTTP caches instead of forcing a live fetch")
    ap.add_argument("--dry-run", action="store_true", help="fetch and summarize, write nothing")
    ap.add_argument("--status", action="store_true", help="print the current seal and exit")
    args = ap.parse_args()

    if args.status:
        print(json.dumps({
            "probe": whichllm_catalog.probe(),
            "catalog": whichllm_catalog.whichllm_catalog_meta(),
            "cache_path": str(whichllm_catalog.WHICHLLM_CACHE),
        }, indent=2, ensure_ascii=False))
        return 0

    info = whichllm_catalog.probe()
    if not info.get("available"):
        print(info.get("install_hint") or "whichllm is not installed", file=sys.stderr)
        return 2
    print(f"whichllm {info.get('version')} via {info.get('runner')}", file=sys.stderr)

    try:
        if args.dry_run:
            envelope = whichllm_catalog.fetch_catalog(
                top=args.top, gpu=args.gpu, profile=args.profile,
                refresh=not args.no_refresh, timeout=args.timeout,
            )
            models = envelope.pop("models", [])
            print(json.dumps(envelope, indent=2, ensure_ascii=False))
            for row in models[:10]:
                print(f"  {row['name']}  {row['parameter_count']}  {row['quantization']}  "
                      f"score={row['whichllm'].get('quality_score')}", file=sys.stderr)
            print(f"  … {len(models)} models (nothing written, --dry-run)", file=sys.stderr)
            return 0

        meta = whichllm_catalog.refresh_whichllm_catalog(
            top=args.top, gpu=args.gpu, profile=args.profile,
            refresh=not args.no_refresh, timeout=args.timeout,
        )
    except whichllm_catalog.WhichllmError as exc:
        print(f"whichllm refresh failed: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(meta, indent=2, ensure_ascii=False))
    print(f"written to {whichllm_catalog.WHICHLLM_CACHE}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
