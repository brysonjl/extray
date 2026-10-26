// Settings — the methodology, model and LLM endpoint used by the NEXT analysis.
// Local-only: the server injects the settings capability for a loopback bind
// only (scripts/serve.ts), so this page's nav link never appears on a hosted
// deployment and the routes 404 there.
//
// The API key is write-only from this page's point of view. It is stored in a
// gitignored file on the server, never in localStorage, and the API reports
// only whether one is set — so there is nothing here for a page-injected script
// to read back.

import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPut } from "../api";
import { useRole } from "../role";
import { PI_INJECTION_CAVEAT_TEXT } from "@pi/caveat";
import { lookupModel } from "@llm/model-table";
import { AnalysisProfiles } from "../components/AnalysisProfiles";
import { RunnerPolicySettings } from "../components/RunnerPolicySettings";
import { ErrorNote } from "../components/ui";
import type { SettingsPayload as BaseSettingsPayload } from "../types";
import { AnalysisOptionsFields, analysisOptionsForMethodology, type AnalysisOptions } from "../components/AnalysisOptionsFields";
type SettingsPayload = BaseSettingsPayload & { options?: AnalysisOptions };

/** What a PUT sends. Every field optional: the server merges onto what's
 *  stored, and "" explicitly clears baseUrl / apiKey. */
interface SettingsPatch {
  options?: AnalysisOptions;
  methodology?: string;
  model?: string;
  provider?: { id?: string; baseUrl?: string; apiKey?: string };
}

const METHODOLOGY_NOTE: Record<string, string> = {
  pi: "Default. The most effective measured arm — an agent that reads the extension itself. Also the most expensive, and the one exposed to prompt injection.",
  monolith: "One shot over the evidence pack plus source-grounded verification. Cheapest by far. Its committed replay fixtures (offline `npm run eval`) cover one exact config only.",
  dag: "A fan-out of focused passes, then synthesis. Middle cost.",
  agentic: "Per-dimension tool-using passes. Experimental.",
};

