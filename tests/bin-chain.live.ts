/**
 * bin-chain.live.ts — LIVE twin of bin-chain.test.ts.
 *
 * Coverage doctrine (AGENTS.md §1.9): the 90% gate is the LIVE tests. This
 * file spawns the REAL bin chain end-to-end — no mocks, no KAIROS_DIR.
 *
 * The doc's own smoke (kairos-bin-contract.md): `kairos run echo ok` → ok,
 * exit 0. RED-first: this failed with exit 2 ("source not found at
 * .../ergasterion/products/kairos/src/cli.ts") before the shim default was
 * repointed to the flux line.
 */
import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const KAIROS = join(HOME, ".local/bin/kairos");

describe("kairos bin chain (live)", () => {
	test("kairos run echo ok → ok, exit 0, no env override", () => {
		const r = spawnSync(KAIROS, ["run", "echo", "ok"], {
			encoding: "utf8",
			timeout: 10_000,
			env: { ...process.env, KAIROS_DIR: "" }, // explicitly no override
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("ok");
	});

	test("kairos run --max-time/--deadline flags parse and run", () => {
		for (const args of [
			["run", "--max-time", "5", "echo", "ok"],
			["run", "--deadline", "10", "echo", "ok"],
		]) {
			const r = spawnSync(KAIROS, args, {
				encoding: "utf8",
				timeout: 10_000,
			});
			expect(r.status).toBe(0);
			expect(r.stdout).toContain("ok");
		}
	});
});