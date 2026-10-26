import type { AnalysisOptions, AnalysisThink } from "../../../../src/product/analysis-config";
import { ANALYSIS_DIMENSIONS } from "../../../../src/product/analysis-config";

export { analysisOptionsForMethodology } from "../../../../src/product/analysis-config";
export type { AnalysisOptions } from "../../../../src/product/analysis-config";

interface Props {
  methodology: string;
  value: AnalysisOptions;
  onChange: (value: AnalysisOptions) => void;
}

/** Shared by saved defaults and the per-analysis composer. Empty fields mean
 * the methodology's default; this component never handles credentials. */
export function AnalysisOptionsFields({ methodology, value, onChange }: Props) {
  function update<K extends keyof AnalysisOptions>(key: K, next: AnalysisOptions[K]) {
    const options = { ...value };
    if (next === undefined) delete options[key];
    else options[key] = next;
    onChange(options);
  }
  const sharded = Boolean(value.piShard || value.piSubagentModel || value.piSubagentModels && Object.keys(value.piSubagentModels).length || value.piSynthesisModel);
  const numberField = (key: "maxTokens" | "piMaxTurns" | "piSubagentMaxTurns" | "agenticMaxStepsPerDimension", label: string, placeholder: string, hint: string) => (
    <label className="field">
      <span>{label}</span>
      <input type="number" min={1} step={1} value={value[key] ?? ""} placeholder={placeholder}
        onChange={(event) => update(key, event.target.value === "" ? undefined : Number(event.target.value))} />
      <small className="faint">{hint}</small>
    </label>
  );
  const modelField = (key: "verifierModel" | "piSubagentModel" | "piSynthesisModel", label: string, hint: string) => (
    <label className="field">
      <span>{label}</span>
      <input value={value[key] ?? ""} maxLength={200} spellCheck={false} placeholder="Use primary model"
        onChange={(event) => update(key, event.target.value || undefined)} />
      <small className="faint">{hint}</small>
    </label>
  );
  return (
    <div className="analysis-options">
      <h2>Analysis configuration</h2>
      <p className="hint">Leave optional fields empty to use methodology defaults. These choices are saved with each new analysis.</p>
      {modelField("verifierModel", "Verifier model", "Checks source-grounded claims after investigation. A separate model can reduce self-verification bias.")}
      {methodology === "monolith" && (
        <label className="field">
          <span>Reasoning effort</span>
          <select value={value.think === undefined ? "" : String(value.think)} onChange={(event) => {
            const next = event.target.value;
            update("think", next === "" ? undefined : next === "true" ? true : next === "false" ? false : next as AnalysisThink);
          }}>
            <option value="">Model default</option><option value="false">Disabled</option><option value="true">Enabled</option>
            <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
          </select>
          <small className="faint">Supported values depend on the model. Reasoning effort is part of the replay cache key.</small>
        </label>
      )}
      {numberField("maxTokens", "Token budget", "No configured limit", methodology === "pi"
        ? "Pi investigator traffic bypasses the shared token limiter. This limit covers preflight and the verifier; use turn limits below to bound the investigator."
        : "Positive whole number. Preflight can refuse a run, and the shared LLM client stops further calls once its token budget is exhausted.")}
      <label className="field">
        <span>Static analysis cache</span>
        <select value={value.useCache === false ? "off" : "on"} onChange={(event) => update("useCache", event.target.value === "on" ? undefined : false)}>
          <option value="on">Reuse cached static evidence (default)</option><option value="off">Rebuild static evidence</option>
        </select>
        <small className="faint">Controls the static evidence cache separately from model response caching.</small>
      </label>
      <label className="field">
        <span>Extension download</span>
        <select value={value.forceFresh ? "fresh" : "reuse"} onChange={(event) => update("forceFresh", event.target.value === "fresh" ? true : undefined)}>
          <option value="reuse">Reuse the downloaded extension (default)</option><option value="fresh">Fetch a fresh copy</option>
        </select>
        <small className="faint">Applies to Chrome Web Store ID and URL submissions.</small>
      </label>
      <label className="field">
        <span>Host enrichment</span>
        <select value={value.enrich ? "record" : "existing"} onChange={(event) => update("enrich", event.target.value === "record" ? true : undefined)}>
          <option value="existing">Read existing enrichment (default)</option><option value="record">Fetch host registration data</option>
        </select>
        <small className="faint">Fetches RDAP records for external hosts before assessment. Replay mode skips these network requests.</small>
      </label>
      {methodology !== "pi" && (
        <label className="field">
          <span>Model response mode</span>
          <select value={value.replay ? "replay" : "live"} onChange={(event) => update("replay", event.target.value === "replay" ? true : undefined)}>
            <option value="live">Live with response cache (default)</option><option value="replay">Replay cached model responses only</option>
          </select>
          <small className="faint">Replay fails on a missing model response. Extension acquisition may still require network access.</small>
        </label>
      )}
      {methodology === "pi" && (
        <>
          <h3>Pi investigation</h3>
          <p className="faint">Pi runs live. Models and turn limits affect cost and investigation coverage.</p>
          {!sharded && numberField("piMaxTurns", "Investigator turn limit", "50", "Bounds the main investigator. Pi may allow a short wind-down to submit its findings.")}
          <label className="field">
            <span>Investigation layout</span>
            <select value={sharded ? "sharded" : "single"} onChange={(event) => {
              if (event.target.value === "sharded") {
                const { piMaxTurns: _turns, ...rest } = value;
                onChange({ ...rest, piShard: true });
              }
              else {
                const { piShard: _shard, piSubagentModel: _model, piSubagentModels: _models, piSynthesisModel: _synthesis, piSubagentMaxTurns: _turns, ...rest } = value;
                onChange(rest);
              }
            }}>
              <option value="single">Single investigator (default)</option><option value="sharded">Parallel investigators by dimension</option>
            </select>
            <small className="faint">Parallel investigation runs one agent per risk dimension, followed by synthesis.</small>
          </label>
          {sharded && <>
            {numberField("piSubagentMaxTurns", "Turn limit per dimension", "20", "Each parallel investigator receives its own turn allowance, with a short submission wind-down.")}
            {modelField("piSubagentModel", "Dimension investigator model", "Default model for every parallel dimension. Individual overrides below take precedence.")}
            {modelField("piSynthesisModel", "Synthesis model", "Combines the dimension investigations into a single result.")}
            <details>
              <summary>Model overrides by dimension</summary>
              {ANALYSIS_DIMENSIONS.map((dimension) => (
                <label className="field" key={dimension}>
                  <span>{dimension} model</span>
                  <input value={value.piSubagentModels?.[dimension] ?? ""} spellCheck={false} maxLength={200} placeholder="Use dimension investigator model"
                    onChange={(event) => {
                      const models = { ...value.piSubagentModels };
                      if (event.target.value) models[dimension] = event.target.value;
                      else delete models[dimension];
                      update("piSubagentModels", Object.keys(models).length ? models : undefined);
                    }} />
                </label>
              ))}
            </details>
          </>}
          <label className="field">
            <span>Investigator evidence pack</span>
            <select value={value.piNoPack ? "cold" : "pack"} onChange={(event) => update("piNoPack", event.target.value === "cold" ? true : undefined)}>
              <option value="pack">Provide the static evidence pack (default)</option><option value="cold">Explore source without the pack</option>
            </select>
            <small className="faint">Changes the investigator's starting evidence. The backend still uses static evidence to assemble results.</small>
          </label>
        </>
      )}
      {methodology === "agentic" && numberField("agenticMaxStepsPerDimension", "Steps per dimension", "8", "Each dimension has a separate tool-use budget. Exhausting it leaves that dimension inconclusive.")}
      <button className="btn secondary" type="button" onClick={() => onChange({})}>Reset analysis options</button>
    </div>
  );
}
