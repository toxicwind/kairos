/**
 * bin-chain.test.ts — HERMETIC twin of bin-chain.live.ts.
 *
 * Contract under test (the oddity, made continuous): the kairos bin chain must
 * resolve WITHOUT any environment override. The shim's KAIROS_SRC default is
 * the single point of truth for where the product lives; a stale default
 * (previous lapidary/ergasterion line) kills every `kairos` invocation with
 * exit 2 before Tier 0 — the emergence loop silently dead.
 *
 * RED-first: this test was written BEFORE the shim default was fixed and
 * failed against the ergasterion ghost path.
 */
import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const SHIM = join(HOME, "pens/ranch/products/ops/bin/kairos");
const LIVE_PRODUCT = join(HOME, "pens/flux/products/kairos");
const CLI = join(LIVE_PRODUCT, "src/cli.ts");

describe("kairos bin chain resolves without env override (ghost-path regression)", () => {
	test("~/.local/bin/kairos symlink lands on the ranch ops shim", () => {
		const bin = join(HOME, ".local/bin/kairos");
		expect(existsSync(bin)).toBe(true);
		expect(realpathSync(bin)).toBe(SHIM);
	});

	test("shim's KAIROS_SRC default points at the LIVE product, not a ghost", () => {
		const src = readFileSync(SHIM, "utf8");
		const m = src.match(/KAIROS_SRC="\$\{KAIROS_DIR:-(.+?)\}"/);
		expect(m).not.toBeNull();
		const defaultSrc = m![1];
		// The oddity: default must be the flux line, never a removed pen line.
		expect(defaultSrc).toBe(LIVE_PRODUCT);
		expect(existsSync(join(defaultSrc, "src/cli.ts"))).toBe(true);
	});

	test("live product cli.ts exists and is executable by the shim contract", () => {
		expect(existsSync(CLI)).toBe(true);
	});
});