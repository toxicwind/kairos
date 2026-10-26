#!/usr/bin/env python3
"""hft-latency racer: run redundant strategies concurrently, first VALID wins.

HFT doctrine: latency is correctness. The race returns the MOMENT the first
valid result arrives — losers are SIGKILLed as a process GROUP immediately,
never awaited. A slow correct answer that arrives after a fast one is wrong.

Event-driven design — zero sleeps, zero polling:
  - asyncio subprocesses: the event loop wakes on pipe readability and
    SIGCHLD. Nothing ever spins waiting.
  - Every contestant gets background drain tasks doing continuous bounded
    reads on its stdout AND stderr pipes. A verbose contestant can NEVER
    fill a pipe and wedge itself (the classic Popen-then-read-after-exit
    deadlock).
  - Per-attempt fail-fast ceiling via wait_for; overall race ceiling too.
  - Loser kill path: task cancellation -> finally -> killpg(SIGKILL) ->
    shielded reap. No orphans, no lingering losers.
  - Loser telemetry is captured by the drain tasks that were already
    running — bounded and free, never awaited on the hot path.
  - Contestant stderr is captured (bounded) and any NDJSON {"event": ...}
    lines are re-emitted on our stderr — per-candidate telemetry
    (solve/test latencies, pass counts) flows through to the winners ledger.

Import surface (borrow, don't fork — code-racer D1):
  from race import run_one_sync, log_winners, load_strategies
  run_one_sync(strategy, timeout) runs a single contestant synchronously.
  The async primitives run_one() / run_race() are importable too.

Usage:
    bin/race.py --strategies strategies.json --tag fetch-docs [--timeout 10] [--race-timeout 30]
    bin/race.py --strategies strategies.json --tag fetch-docs --lead-with-winner
    bin/race.py --strategies strategies.json --tag fetch-docs --hedge-ms 300
        # hedged: best-known strategy fires at t=0, backups fire only if no
        # valid result arrives within 300ms (Dean & Barroso hedged requests)
"""
import argparse
import asyncio
import json
import os
import re
import signal
import statistics
import sys
import time

WINNERS_LOG = os.path.expanduser("~/.cache/shingle/hft_race_winners.jsonl")
OUTPUT_CAP = 256 * 1024
DRAIN_CHUNK = 65536


def emit(obj):
    sys.stderr.write(json.dumps(obj) + "\n")
    sys.stderr.flush()


async def drain_capped(stream, cap):
    """Continuously drain a pipe into a bounded buffer, discarding the rest.

    Runs as a background task per contestant. The event loop wakes this only
    when data is actually readable — no polling — and because the pipe is
    always being drained, the contestant can never block on a full pipe.
    Returns (text, truncated).
    """
    chunks = []
    total = 0
    truncated = False
    try:
        while True:
            chunk = await stream.read(DRAIN_CHUNK)
            if not chunk:
                break
            if total < cap:
                take = min(len(chunk), cap - total)
                chunks.append(chunk[:take])
                total += take
                if len(chunk) > take:
                    truncated = True
                # keep reading to EOF and discard: pipe stays drained
            else:
                truncated = True
    except (asyncio.CancelledError, OSError, ValueError):
        pass
    return b"".join(chunks).decode("utf-8", "replace"), truncated


