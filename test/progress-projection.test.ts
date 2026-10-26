import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "../src/db/schema.ts";
import { buildProgressProjection, progressMigration, PROGRESS_SCHEMA } from "../src/product/progress-projection.ts";
import { buildD1Export } from "../scripts/export-d1.ts";
import { snapshotSettings } from "../src/product/submission-config.ts";
import { allocateProgressRevision, progressSchemaStatements } from "../scripts/explorer-progress.ts";
import { DEFAULT_SETTINGS } from "../src/product/settings.ts";

const opened: DatabaseSync[] = [];
const db = () => { const d = new DatabaseSync(":memory:"); d.exec("PRAGMA foreign_keys=ON"); d.exec(SCHEMA_SQL); opened.push(d); return d; };
const now = "2026-10-18T12:00:00.000Z";
const store = "a".repeat(32);
afterEach(() => { for (const d of opened.splice(0)) d.close(); });
function job(d: DatabaseSync, id=1, status="queued") {
  d.prepare("INSERT INTO submission(id,input_raw,store_id,status,created_at,config_json) VALUES(?,?,?,?,?,?)").run(id,store,store,status,now,JSON.stringify(snapshotSettings(DEFAULT_SETTINGS)));
}
function seedReport(d: DatabaseSync, id=1) {
  d.prepare("INSERT INTO run(id,run_hash,kind,methodology,model,started_at) VALUES(?,?,'assess','pi','glm-5.2:cloud',?)").run(id,`hash-${id}`,now);
  d.prepare("INSERT INTO target(id,run_id,store_id,is_corpus) VALUES(?,?,?,0)").run(id,id,store);
  d.prepare("INSERT INTO report(id,run_id,target_id,risk_report_json) VALUES(?,?,?,?)").run(id,id,id,JSON.stringify({padding:"x".repeat(85000)}));
  d.prepare("INSERT INTO usage(run_id,target_id,label,model,calls,input_tokens,estimated_usd) VALUES(?,?,'investigation','glm-5.2:cloud',2,100,0.02)").run(id,id);
}
function apply(remote: DatabaseSync, local: DatabaseSync, revision: number, source="source-A") {
  remote.exec(progressMigration((remote.prepare("PRAGMA table_info(submission)").all() as {name:string}[]).map(r=>r.name)).join("\n"));
  remote.exec(PROGRESS_SCHEMA);
  const p = buildProgressProjection(local,source,revision,now);
  remote.exec(p.statements.join("\n"));
  return p;
}

