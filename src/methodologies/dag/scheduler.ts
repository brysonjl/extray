// The DAG scheduler. Runs nodes in topological order; nodes whose dependencies
// are all satisfied run concurrently as one "level". A node whose gate returns
// false is recorded `skipped` (with its reason) and never invoked; a node that
// throws is recorded `error` rather than crashing the run, so the collector can
// surface "what was not evaluated" in coverage. Same node set + same pack ⇒ same
// invocations, which is the DAG's repeatability property (docs/analysis-dag.md).
//
// Concurrency here is per-level (a handful of nodes); a node's own internal
// fan-out (e.g. the verifier's bounded per-claim calls) caps itself.

import { errorResult, skippedResult, type DagNode, type NodeContext, type NodeOutputs } from "./node.ts";

export type SchedulerContext = Omit<NodeContext, "upstream"> & { onProgress?: import("../types.ts").MethodologyProgress };

export async function runDag(nodes: DagNode[], ctx: SchedulerContext): Promise<NodeOutputs> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const outputs: NodeOutputs = new Map();
  const done = new Set<string>();
  const remaining = new Set(nodes.map((n) => n.id));

  while (remaining.size > 0) {
    // A node is ready when every declared upstream is done. Upstream ids not in
    // this node set are treated as satisfied (the node's gate handles absence).
    const ready = [...remaining].filter((id) =>
      byId.get(id)!.upstream.every((u) => done.has(u) || !byId.has(u)),
    );
    if (ready.length === 0) {
      throw new Error(`DAG has a cycle or unresolved dependency among: ${[...remaining].join(", ")}`);
    }

    await Promise.all(
      ready.map(async (id) => {
        const node = byId.get(id)!;
        // Same map object for every same-level node: they share no edges, so the
        // live mutation below cannot expose a half-finished sibling to a sibling.
        const nodeCtx: NodeContext = { ...ctx, upstream: outputs };
        if (!node.gate(nodeCtx)) {
          outputs.set(id, skippedResult("gate not met"));
          await ctx.onProgress?.(`dag:${id}`, "skipped", `DAG node ${id} skipped: gate not met`);
          return;
        }
        try {
          await ctx.onProgress?.(`dag:${id}`, "started", `DAG node ${id} started`);
          const result = await node.run(nodeCtx);
          outputs.set(id, result);
          await ctx.onProgress?.(`dag:${id}`, result.status === "error" ? "failed" : "finished", `DAG node ${id} returned ${result.status}`);
        } catch (e) {
          outputs.set(id, errorResult(e instanceof Error ? e.message : String(e)));
          await ctx.onProgress?.(`dag:${id}`, "failed", `DAG node ${id} failed`);
        }
      }),
    );
    for (const id of ready) {
      remaining.delete(id);
      done.add(id);
    }
  }

  return outputs;
}