async def run_one(strategy, timeout):
    """Run one contestant. Returns a result dict, never raises.

    On cancellation (loser) or timeout: SIGKILL the whole process group,
    reap under a shield so the kill always completes.
    """
    name = strategy["name"]
    cmd = strategy["cmd"]
    match = strategy.get("match")
    env = dict(os.environ)
    env.update(strategy.get("env") or {})
    t0 = time.perf_counter_ns()
    proc = None
    drain_out = None
    drain_err = None
    output, truncated = "", False
    err_text = ""
    try:
        # start_new_session: new process GROUP so killpg takes the whole tree.
        proc = await asyncio.create_subprocess_exec(
            cmd[0], *cmd[1:],
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env, start_new_session=True)
        # Drain from the first instant: the loop wakes on readability.
        drain_out = asyncio.ensure_future(drain_capped(proc.stdout, OUTPUT_CAP))
        drain_err = asyncio.ensure_future(drain_capped(proc.stderr, OUTPUT_CAP))
        try:
            await asyncio.wait_for(proc.wait(), timeout)
        except asyncio.TimeoutError:
            return {"name": name, "ok": False, "valid": False, "rc": None,
                    "error": "timeout>%ss" % timeout, "output": "",
                    "output_truncated": False, "stderr_tail": "",
                    "latency_s": round((time.perf_counter_ns() - t0) / 1e9, 6)}
        rc = proc.returncode
        # Process exited: EOF is guaranteed, collect what the drains got.
        try:
            output, truncated = await asyncio.wait_for(
                asyncio.shield(drain_out), timeout=2)
        except asyncio.TimeoutError:
            pass
        try:
            err_text, _ = await asyncio.wait_for(
                asyncio.shield(drain_err), timeout=2)
        except asyncio.TimeoutError:
            pass
        valid = rc == 0 and (match is None or re.search(match, output) is not None)
        return {"name": name, "ok": True, "valid": valid, "rc": rc,
                "error": None, "output": output if valid else "",
                "output_truncated": truncated if valid else False,
                "stderr_tail": err_text[-2000:],
                "latency_s": round((time.perf_counter_ns() - t0) / 1e9, 6)}
    except FileNotFoundError:
        return {"name": name, "ok": False, "valid": False, "rc": None,
                "error": "command-not-found: %s" % cmd[0], "output": "",
                "output_truncated": False, "stderr_tail": "",
                "latency_s": round((time.perf_counter_ns() - t0) / 1e9, 6)}
    except asyncio.CancelledError:
        # Loser: killed because someone else won. Report it, don't fight it.
        raise
    except Exception as e:
        return {"name": name, "ok": False, "valid": False, "rc": None,
                "error": "%s: %s" % (type(e).__name__, e), "output": "",
                "output_truncated": False, "stderr_tail": "",
                "latency_s": round((time.perf_counter_ns() - t0) / 1e9, 6)}
    finally:
        # Kill the process GROUP: no orphans, no lingering losers or children.
        if proc is not None and proc.returncode is None:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                pass
        for dt in (drain_out, drain_err):
            if dt is not None and not dt.done():
                dt.cancel()
        # Reap under a shield so cancellation can't interrupt the kill.
        if proc is not None and proc.returncode is None:
            try:
                await asyncio.wait_for(asyncio.shield(proc.wait()), timeout=2)
            except (asyncio.TimeoutError, Exception):
                pass


