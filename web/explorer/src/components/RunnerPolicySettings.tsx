import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DEFAULT_ANALYSIS_POLICY, type AnalysisPolicy } from "../../../../src/product/analysis-policy";
import { apiGet, apiPut } from "../api";
import { useRole } from "../role";
import { ErrorNote } from "./ui";
import "../analysis-management.css";
type PolicyPayload = { policy: AnalysisPolicy; saved: boolean; applies: string };
export function RunnerPolicySettings() {
  const { role } = useRole(); const qc = useQueryClient();
  const query = useQuery({ queryKey: ["runner-policy", role], queryFn: () => apiGet<PolicyPayload>("/api/runner-policy", role) });
  const [policy, setPolicy] = useState<AnalysisPolicy>(DEFAULT_ANALYSIS_POLICY);
  useEffect(() => { if (query.data) setPolicy(query.data.policy); }, [query.data]);
  const save = useMutation({ mutationFn: () => apiPut<PolicyPayload>("/api/runner-policy", role, policy), onSuccess: (data) => { qc.setQueryData(["runner-policy", role], data); void qc.invalidateQueries({ queryKey: ["runner"] }); } });
  const set = <K extends keyof AnalysisPolicy>(key: K, value: AnalysisPolicy[K]) => setPolicy((current) => ({ ...current, [key]: value }));
  const numberField = (key: "discoveryEveryHours" | "discoveryLimit" | "minInstalls" | "retryLimit" | "retryBackoffMinutes" | "sessionCapSeconds" | "weeklyCapSeconds", label: string, min: number, max: number) => <label className="field"><span>{label}</span><input type="number" min={min} max={max} step={1} required value={policy[key]} onChange={(event) => set(key, Number(event.target.value))} /></label>;
  return <section className="analysis-policy" aria-labelledby="runner-policy-heading">
    <h2 id="runner-policy-heading">Runner and discovery policy</h2>
    <p className="hint">Saved changes apply at the next scheduling tick. A running analysis finishes with its submitted settings. The local executor runs one analysis at a time.</p>
    {query.data && !query.data.saved ? <p className="faint">No Explorer policy has been saved. The runner's file and command-line configuration currently apply; this form starts with standard defaults. Saving makes these values the scheduling policy.</p> : null}
    <form onSubmit={(event: FormEvent) => { event.preventDefault(); save.mutate(); }}>
      <fieldset disabled={save.isPending || query.isPending}>
        <label className="analysis-policy-check"><input type="checkbox" checked={policy.paused} onChange={(event) => set("paused", event.target.checked)} /> Pause starting new analyses</label>
        <h3>Retries and usage limits</h3><p className="faint">Usage caps are measured in server generation seconds, not dollars. They guide the budget-aware daemon using recorded usage; they are not provider quota guarantees. The session fallback applies until enough rate-limit observations establish a measured cap.</p>
        <div className="analysis-policy-grid">{numberField("retryLimit", "Maximum rate-limit retries", 0, 20)}{numberField("retryBackoffMinutes", "Retry backoff (minutes)", 1, 1440)}{numberField("sessionCapSeconds", "Session budget fallback (seconds)", 1, 86400)}{numberField("weeklyCapSeconds", "Weekly generation budget (seconds)", 1, 604800)}</div>
        <h3>Scheduled discovery</h3><label className="analysis-policy-check"><input type="checkbox" checked={policy.discoveryEnabled} onChange={(event) => set("discoveryEnabled", event.target.checked)} /> Enable discovery scheduling</label>
        <div className="analysis-policy-grid">{numberField("discoveryEveryHours", "Discovery interval (hours)", 1, 8760)}{numberField("discoveryLimit", "Maximum candidates per discovery cycle", 1, 200)}{numberField("minInstalls", "Minimum installs", 0, 10_000_000_000)}</div>
        <label className="analysis-policy-check"><input type="checkbox" checked={policy.excludeAnalyzed} onChange={(event) => set("excludeAnalyzed", event.target.checked)} /> Skip extensions already analyzed</label>
        <div className="analysis-policy-queries">{policy.discoveryQueries.map((query, index) => <div className="analysis-policy-query" key={index}>
          <label className="field"><span>Query {index + 1} source</span><select value={query.source} onChange={(event) => set("discoveryQueries", policy.discoveryQueries.map((item, i) => i === index ? { ...item, source: event.target.value as "extpose" | "webstore" } : item))}><option value="extpose">Extpose</option><option value="webstore">Chrome Web Store</option></select></label>
          {(["collection", "category"] as const).map((key) => <label className="field" key={key}><span>Query {index + 1} {key}</span><input value={query[key] ?? ""} maxLength={120} placeholder={key === "collection" ? "new" : "Optional category"} onChange={(event) => set("discoveryQueries", policy.discoveryQueries.map((item, i) => i === index ? { ...item, [key]: event.target.value || undefined } : item))} /></label>)}
          <label className="field"><span>Query {index + 1} limit</span><input type="number" min={1} max={200} step={1} value={query.limit ?? ""} placeholder="Cycle limit" onChange={(event) => set("discoveryQueries", policy.discoveryQueries.map((item, i) => i === index ? { ...item, limit: event.target.value ? Number(event.target.value) : undefined } : item))} /></label>
          <button type="button" className="btn secondary" onClick={() => set("discoveryQueries", policy.discoveryQueries.filter((_, i) => i !== index))}>Remove query {index + 1}</button>
        </div>)}</div>
        <div className="analysis-management-actions"><button type="button" className="btn secondary" disabled={policy.discoveryQueries.length >= 20} onClick={() => set("discoveryQueries", [...policy.discoveryQueries, { source: "extpose", collection: "new", limit: 10 }])}>Add discovery query</button><button type="submit" className="btn">{save.isPending ? "Saving policy…" : "Save runner policy"}</button></div>
      </fieldset>
    </form>
    {save.isSuccess ? <p role="status" className="faint">Policy saved. The next scheduling tick will use it.</p> : null}
    {query.error || save.error ? <ErrorNote error={query.error ?? save.error} /> : null}
  </section>;
}
