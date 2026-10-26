/**
 * MCTS over patch candidates — select by UTC, expand, backpropagate.
 *
 * Ported from emergent-mcts-graph/scripts/mcts_engine.py (76 lines):
 *   MCTSNode(state_id, parent, action, visits, reward)
 *   SWE_MCTS(max_depth, timeout_seconds) with select/expand/backpropagate/get_best_patch
 *
 * The timeout is checked at every step: an unbounded search on a slow box is
 * just a hang with extra steps.
 */

import { emit } from "./concurrent";

export type PatchAction = {
  actionId: string;
  patch: string;
  /** Prior belief, in [0,1]. Unknown candidates start flat. */
  prior?: number;
};

export class MCTSNode {
  visits = 0;
  reward = 0;
  readonly children: MCTSNode[] = [];

  constructor(
    readonly stateId: string,
    readonly parent: MCTSNode | null,
    readonly action: PatchAction | null,
  ) {}

  get value(): number {
    return this.visits ? this.reward / this.visits : 0;
  }

  /** UCT. Unvisited children must score high or they never get tried. */
  utcScore(explorationConstant: number, parentVisits: number): number {
    if (this.visits === 0) return Number.POSITIVE_INFINITY;
    const exploit = this.value;
    const explore = explorationConstant * Math.sqrt(Math.log(Math.max(1, parentVisits)) / this.visits);
    return exploit + explore;
  }
}

export type SearchResult = {
  bestPatch: string | null;
  bestStateId: string | null;
  iterations: number;
  nodesExplored: number;
  timedOut: boolean;
  elapsedS: number;
};

export class SWEMcts {
  private readonly root: MCTSNode;
  private startedAt = 0;

  constructor(
    private readonly maxDepth = 4,
    private readonly timeoutSeconds = 60,
    private readonly explorationConstant = Math.SQRT2,
  ) {
    if (maxDepth < 1) throw new Error("maxDepth must be >= 1");
    this.root = new MCTSNode("root", null, null);
  }

  private get timedOut(): boolean {
    return (performance.now() - this.startedAt) / 1000 > this.timeoutSeconds;
  }

  /** Walk down by UCT until a terminal node or a leaf is reached. */
  select(node: MCTSNode): MCTSNode {
    let current = node;
    while (current.children.length > 0) {
      current = current.children.reduce((best, child) =>
        child.utcScore(this.explorationConstant, current.visits) > best.utcScore(this.explorationConstant, current.visits) ? child : best,
      );
    }
    return current;
  }

  /** Expand a leaf. Candidates without a prior are placed flat, not sorted. */
  expand(node: MCTSNode, candidateActions: readonly PatchAction[]): MCTSNode[] {
    const made = candidateActions.map((action) => new MCTSNode(action.actionId, node, action));
    node.children.push(...made);
    if (made.length) emit({ event: "mcts_expand", state_id: node.stateId, children: made.length });
    return made;
  }

  /** Credit a rollout result all the way to the root. */
  backpropagate(node: MCTSNode | null, reward: number): void {
    for (let n = node; n !== null; n = n.parent) {
      n.visits += 1;
      n.reward += reward;
    }
  }

  /** Best visited child of the root, by value then visits. Unvisited wins on a tie. */
  getBestPatch(): { patch: string | null; stateId: string | null } {
    if (!this.root.children.length) return { patch: null, stateId: null };
    const best = this.root.children.reduce((a, b) => (b.value > a.value || (b.value === a.value && b.visits > a.visits) ? b : a));
    return { patch: best.action?.patch ?? null, stateId: best.stateId };
  }

  /**
   * Search. `rollout` receives an expanded node and returns a reward in [0,1];
   * a throw counts as 0 so a failing patch is never mistaken for a good one.
   */
  async search(
    candidatesByState: (stateId: string) => Promise<readonly PatchAction[]>,
    rollout: (node: MCTSNode) => Promise<number>,
  ): Promise<SearchResult> {
    const t0 = performance.now();
    this.startedAt = t0;
    let iterations = 0;
    let current = this.root;
    let timedOut = false;

    while (iterations < 10_000 && !this.timedOut) {
      iterations += 1;
      current = this.select(this.root);
      const depth = this.depthOf(current);
      if (depth >= this.maxDepth || current.children.length === 0) {
        const candidates = await candidatesByState(current.stateId);
        if (!candidates.length) {
          this.backpropagate(current, 0);
          continue;
        }
        const fresh = this.expand(current, candidates);
        if (fresh.length) current = fresh[0]!;
      }
      let reward = 0;
      try {
        reward = await rollout(current);
      } catch (e) {
        emit({ event: "mcts_rollout_failed", state_id: current.stateId, error: (e as Error).message });
        reward = 0;
      }
      this.backpropagate(current, reward);
    }
    if (this.timedOut) timedOut = true;

    const { patch, stateId } = this.getBestPatch();
    const result: SearchResult = {
      bestPatch: patch,
      bestStateId: stateId,
      iterations,
      nodesExplored: this.count(this.root),
      timedOut,
      elapsedS: (performance.now() - t0) / 1000,
    };
    emit({ event: "mcts_done", ...result, best_patch: patch ? `${patch.slice(0, 120)}` : null });
    return result;
  }

  private depthOf(node: MCTSNode): number {
    let d = 0;
    for (let n: MCTSNode | null = node; n?.parent; n = n.parent) d += 1;
    return d;
  }

  private count(node: MCTSNode): number {
    return 1 + node.children.reduce((sum, c) => sum + this.count(c), 0);
  }
}