async def run_race(strategies, race_id, tag, timeout, race_timeout,
                 hedge_ms=0):
    """Race coroutines, first VALID wins. Returns (winner, winner_output,
    truncated, results). Never leaves a task or process behind.

    hedge_ms=0 (default): all contestants launch at t=0 — today's behavior.
    hedge_ms>0: hedged requests (Dean & Barroso lineage). The best-known
    strategy (winners-log ranking, config order on ties) launches alone at
    t=0; the remaining backups launch only if no valid result arrived by
    t=hedge_ms. A fast primary means the backups never run at all; a slow
    primary gets tail-bounded by the backups. The hedge deadline is the
    feature's trigger event, not a poll — everything else stays
    wake-on-completion.
    """
    loop = asyncio.get_running_loop()
    t_start = loop.time()
    deadline = t_start + race_timeout
    if hedge_ms > 0 and len(strategies) > 1:
        ordered = _hedge_order(tag, strategies)
        hedged = True
    else:
        ordered = list(strategies)
        hedged = False
    tasks = {}            # contestant task -> strategy name
    pending = set()
    results = {}
    winner = None
    winner_output = ""
    winner_truncated = False
    hedge_task = None
    rest = []

    def launch(s):
        t = asyncio.ensure_future(run_one(s, timeout))
        tasks[t] = s["name"]
        pending.add(t)
        emit({"event": "attempt_start", "race_id": race_id, "name": s["name"],
              "t_launch_s": round(loop.time() - t_start, 6)})

    async def hedge_deadline():
        # The hedge trigger: a single deadline, not a polling loop.
        await asyncio.sleep(hedge_ms / 1000)
        return "hedge"

    emit({"event": "race_start", "race_id": race_id, "tag": tag,
          "contestants": [s["name"] for s in ordered],
          "launch_order": [s["name"] for s in ordered] if hedged else None,
          "hedge_ms": hedge_ms,
          "timeout_s": timeout, "race_timeout_s": race_timeout})
    try:
        if hedged:
            launch(ordered[0])
            rest = ordered[1:]
            hedge_task = asyncio.ensure_future(hedge_deadline())
            pending.add(hedge_task)
            emit({"event": "hedge_armed", "race_id": race_id,
                  "hedge_ms": hedge_ms, "primary": ordered[0]["name"],
                  "backups": [s["name"] for s in rest]})
        else:
            for s in ordered:
                launch(s)
        while pending:
            remaining = deadline - loop.time()
            if remaining <= 0:
                break
            # wait() wakes on task completion — event-driven, no polling.
            done, pending = await asyncio.wait_for(
                asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED),
                timeout=remaining)
            for task in done:
                if task is hedge_task:
                    # Hedge deadline hit with no valid result: fire backups.
                    hedge_task = None
                    if winner is None and rest:
                        emit({"event": "hedge_fired", "race_id": race_id,
                              "t_s": round(loop.time() - t_start, 6),
                              "backups": [s["name"] for s in rest]})
                        for s in rest:
                            launch(s)
                        rest = []
                    continue
                try:
                    r = task.result()
                except asyncio.CancelledError:
                    continue
                except Exception as e:
                    r = {"name": tasks[task], "ok": False, "valid": False,
                         "rc": None, "error": "task: %s" % e, "output": "",
                         "output_truncated": False, "stderr_tail": "",
                         "latency_s": 0}
                results[r["name"]] = r
                emit({"event": "attempt_done", "race_id": race_id,
                      "name": r["name"], "ok": r["ok"], "valid": r["valid"],
                      "latency_s": r["latency_s"], "error": r["error"]})
                # Passthrough: re-emit any NDJSON {"event": ...} lines the
                # contestant printed on its own stderr (e.g. code-racer's
                # candidate_result telemetry) so they flow to the ledger.
                for line in r.get("stderr_tail", "").splitlines():
                    line = line.strip()
                    if line.startswith("{") and '"event"' in line:
                        try:
                            emit(json.loads(line))
                        except ValueError:
                            pass
                if r["valid"] and winner is None:
                    # FIRST VALID WINS: cancel losers NOW, return immediately.
                    winner = r["name"]
                    winner_output = r["output"]
                    winner_truncated = r["output_truncated"]
                    break
            if winner is not None:
                break
    except asyncio.TimeoutError:
        pass  # overall ceiling hit: race ends, whatever we have stands
    finally:
        if hedge_task is not None:
            # Primary won before the deadline: backups never launched.
            hedge_task.cancel()
            if winner is not None:
                emit({"event": "hedge_standdown", "race_id": race_id,
                      "winner": winner,
                      "t_s": round(loop.time() - t_start, 6)})
            try:
                await asyncio.wait_for(asyncio.shield(hedge_task), timeout=2)
            except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
                pass
        # Cancel every loser; each one's finally does killpg + shielded reap.
        # Not awaited one-by-one on the hot path — gather runs them together.
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
    return winner, winner_output, winner_truncated, results


def load_strategies(path):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    strats = data.get("strategies", data) if isinstance(data, dict) else data
    for s in strats:
        if "name" not in s or "cmd" not in s:
            raise ValueError("each strategy needs name + cmd: %r" % (s,))
    return strats


def log_winners(tag, winner, latency):
    try:
        os.makedirs(os.path.dirname(WINNERS_LOG), exist_ok=True)
        with open(WINNERS_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps({"ts": time.time(), "tag": tag,
                                "winner": winner, "latency": latency}) + "\n")
    except OSError:
        pass


