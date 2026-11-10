#!/usr/bin/env python3
"""
Universal Code Racer Engine for Autonomous SWE Agents
Enforces empirical route selection and candidate patch benchmarking.
"""
import time
import gc
import statistics
import sys
from typing import Dict, Callable, Any, List

class CodeRacer:
    """
    Universal High-Precision Code Racing & Benchmarking Engine.
    Executes multiple route implementations across warmup and test trials.
    """
    def __init__(self, warmup_runs: int = 5, test_runs: int = 30):
        self.warmup_runs = warmup_runs
        self.test_runs = test_runs

    def race(self, candidates: Dict[str, Callable[[], Any]]) -> List[Dict[str, Any]]:
        results = []
        for name, func in candidates.items():
            # Warm-up phase
            for _ in range(self.warmup_runs):
                func()
            
            # Measurement phase
            timings_ns = []
            gc.disable()
            try:
                for _ in range(self.test_runs):
                    t0 = time.perf_counter_ns()
                    res = func()
                    t1 = time.perf_counter_ns()
                    timings_ns.append(t1 - t0)
            finally:
                gc.enable()
                gc.collect()
            
            timings_ms = [t / 1_000_000.0 for t in timings_ns]
            min_ms = min(timings_ms)
            mean_ms = statistics.mean(timings_ms)
            median_ms = statistics.median(timings_ms)
            stdev_ms = statistics.stdev(timings_ms) if len(timings_ms) > 1 else 0.0
            
            results.append({
                "name": name,
                "min_ms": min_ms,
                "mean_ms": mean_ms,
                "median_ms": median_ms,
                "stdev_ms": stdev_ms,
                "runs": len(timings_ms),
                "output_type": type(res).__name__,
                "passed": bool(res)
            })
            
        # Sort by median execution time ascending (fastest first)
        results.sort(key=lambda x: x["median_ms"])
        
        fastest_time = results[0]["median_ms"]
        slowest_time = results[-1]["median_ms"]
        for rank, item in enumerate(results, 1):
            item["rank"] = rank
            item["relative_to_fastest"] = item["median_ms"] / fastest_time if fastest_time > 0 else 1.0
            item["speedup_vs_baseline"] = slowest_time / item["median_ms"] if item["median_ms"] > 0 else float('inf')

        return results

    def print_leaderboard(self, results: List[Dict[str, Any]]) -> str:
        header = f"{'Rank':<5} | {'Candidate Route':<35} | {'Median (ms)':<12} | {'Min (ms)':<10} | {'Speedup':<10}"
        separator = "-" * len(header)
        lines = [header, separator]
        for r in results:
            lines.append(f"{r['rank']:<5} | {r['name']:<35} | {r['median_ms']:10.4f} ms | {r['min_ms']:8.4f} ms | {r['speedup_vs_baseline']:8.2f}x")
        return "\n".join(lines)

if __name__ == "__main__":
    print("[code_racer] CodeRacer module initialized.")
