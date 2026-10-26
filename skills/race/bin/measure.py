#!/usr/bin/env python3
"""hft-latency measurement helper: microsecond-precision timing, streaming-friendly.

Library:
    from measure import measure, now_us

    with measure("mirror-fetch", tag="docs"):
        fetch_docs()

    @measure("handler")
    def handle(msg): ...

Timing events are NDJSON on stderr (never stdout) so measured output stays
pipeable. Precision: time.perf_counter_ns -> microsecond reporting.

CLI (wraps any command; NDJSON events on stderr, the command's stdout untouched):
    bin/measure.py --tag fetch -- curl -s -m 10 https://example.com
    bin/measure.py -- curl -s https://example.com | head -c 100
"""
import json
import subprocess
import sys
import time
from contextlib import contextmanager
from functools import wraps


def now_us():
    """Current monotonic time in microseconds."""
    return time.perf_counter_ns() // 1000


def _emit(stream, obj):
    (stream or sys.stderr).write(json.dumps(obj) + "\n")
    (stream or sys.stderr).flush()


@contextmanager
def measure(name, tag=None, stream=None):
    """Context manager emitting start/end NDJSON timing events."""
    t0 = time.perf_counter_ns()
    _emit(stream, {"event": "start", "name": name, "tag": tag, "t_ns": t0})
    err = None
    try:
        yield
    except Exception as e:
        err = "%s: %s" % (type(e).__name__, e)
        raise
    finally:
        t1 = time.perf_counter_ns()
        _emit(stream, {"event": "end", "name": name, "tag": tag,
                       "elapsed_us": (t1 - t0) // 1000,
                       "elapsed_s": round((t1 - t0) / 1e9, 6),
                       "error": err})


def timed(name=None, tag=None, stream=None):
    """Decorator version of measure()."""
    def deco(fn):
        label = name or fn.__name__

        @wraps(fn)
        def wrapper(*a, **k):
            with measure(label, tag=tag, stream=stream):
                return fn(*a, **k)
        return wrapper
    return deco


def main():
    args = sys.argv[1:]
    tag = None
    if args[:2] == ["--tag", args[1] if len(args) > 1 else ""]:
        tag = args[1]
        args = args[2:]
    if args and args[0] == "--":
        args = args[1:]
    if not args:
        sys.stderr.write("usage: measure.py [--tag NAME] -- <command...>\n")
        sys.exit(2)
    name = " ".join(args[:3]) + ("..." if len(args) > 3 else "")
    with measure(name, tag=tag):
        proc = subprocess.run(args)
    sys.exit(proc.returncode)


if __name__ == "__main__":
    main()