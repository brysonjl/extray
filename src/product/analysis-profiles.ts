import type { DataSource, Row } from "./datasource.ts";
import { parseSubmissionConfig, snapshotSettings, type SubmissionConfig } from "./submission-config.ts";
import { validateSettings, type ExplorerSettings } from "./settings.ts";

export interface AnalysisProfile {
  id: string;
  name: string;
  configuration: SubmissionConfig;
  createdAt: string;
  updatedAt: string;
}
export class AnalysisProfileError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 = 400) { super(message); }
}
function profile(row: Row): AnalysisProfile | null {
  const configuration = parseSubmissionConfig(row.config_json);
  return configuration ? { id: String(row.id), name: String(row.name), configuration, createdAt: String(row.created_at), updatedAt: String(row.updated_at) } : null;
}
export async function listAnalysisProfiles(ds: DataSource): Promise<AnalysisProfile[]> {
  return (await ds.all("SELECT * FROM analysis_profile ORDER BY name COLLATE NOCASE, id")).map(profile).filter((value): value is AnalysisProfile => value !== null);
}
export function profileConfiguration(input: unknown, current: ExplorerSettings): SubmissionConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AnalysisProfileError("configuration must be an object");
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["methodology", "model", "options"].includes(key))) throw new AnalysisProfileError("profiles accept methodology, model and options; manage credentials and connections in Settings");
  return snapshotSettings(validateSettings(raw, current));
}
export async function saveAnalysisProfile(ds: DataSource, input: unknown, current: ExplorerSettings, id?: string): Promise<AnalysisProfile> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AnalysisProfileError("profile must be an object");
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["name", "configuration"].includes(key))) throw new AnalysisProfileError("profile accepts name and configuration only");
  if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.trim().length > 80 || /[\r\n\0]/.test(raw.name)) throw new AnalysisProfileError("profile name must contain 1–80 characters on one line");
  const name = raw.name.trim();
  const config = profileConfiguration(raw.configuration, current);
  if (id && !await ds.get("SELECT id FROM analysis_profile WHERE id=?", id)) throw new AnalysisProfileError("profile not found", 404);
  const duplicate = await ds.get("SELECT id FROM analysis_profile WHERE lower(name)=lower(?) AND id<>?", name, id ?? "");
  if (duplicate) throw new AnalysisProfileError("a profile with that name already exists", 409);
  const now = new Date().toISOString();
  const profileId = id ?? crypto.randomUUID();
  try {
    if (id) await ds.run("UPDATE analysis_profile SET name=?,config_json=?,updated_at=? WHERE id=?", name, JSON.stringify(config), now, id);
    else await ds.run("INSERT INTO analysis_profile(id,name,config_json,created_at,updated_at) VALUES(?,?,?,?,?)", profileId, name, JSON.stringify(config), now, now);
  } catch (error) {
    if (/unique/i.test(String(error))) throw new AnalysisProfileError("a profile with that name already exists", 409);
    throw error;
  }
  return profile((await ds.get("SELECT * FROM analysis_profile WHERE id=?", profileId))!)!;
}
export async function deleteAnalysisProfile(ds: DataSource, id: string): Promise<void> {
  if (!(await ds.run("DELETE FROM analysis_profile WHERE id=?", id)).changes) throw new AnalysisProfileError("profile not found", 404);
}
