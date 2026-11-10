#!/usr/bin/env python3
"""
Autonomous Circuit Breaker & Rollback Manager
Enforces per-task time limits, manages git rollback checkpoints,
and prevents budget exhaustion on unsolvable benchmark issues.
"""
import os
import sys
import subprocess
import time
import json

class CircuitBreaker:
    def __init__(self, max_seconds=240, max_attempts=2):
        self.max_seconds = max_seconds
        self.max_attempts = max_attempts
        self.start_time = time.time()
        self.attempts = 0
        self.checkpoint_commit = None
        self._init_checkpoint()

    def _init_checkpoint(self):
        try:
            head = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
            self.checkpoint_commit = head
        except Exception:
            self.checkpoint_commit = "HEAD"

    def record_attempt(self, test_cmd=None):
        self.attempts += 1
        elapsed = time.time() - self.start_time
        
        if elapsed > self.max_seconds:
            print(f"[circuit_breaker] TIME LIMIT EXCEEDED ({elapsed:.1f}s > {self.max_seconds}s). Tripping breaker.")
            return False
            
        if self.attempts > self.max_attempts:
            print(f"[circuit_breaker] MAX ATTEMPTS EXCEEDED ({self.attempts} > {self.max_attempts}). Tripping breaker.")
            return False
            
        if test_cmd:
            res = subprocess.run(test_cmd, shell=True)
            return (res.returncode == 0)
            
        return True

    def rollback(self):
        print(f"[circuit_breaker] Executing rollback to {self.checkpoint_commit}...")
        subprocess.run(["git", "checkout", "--", "."], check=False)
        subprocess.run(["git", "clean", "-fd"], check=False)
        print("[circuit_breaker] Workspace restored to clean baseline state.")

if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else "status"
    cb = CircuitBreaker()
    if action == "rollback":
        cb.rollback()
    else:
        print(f"[circuit_breaker] Active. Elapsed: {time.time() - cb.start_time:.2f}s")
