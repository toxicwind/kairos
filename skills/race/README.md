# race {badges}

<!-- badges: start -->
<a href="https://github.com/toxicwind/estate">
  <img src="https://img.shields.io/badge/github-toxicwind/sovereign--projects-181717?style=for-the-badge&logo=github&logoColor=white" alt="GitHub repo">
</a>
<!-- badges: end -->

## Chris's latency-first engineering doctrine (NOT trading): latency is a correctness criterion.

**What**: Race redundant approaches concurrently with fail-fast timeouts, first valid wins. Measure everything, keep the fast path hot; maximal = wider not harder; never roll back; borrow before inventing.

**Why**: Latency is a correctness criterion, not a metric. A slow correct answer that arrives after a fast correct one is the *wrong* answer for the race. Optimize for arrival time, not just truth.

**Who**: Reusable racer (bin/race.py) + latency measurement helper (bin/measure.py). LIVING DOCUMENT — any agent may mutate it live.

## Feature bullets

- **Race, don't queue**: Fire redundant, *distinct* approaches concurrently; first **valid** result wins. Never a sequential retry loop.
- **Fail fast per attempt**: Every attempt gets a short ceiling (seconds, not minutes). Slow is a kind of wrong: kill the loser, record its latency, never await it.
- **Measure everything**: Every attempt is timed at microsecond precision and the timings are reported first-class, never buried.
- **Keep the fast path hot**: Winners are logged (JSONL); the next run *leads* with the proven winner instead of rediscovering it.
- **Maximal = wider, not harder**: When stuck, don't try harder — try *wider*: more contestants, different angles, same race. One more distinct approach in flight beats three retries of a blocked one.
- **Never roll back — iterate forward**: A losing attempt is abandoned, never undone. Fix forward: patch the winner, add a new contestant, move on.
- **Borrow before inventing**: Someone has solved this shape before (GitHub, the fleet's own winners log, a neighboring skill). Steal the proven shape, race it against yours.
- **Prefer streaming tools over batch ones**: First bytes beat complete bytes.

## Quick start

```bash
# Race strategies from a strategies.json config
bin/race.py --strategies strategies.json --tag fetch-docs --timeout 10 --workers 8

# Rank strategies by proven winners
bin/race.py --strategies strategies.json --tag fetch-docs --lead-with-winner

# Hedged launch: best-known fires at t=0, backups fire only if no valid result in 300ms
bin/race.py --strategies strategies.json --tag fetch-docs --hedge-ms 300
```

## Config / optional services

- **bin/race.py**: Runs N shell strategies concurrently with per-attempt timeouts; first valid wins; logs every attempt's latency
- **bin/measure.py**: Microsecond-precision timing, library + CLI, streaming-friendly
- **Winners log**: Every attempt appends to `~/.cache/shingle/hft_race_winners.jsonl`: `{ts, tag, winner, strategy_latency}`
- **Hedge mode**: `--hedge-ms N` — best-known strategy fires alone at t=0; backups fire only if no valid result arrives within N ms

## Dev / contributing

- Race-first-wins + per-strategy latency + JSONL winners loop: borrowed from `code-race` (`bin/race.py`)
- Mirror racing: `annas-router` (race mirrors, fastest good mirror wins)
- Transport racing: squawk-feed `race-borrow` (race long-poll vs websocket, cross-transport dedup, per-transport win log)
- Anti-patterns: Sequential retry loops with backoff against a dead endpoint; `time.sleep` as a synchronization primitive between agents; re-running discovery every time instead of consulting the winners log; treating "it eventually worked" as success — eventual is slow, slow is wrong; one strategy at a time because "it's cleaner." Clean loses to fast.
- This is a LIVING DOCUMENT — any agent may mutate it live as it learns

## License + security

- **License**: Open Claw source (see `skill.toml`)
- **Security**: Latency is a correctness criterion — optimize for arrival time, not just truth. Never roll back — iterate forward. Patch forward, push forward, correct in the open.