def _read_winners(tag):
    """Read the winners JSONL ledger for one tag. Returns
    (win_counts, {name: [latency_s, ...]}). Shared by --lead-with-winner
    reporting and --hedge-ms launch ordering."""
    wins, lats = {}, {}
    try:
        with open(WINNERS_LOG, encoding="utf-8") as f:
            for line in f:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if e.get("tag") != tag:
                    continue
                w = e.get("winner")
                if w:
                    wins[w] = wins.get(w, 0) + 1
                for n, r in (e.get("latency") or {}).items():
                    lats.setdefault(n, []).append(r.get("latency_s", 1e9))
    except FileNotFoundError:
        pass
    return wins, lats


def _hedge_order(tag, strategies):
    """Best-known-first ordering for hedged launch: most wins, then lowest
    median latency. Stable sort keeps config order among ties and unknowns."""
    wins, lats = _read_winners(tag)

    def key(s):
        n = s["name"]
        return (-wins.get(n, 0), statistics.median(lats.get(n, [1e9])))

    return sorted(strategies, key=key)


def lead_with_winner(tag, strategies_path):
    wins, lats = _read_winners(tag)
    names = [s["name"] for s in load_strategies(strategies_path)]
    ranked = sorted(names, key=lambda n: (-wins.get(n, 0),
                                          statistics.median(lats.get(n, [1e9]))))
    return {"tag": tag, "win_counts": wins,
            "ranked": [{"name": n, "wins": wins.get(n, 0),
                        "median_latency_s": round(statistics.median(lats.get(n, [1e9])), 6)}
                       for n in ranked]}


def run_one_sync(strategy, timeout):
    """Synchronous wrapper around run_one for importers (borrow, don't fork).

    Usage: from race import run_one_sync, log_winners, load_strategies
    """
    return asyncio.run(run_one(strategy, timeout))


async def amain(args):
    if args.lead_with_winner:
        print(json.dumps(lead_with_winner(args.tag, args.strategies), indent=1))
        return

    strategies = load_strategies(args.strategies)
    race_id = "%s-%d" % (args.tag, int(time.time() * 1000))
    race_t0 = time.perf_counter_ns()

    winner, winner_output, truncated, results = await run_race(
        strategies, race_id, args.tag, args.timeout, args.race_timeout,
        hedge_ms=args.hedge_ms)

    race_latency = round((time.perf_counter_ns() - race_t0) / 1e9, 6)
    latency = {n: {"ok": r["ok"], "valid": r["valid"],
                   "latency_s": r["latency_s"], "error": r["error"]}
               for n, r in results.items()}

    log_winners(args.tag, winner, latency)
    emit({"event": "race_end", "race_id": race_id, "winner": winner,
          "race_latency_s": race_latency})

    print(json.dumps({"race_id": race_id, "tag": args.tag, "winner": winner,
                      "hedge_ms": args.hedge_ms,
                      "race_latency_s": race_latency,
                      "strategy_latency": latency,
                      "output": winner_output[:OUTPUT_CAP],
                      "output_truncated": truncated}, indent=1))


def main():
    ap = argparse.ArgumentParser(description="Race shell strategies, first valid wins.")
    ap.add_argument("--strategies", required=True)
    ap.add_argument("--tag", default="default")
    ap.add_argument("--timeout", type=float, default=10,
                    help="Per-attempt fail-fast seconds (default 10)")
    ap.add_argument("--race-timeout", type=float, default=30,
                    help="Overall race ceiling seconds (default 30)")
    ap.add_argument("--workers", type=int, default=8,
                    help="Accepted for CLI compat; asyncio needs no worker pool")
    ap.add_argument("--lead-with-winner", action="store_true")
    ap.add_argument("--hedge-ms", type=float, default=0,
                    help="Hedged launch: fire the best-known strategy at t=0, "
                         "fire backups only if no valid result by this many "
                         "milliseconds (default 0 = all launch at t=0)")
    args = ap.parse_args()
    asyncio.run(amain(args))


if __name__ == "__main__":
    main()