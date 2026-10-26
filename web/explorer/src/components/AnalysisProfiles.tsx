import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AnalysisProfile } from "../../../../src/product/analysis-profiles";
import type { AnalysisOptions } from "../../../../src/product/analysis-config";
import { apiGet, apiPost, apiPut, ApiError } from "../api";
import { useRole } from "../role";
import { ErrorNote } from "./ui";
import "../analysis-management.css";

export type ProfileConfiguration = { methodology: string; model: string; options: AnalysisOptions };
export function AnalysisProfiles({ configuration, onApply }: { configuration: ProfileConfiguration; onApply: (configuration: ProfileConfiguration) => void }) {
  const { role } = useRole(); const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState(""); const [name, setName] = useState("");
  const profiles = useQuery({ queryKey: ["analysis-profiles", role], queryFn: () => apiGet<{ profiles: AnalysisProfile[] }>("/api/analysis-profiles", role) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["analysis-profiles", role] }); };
  const save = useMutation({
    mutationFn: (update: boolean) => update
      ? apiPut<AnalysisProfile>(`/api/analysis-profiles/${encodeURIComponent(selectedId)}`, role, { name, configuration })
      : apiPost<AnalysisProfile>("/api/analysis-profiles", role, { name, configuration }),
    onSuccess: (profile) => { setSelectedId(profile.id); setName(profile.name); refresh(); },
  });
  const remove = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/analysis-profiles/${encodeURIComponent(selectedId)}`, { method: "DELETE", headers: { "x-explorer-role": role } });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new ApiError(response.status, body.error ?? "Unable to delete profile");
    },
    onSuccess: () => { setSelectedId(""); setName(""); refresh(); },
  });
  const busy = save.isPending || remove.isPending;
  return <section className="analysis-profile-controls" aria-label="Reusable analysis profiles">
    <div className="analysis-management-heading"><h3>Reusable profiles</h3><span className="faint">Saved on this installation</span></div>
    <label className="field"><span>Load a profile</span><select value={selectedId} disabled={busy || profiles.isPending} onChange={(event) => {
      setSelectedId(event.target.value); save.reset(); remove.reset();
      const profile = profiles.data?.profiles.find((item) => item.id === event.target.value);
      if (profile) { setName(profile.name); onApply({ methodology: profile.configuration.methodology, model: profile.configuration.model, options: profile.configuration.options ?? {} }); }
      else setName("");
    }}><option value="">Custom configuration</option>{profiles.data?.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
    <p className="faint">Profiles reuse analysis choices with the current connection. Credentials are never saved in profiles. Updating a profile leaves submitted analyses unchanged.</p>
    <div className="analysis-profile-save"><label className="field"><span>Profile name</span><input value={name} maxLength={80} placeholder="For example: thorough Pi review" onChange={(event) => { setName(event.target.value); save.reset(); }} /></label><div className="analysis-management-actions">
      <button type="button" className="btn secondary" disabled={busy || !name.trim()} onClick={() => save.mutate(false)}>Save as new profile</button>
      {selectedId && <><button type="button" className="btn secondary" disabled={busy || !name.trim()} onClick={() => save.mutate(true)}>Update selected profile</button><button type="button" className="btn secondary" disabled={busy} onClick={() => remove.mutate()}>Delete selected profile</button></>}
    </div></div>
    {save.isSuccess ? <p className="faint" role="status">Profile saved.</p> : null}
    {profiles.error || save.error || remove.error ? <ErrorNote error={profiles.error ?? save.error ?? remove.error} /> : null}
  </section>;
}
