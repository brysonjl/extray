import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AnalysisEstimate as Estimate } from "../../../../src/product/analysis-estimate";
import { validateAnalysisOptions } from "../../../../src/product/analysis-config";
import { apiPost } from "../api";
import { useRole } from "../role";
import type { ProfileConfiguration } from "./AnalysisProfiles";
export function AnalysisEstimate({ configuration, targets }: { configuration: ProfileConfiguration; targets: number }) {
  const { role } = useRole();
  const [debounced, setDebounced] = useState(configuration);
  useEffect(() => { const timer = setTimeout(() => setDebounced(configuration), 400); return () => clearTimeout(timer); }, [configuration]);
  let valid = true;
  try { validateAnalysisOptions(debounced.options, debounced.methodology); if (!debounced.model.trim()) valid = false; } catch { valid = false; }
  const estimate = useQuery({ queryKey: ["analysis-estimate", role, debounced, targets], queryFn: () => apiPost<Estimate>("/api/analysis-estimate", role, { configuration: debounced, targets: Math.max(1, targets) }), enabled: valid && targets <= 100, staleTime: 60_000, retry: false });
  const data = estimate.data;
  const money = (value: number) => `$${value.toFixed(value < .01 ? 4 : 2)}`;
  return <div className="analysis-estimate" aria-live="polite">
    <span className="workspace-eyebrow">Historical estimate</span>
    {estimate.isFetching ? <p className="faint">Checking recorded analyses…</p> : null}
    {estimate.error ? <p className="faint">Estimate unavailable. Submission remains available.</p> : null}
    {!valid ? <p className="faint">Complete a valid analysis configuration to see matching history.</p> : null}
    {data ? <>
      {data.cost ? <p><strong>{money(data.cost.batchMedianUsd)}</strong> median for {data.targets} {data.targets === 1 ? "extension" : "extensions"} · {money(data.cost.lowUsd)}–{money(data.cost.highUsd)} observed range per extension</p> : <p>No recorded cost estimate.</p>}
      {data.tokens ? <p className="faint">{Math.round(data.tokens.median).toLocaleString()} median tokens per extension{data.durationSeconds ? ` · ${Math.max(1, Math.round(data.durationSeconds.median / 60))} min typical ${data.basis === "exact-configuration" ? "execution" : "model time"}` : ""}</p> : null}
      <p className="faint">{data.sampleSize ? `${data.sampleSize} matching ${data.sampleSize === 1 ? "analysis" : "analyses"}${data.cost ? `; ${data.costSampleSize} with recorded cost` : ""}. ${data.sampleSize < 3 ? "Limited history. " : ""}` : ""}{data.note}</p>
    </> : null}
  </div>;
}