describe("hosted progress projection", () => {
  it("uses stable isolated identities, redacts credentials, and converges on duplicate and out-of-order delivery", () => {
    const local=db(), remote=db(); job(local); job(remote, 1);
    local.prepare("UPDATE submission SET status='running',error=? WHERE id=1").run("HTTP error api_key=secret-value");
    const first=apply(remote,local,1);
    expect(remote.prepare("SELECT status FROM submission WHERE id=-1").get()?.status).toBe("running");
    expect(remote.prepare("SELECT status FROM submission WHERE id=1").get()?.status).toBe("queued");
    expect(first.statements.join(" ")).not.toContain("secret-value");
    local.exec("UPDATE submission SET status='failed' WHERE id=1");
    apply(remote,local,2); remote.exec(first.statements.join("\n")); apply(remote,local,2);
    expect(remote.prepare("SELECT status FROM submission WHERE id=-1").get()?.status).toBe("failed");
    expect(remote.prepare("SELECT COUNT(*) n FROM submission").get()?.n).toBe(2);
    local.exec("UPDATE submission SET status='running' WHERE id=1"); apply(remote,local,3,"source-B");
    expect(remote.prepare("SELECT status FROM submission WHERE id=-1").get()?.status).toBe("failed");
  });
  it("mirrors all joined remote requests with independent attempt/event identities and preserves requester identity", () => {
    const local=db(),remote=db(); job(local); job(remote,7); job(remote,8);
    remote.exec("UPDATE submission SET requested_by='alice@example.test' WHERE id=7");
    local.exec("INSERT INTO analysis_remote_origin VALUES(7,1),(8,1)");
    local.prepare("INSERT INTO analysis_attempt(id,submission_id,executor_token,status,started_at) VALUES(1,1,'local-secret-token','running',?)").run(now);
    local.prepare("INSERT INTO analysis_event(id,submission_id,attempt_id,sequence,kind,stage,message,created_at) VALUES(1,1,1,1,'stage','investigation','Investigating',?)").run(now);
    local.exec("UPDATE submission SET status='running',current_attempt_id=1");
    const p=apply(remote,local,1); apply(remote,local,1);
    expect(p.statements.join(" ")).not.toContain("local-secret-token");
    expect(remote.prepare("SELECT COUNT(*) n FROM analysis_event").get()?.n).toBe(3);
    expect(remote.prepare("SELECT COUNT(*) n FROM analysis_attempt").get()?.n).toBe(3);
    expect(remote.prepare("SELECT requested_by FROM submission WHERE id=7").get()?.requested_by).toBe("alice@example.test");
    expect(remote.prepare("SELECT status FROM submission WHERE id=8").get()?.status).toBe("running");
    expect(remote.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("fences older payload statements as soon as an overlapping newer delivery starts", () => {
    const local=db(),remote=db(); job(local);
    remote.exec(progressSchemaStatements((remote.prepare("PRAGMA table_info(submission)").all() as {name:string}[]).map(r=>r.name)).join("\n"));
    local.prepare("INSERT INTO analysis_attempt(id,submission_id,executor_token,status,started_at) VALUES(1,1,'owner','running',?)").run(now);
    local.prepare("INSERT INTO analysis_event(id,submission_id,attempt_id,sequence,kind,stage,message,created_at) VALUES(1,1,1,1,'stage','investigation','Investigating',?)").run(now);
    local.exec("UPDATE submission SET status='running',current_attempt_id=1");
    local.prepare("INSERT INTO runner_state VALUES('manual_pause','1',?)").run(now);
    local.prepare("INSERT INTO runner_state VALUES('executor_heartbeat',?,?)").run(JSON.stringify({at:now,state:"active"}),now);
    const older=buildProgressProjection(local,"source-A",1,now);

    const later="2026-10-18T12:01:00.000Z";
    local.prepare("UPDATE submission SET status='failed',finished_at=?").run(later);
    local.prepare("UPDATE analysis_attempt SET status='failed',finished_at=?,error='Verification failed'").run(later);
    local.prepare("INSERT INTO analysis_event(id,submission_id,attempt_id,sequence,kind,stage,message,created_at) VALUES(2,1,1,2,'stage','verification','Verification failed',?)").run(later);
    local.exec("DELETE FROM runner_state WHERE key='manual_pause'");
    local.prepare("UPDATE runner_state SET value=?,updated_at=? WHERE key='executor_heartbeat'").run(JSON.stringify({at:later,state:"stopped"}),later);
    const newer=buildProgressProjection(local,"source-A",2,later);

    // Two file uploads overlap at statement boundaries. The older upload starts
    // first, stalls after identity/reservation, and resumes before the newer
    // upload's final statement. No file-wide transaction is assumed.
    remote.exec(older.statements.slice(0,2).join("\n"));
    remote.exec(newer.statements.slice(0,-1).join("\n"));
    // Events are append-only locally, so stale upserts could otherwise rewrite
    // identical values unnoticed. Observe writes during the older upload only.
    remote.exec("CREATE TEMP TABLE stale_event_writes(id INTEGER); CREATE TEMP TRIGGER observe_stale_events AFTER UPDATE ON analysis_event BEGIN INSERT INTO stale_event_writes VALUES(new.id); END;");
    remote.exec(older.statements.slice(2).join("\n"));
    expect(remote.prepare("SELECT COUNT(*) n FROM stale_event_writes").get()?.n).toBe(0);
    remote.exec("DROP TRIGGER observe_stale_events");
    remote.exec(newer.statements.at(-1)!);

    expect(remote.prepare("SELECT status,progress_revision FROM submission WHERE id=-1").get()).toEqual({status:"failed",progress_revision:2});
    expect(remote.prepare("SELECT status,finished_at,error FROM analysis_attempt").get()).toEqual({status:"failed",finished_at:later,error:"Verification failed"});
    expect(remote.prepare("SELECT sequence,message FROM analysis_event ORDER BY sequence").all()).toEqual([{sequence:1,message:"Investigating"},{sequence:2,message:"Verification failed"}]);
    expect(remote.prepare("SELECT COUNT(*) n FROM analysis_event e JOIN analysis_attempt a ON a.id=e.attempt_id WHERE a.status='failed'").get()?.n).toBe(2);
    expect(remote.prepare("SELECT value FROM runner_state WHERE key='manual_pause'").get()).toBeUndefined();
    expect(JSON.parse(String(remote.prepare("SELECT value FROM runner_state WHERE key='executor_heartbeat'").get()?.value))).toEqual({at:later,state:"stopped"});
    expect(remote.prepare("SELECT value FROM runner_state WHERE key='progress_observed_at'").get()?.value).toBe(later);
    expect(remote.prepare("SELECT revision FROM analysis_projection_source").get()?.revision).toBe(2);
    expect(remote.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    // A retried newest file repairs partial delivery; a retried older one stays
    // fenced, including its source reservation statement.
    remote.exec(newer.statements.join("\n"));
    remote.exec(older.statements.join("\n"));
    expect(remote.prepare("SELECT status FROM analysis_attempt").get()?.status).toBe("failed");
    expect(remote.prepare("SELECT COUNT(*) n FROM analysis_event").get()?.n).toBe(2);
  });
  it("keeps local analysis links current when remote request aliases join later", () => {
    const local=db(), remote=db(); job(local); job(remote,7);
    local.exec("UPDATE submission SET status='running'");
    const before=apply(remote,local,1);
    local.exec("INSERT INTO analysis_remote_origin VALUES(7,1); UPDATE submission SET status='failed',error='test failure'");
    apply(remote,local,2);
    expect(remote.prepare("SELECT id,status FROM submission ORDER BY id").all()).toEqual([{id:-1,status:"failed"},{id:7,status:"failed"}]);
    remote.exec(before.statements.join("\n"));
    expect(remote.prepare("SELECT status FROM submission WHERE id=-1").get()?.status).toBe("failed");
  });
  it("sanitizes raw profile and heartbeat fields before hosted publication", () => {
    const local=db(),remote=db(); job(local);
    local.prepare("UPDATE submission SET profile_json=?").run(JSON.stringify({ pinned:{methodology:"pi",model:"test-model",apiKey:"profile-key-secret"},userFallback:[],extra:{token:"nested-profile-secret"} }));
    local.prepare("INSERT INTO runner_state VALUES('executor_heartbeat',?,?)").run(JSON.stringify({at:{token:"heartbeat-secret"},state:"active"}),now);
    local.prepare("INSERT INTO runner_state VALUES('backoff_until',?,?)").run("token=state-secret",now);
    const p=apply(remote,local,1);
    expect(p.statements.join(" ")).not.toContain("profile-key-secret");
    expect(p.statements.join(" ")).not.toContain("nested-profile-secret");
    expect(p.statements.join(" ")).not.toContain("heartbeat-secret");
    expect(p.statements.join(" ")).not.toContain("state-secret");
    expect(JSON.parse(String(remote.prepare("SELECT profile_json FROM submission WHERE id=-1").get()?.profile_json))).toEqual({pinned:{methodology:"pi",model:"test-model"},userFallback:[],adminReference:[],requireStoreBacked:false});
  });
  it("bootstraps a fresh hosted database before applying progress rows", () => {
    const local=db(),remote=new DatabaseSync(":memory:");opened.push(remote);job(local);
    remote.exec(progressSchemaStatements([]).join("\n"));
    remote.exec(buildProgressProjection(local,"fresh-source",1,now).statements.join("\n"));
    expect(remote.prepare("SELECT status,progress_revision FROM submission WHERE id=-1").get()).toEqual({status:"queued",progress_revision:1});
  });
  it("atomically assigns increasing revisions even when publishers share a timestamp", () => {
    const local=db();
    const first=allocateProgressRevision(local,now);
    const second=allocateProgressRevision(local,now);
    const earlier=allocateProgressRevision(local,"2026-10-17T12:00:00.000Z");
    expect(first).toBe(Date.parse(now));expect(second).toBe(first+1);expect(earlier).toBe(second+1);
  });
  it("waits for the exact report to arrive and never substitutes a canonical report", () => {
    const local=db(),remote=db(); seedReport(local,1); seedReport(local,2); seedReport(remote,1); job(local);
    local.exec("UPDATE submission SET status='succeeded',result_report_id=2");
    apply(remote,local,1);
    expect(remote.prepare("SELECT result_report_id FROM submission WHERE id=-1").get()?.result_report_id).toBeNull();
    remote.exec(buildD1Export(local,()=>true).sql); apply(remote,local,2);
    expect(remote.prepare("SELECT result_report_id FROM submission WHERE id=-1").get()?.result_report_id).toBe(2);
    remote.exec(buildD1Export(local,()=>true).sql);
    expect(remote.prepare("SELECT result_report_id FROM submission WHERE id=-1").get()?.result_report_id).toBe(2);
    expect(remote.prepare("SELECT COUNT(*) n FROM usage").get()?.n).toBe(2);
    expect(remote.prepare("SELECT risk_report_json FROM report WHERE id=2").get()?.risk_report_json).toBe(local.prepare("SELECT risk_report_json FROM report WHERE id=2").get()?.risk_report_json);
  });
  it("prunes held reports while preserving other exact results and their accounting", () => {
    const local=db(),remote=db(); seedReport(local,1); seedReport(local,2);
    remote.exec(buildD1Export(local,()=>true).sql); job(remote);
    remote.exec("UPDATE submission SET status='succeeded',result_report_id=2");
    local.prepare("INSERT INTO ledger_event(ts,kind,detail) VALUES(?,'canonical_hold',?)").run(now,JSON.stringify({runHash:"hash-1"}));
    remote.exec(buildD1Export(local,()=>true).sql);
    expect(remote.prepare("SELECT id FROM report ORDER BY id").all()).toEqual([{id:2}]);
    expect(remote.prepare("SELECT result_report_id FROM submission WHERE id=1").get()?.result_report_id).toBe(2);
    expect(remote.prepare("SELECT run_id FROM usage").all()).toEqual([{run_id:2}]);
  });
  it("projects heartbeat timestamps without process identity and preserves freshness ordering", () => {
    const local=db(),remote=db(); job(local);
    local.prepare("INSERT INTO runner_state VALUES('executor_heartbeat',?,?)").run(JSON.stringify({at:now,state:"active",pid:9876,token:"secret-owner"}),now);
    const p=apply(remote,local,2);
    expect(p.statements.join(" ")).not.toContain("secret-owner"); expect(p.statements.join(" ")).not.toContain("9876");
    expect(JSON.parse(String(remote.prepare("SELECT value FROM runner_state WHERE key='executor_heartbeat'").get()?.value))).toEqual({at:now,state:"active"});
    local.exec("DELETE FROM runner_state"); apply(remote,local,1);
    expect(remote.prepare("SELECT value FROM runner_state WHERE key='executor_heartbeat'").get()).toBeDefined();
  });
  it("mirrors manual pause overrides and clears them after explicit policy saves", () => {
    const local=db(),remote=db();job(local);
    local.prepare("INSERT INTO runner_state VALUES('manual_pause','1',?)").run(now);
    apply(remote,local,1);
    expect(remote.prepare("SELECT value FROM runner_state WHERE key='manual_pause'").get()?.value).toBe("1");
    local.exec("UPDATE runner_state SET value='0' WHERE key='manual_pause'");apply(remote,local,2);
    expect(remote.prepare("SELECT value FROM runner_state WHERE key='manual_pause'").get()?.value).toBe("0");
    local.exec("DELETE FROM runner_state WHERE key='manual_pause'");apply(remote,local,3);
    expect(remote.prepare("SELECT value FROM runner_state WHERE key='manual_pause'").get()).toBeUndefined();
  });
  it("migrates legacy queue columns additively", () => {
    const d=new DatabaseSync(":memory:"); opened.push(d);
    d.exec("CREATE TABLE submission(id INTEGER PRIMARY KEY,input_raw TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL); INSERT INTO submission VALUES(1,'original','queued','2026-01-01');");
    d.exec(progressMigration(["id","input_raw","status","created_at"]).join("\n"));
    expect(d.prepare("SELECT input_raw,priority,progress_revision FROM submission").get()).toEqual({input_raw:"original",priority:50,progress_revision:0});
    expect(progressMigration((d.prepare("PRAGMA table_info(submission)").all() as {name:string}[]).map(r=>r.name))).toEqual([]);
  });
});
