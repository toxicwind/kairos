// kairos — public surface for host adapters (kappa/kilo plugin, tau/omp
// extension, generic hook CLIs). One verdict function, one contract.
export {
  guard,
  verdict,
  redirectTargetMissing,
  hugeTreeScan,
  type KairosVerdict,
} from "./guard.ts";
export { isSlow, SLOW_ROUTES, DEADLINE_BUMPS } from "./policy.ts";