export default function SettingsPage() {
  const { role } = useRole();
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({
    queryKey: ["settings", role],
    queryFn: () => apiGet<SettingsPayload>("/api/settings", role),
    staleTime: 0,
  });

  const [form, setForm] = useState<SettingsPatch>({});
  const [apiKey, setApiKey] = useState("");
  const [saved, setSaved] = useState(false);

  // Server state is the source of truth; the form is seeded from it once it
  // arrives and after every successful save.
  useEffect(() => {
    if (data) {
      setForm({
        methodology: data.methodology,
        options: data.options ?? {},
        model: data.model,
        provider: { id: data.provider.id, baseUrl: data.provider.baseUrl ?? "" },
      });
      setApiKey("");
    }
  }, [data]);

  const save = useMutation({
    mutationFn: (patch: SettingsPatch) => apiPut<SettingsPayload>("/api/settings", role, patch),
    onSuccess: (next) => {
      qc.setQueryData(["settings", role], next);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    },
  });

  if (isLoading) return <div className="submit-card settings-card">Loading settings…</div>;
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({
      ...form,
      provider: {
        ...form.provider,
        // Only send the key field when the user typed in it — an untouched
        // field must not clear an already-stored key.
        ...(apiKey === "" ? {} : { apiKey }),
      },
    });
  };

  // One shared matcher (src/llm/model-table.ts): exact match for recommended,
  // prefix for caution, and an "unavailable" marker for models no longer served.
  const known = form.model ? lookupModel(form.model) : undefined;
  // Unavailability is a separate field on the table entry, not a status: the
  // measurement stays ("measured good") while the model is hidden from the picker.
  const listedModels = data.choices.models.filter((m) => !m.unavailable);
  const methodology = form.methodology ?? data.methodology;
  const providerId = form.provider?.id ?? data.provider.id;

  return (
    <div className="submit-card settings-card">
      <h1>Settings</h1>
      <p className="hint">
        These choices apply to <strong>new submissions</strong>. Queued configurations and existing results stay the same. The
        command line reads the same file, so an arm picked here is the arm <span className="mono">npm run assess</span>{" "}
        runs.
      </p>

      <form onSubmit={onSubmit}>
        <AnalysisProfiles configuration={{ methodology, model: form.model ?? data.model, options: form.options ?? {} }}
          onApply={(configuration) => setForm((current) => ({ ...current, ...configuration }))} />
        <label className="field">
          <span>Methodology</span>
          <select
            value={methodology}
            onChange={(e) => setForm((f) => ({ ...f, methodology: e.target.value, options: analysisOptionsForMethodology(f.options ?? {}, e.target.value) }))}
          >
            {data.choices.methodologies.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <p className="faint">{METHODOLOGY_NOTE[methodology] ?? ""}</p>
        {methodology === "pi" ? (
          <p className="pi-caveat hint warn-text" role="note">
            <strong>Warning - prompt injection.</strong> {PI_INJECTION_CAVEAT_TEXT}
          </p>
        ) : null}

        <label className="field">
          <span>Model</span>
          <input
            value={form.model ?? ""}
            onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
            spellCheck={false}
            placeholder="glm-5.2:cloud"
          />
        </label>
        <p className="faint">
          {known ? (
            <>
              <strong>
                {known.unavailable
                  ? "Unavailable"
                  : known.status === "recommended"
                    ? "Measured good"
                    : "Measured poor"}
              </strong>{" "}
              — {known.note}
            </>
          ) : (
            <>Untested with this tool. It will run; the results are not something we have measured.</>
          )}
        </p>
        <details>
          <summary>Models we have measured</summary>
          <ul className="model-table">
            {listedModels.map((m) => (
              <li key={m.family}>
                <span className="mono">{m.family}</span> — <em>{m.status}</em> — {m.note}
              </li>
            ))}
          </ul>
        </details>

        <label className="field">
          <span>Provider</span>
          <select
            value={providerId}
            onChange={(e) => setForm((f) => ({ ...f, provider: { ...f.provider, id: e.target.value } }))}
          >
            {data.choices.providers.map((p) => (
              <option key={p} value={p}>
                {p === "nvidia" ? "NVIDIA NIM" : p}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Base URL</span>
          <input
            value={form.provider?.baseUrl ?? ""}
            onChange={(e) => setForm((f) => ({ ...f, provider: { ...f.provider, baseUrl: e.target.value } }))}
            spellCheck={false}
            placeholder={providerId === "ollama" ? "https://ollama.com/v1" : providerId === "nvidia" ? "https://integrate.api.nvidia.com/v1" : "https://your-endpoint/v1"}
          />
        </label>
        <p className="faint">
          Any OpenAI-compatible endpoint. Leave empty to use the preset default. Include the <span className="mono">/v1</span>.
        </p>
        {providerId === "nvidia" ? (
          <p className="faint">
            Get a key and choose an available text model at <a href="https://build.nvidia.com/" target="_blank" rel="noreferrer">NVIDIA Build</a>.
            Use the catalog's exact model ID above. Pi needs a model with tool calling; analysis and verification need structured JSON output.
          </p>
        ) : null}

        <label className="field">
          <span>API key</span>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            placeholder={
              data.apiKeySet
                ? "stored — type to replace"
                : data.apiKeyFromEnv
                  ? "detected in the server's environment"
                  : "not set"
            }
          />
        </label>
        <p className="faint">
          Stored server-side in <span className="mono">{data.path}</span> (gitignored, mode 0600) — never in this
          browser.{" "}
          {data.apiKeyFromEnv ? null : (
            <>
              "Not set" means no stored key or server environment key was detected. Local <span className="mono">serve</span> loads
              <span className="mono"> .env</span> unless <span className="mono">SKIP_DOTENV=1</span>.{" "}
            </>
          )}
          {data.apiKeySet ? (
            <button
              type="button"
              className="btn secondary"
              disabled={save.isPending}
              onClick={() => save.mutate({ provider: { apiKey: "" } })}
            >
              Clear stored key
            </button>
          ) : null}
        </p>

        <AnalysisOptionsFields methodology={methodology} value={form.options ?? {}}
          onChange={(options) => setForm((f) => ({ ...f, options }))} />

        <button className="btn" type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </button>
        {saved ? <span className="faint"> Saved.</span> : null}
      </form>

      {save.error ? <ErrorNote error={save.error} /> : null}
      <RunnerPolicySettings />
    </div>
  );
}
