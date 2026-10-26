// 5 MB size cap. When the serialized pack exceeds the cap, truncate the noisiest
// NON-essential arrays (cross-file destination summary, per-file anomalies) and
// record the truncation in summary_signals. scripts[] entries are never
// truncated, so the incremental-rebuild guarantee stays well-defined.

import type { EvidencePack } from "./schema.ts";

export const FIVE_MB = 5 * 1024 * 1024;

function size(pack: EvidencePack): number {
  return Buffer.byteLength(JSON.stringify(pack));
}

export function enforceSizeCap(pack: EvidencePack, maxBytes = FIVE_MB): void {
  if (size(pack) <= maxBytes) return;
  const truncations: Array<{ array: string; removed: number }> = [];

  // 1) destination summary (often the noisiest).
  if (size(pack) > maxBytes && pack.cross_file.destination_summary.length > 1) {
    const before = pack.cross_file.destination_summary.length;
    while (size(pack) > maxBytes && pack.cross_file.destination_summary.length > 1) {
      pack.cross_file.destination_summary.pop();
    }
    truncations.push({ array: "cross_file.destination_summary", removed: before - pack.cross_file.destination_summary.length });
  }

  // 2) per-file anomalies.
  if (size(pack) > maxBytes) {
    let removed = 0;
    for (const f of pack.files) {
      if (size(pack) <= maxBytes) break;
      removed += f.anomalies.length;
      f.anomalies = [];
    }
    if (removed > 0) truncations.push({ array: "files[].anomalies", removed });
  }

  for (const t of truncations) {
    pack.summary_signals.high.push({ kind: "truncation", array: t.array, removed: t.removed });
  }
}
