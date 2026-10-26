// Bake-off DB schema. A single local SQLite file (node:sqlite, the same
// dependency-free engine the Layer-3 cache uses) into which every analysis run —
// single-extension `assess`, corpus `reports`, and scored `scorecard` — is
// recorded, so methodologies / models / parameters / targets can be COMPARED
// with SQL instead of by diffing scattered JSON files.
//
// Design: HYBRID. Every field you would filter, group, or rank on is a typed
// column; the full source object is also kept verbatim in a `*_json` column so
// nothing is lost and new columns can be backfilled from it later. Foreign keys
// cascade, so deleting/replacing a run cleans up all its children.
//
// Shape (one row per … ):
//   run          — one CLI invocation: all the adjustable knobs + version stamps
//   target       — one extension analyzed within a run (1 for assess, N for corpus)
//   report       — the (run × target) risk assessment: verdict, summaries, tokens
//   finding      — one asserted OR excluded finding within a report (the unit of
//                  cross-arm comparison — "what did agentic catch that monolith dropped")
//   usage        — one per-step token/cost line (label × model)
//   scorecard    — corpus-run rollup (coverage, tier-recall, unsafe-misses, …)
//   sample_score — one corpus sample's judged result within a scorecard run
//   submission   — one analysis job in the unified queue (queued → runner)
//   ledger_event — one runner/budget observation (rate limits, probes, backoffs)
//   runner_state — runner daemon KV (backoff-until, last-run stamps, dirty flags)

/** Bumped whenever the DDL below changes shape. openDb() refuses to touch a file
 *  written by a NEWER schema, and recreates an empty/older one. */
export const SCHEMA_VERSION = 8;

// One statement per line group; executed together via DatabaseSync.exec().
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  run_hash              TEXT NOT NULL UNIQUE,
  kind                  TEXT NOT NULL,            -- 'assess' | 'reports' | 'scorecard'
  methodology           TEXT NOT NULL,            -- monolith | dag | agentic | pi
  model                 TEXT NOT NULL,
  verifier_model        TEXT,
  judge_model           TEXT,
  think                 TEXT,                     -- reasoning effort knob
  mode                  TEXT,                     -- RECORD | REPLAY
  headroom              INTEGER,                  -- 0/1: Pi routed through the headroom token-compression proxy
  subagent_models       TEXT,                     -- Pi sharded fan-out: JSON map {dimension|synthesis: model}; NULL when monolithic
  runs                  INTEGER,                  -- repeated-runs N (scorecard stability)
  tier_recall           INTEGER,                  -- 0/1 (scorecard)
  analyzer_version      TEXT,
  report_schema_version TEXT,
  corpus_dir            TEXT,
  fixtures_dir          TEXT,
  cost_rates_json       TEXT,
  git_sha               TEXT,
  started_at            TEXT NOT NULL,            -- ISO 8601; live = wall-clock, backfill = file mtime
  source_path           TEXT,                     -- backfill provenance (the file/dir ingested)
  raw_json              TEXT                      -- full knob set + any extra
);

CREATE TABLE IF NOT EXISTS target (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  sample            TEXT,                          -- corpus sample dir name, else NULL
  store_id          TEXT,                          -- Chrome Web Store id, else NULL
  name              TEXT,
  version           TEXT,
  manifest_version  INTEGER,
  source_dir        TEXT,
  is_corpus         INTEGER NOT NULL,              -- 0/1
  label_kind        TEXT,                          -- corpus ground truth: benign | malicious
  expected_tier     TEXT
);

CREATE TABLE IF NOT EXISTS report (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  target_id             INTEGER NOT NULL REFERENCES target(id) ON DELETE CASCADE,
  tier                  TEXT,                      -- verdict / native tier
  tier_source           TEXT,                      -- native | normalized (scorecard runs)
  overall_rationale     TEXT,
  layperson_summary     TEXT,
  technical_summary     TEXT,
  description_deviates   INTEGER,                  -- 0/1/NULL
  num_findings          INTEGER,
  num_excluded          INTEGER,
  input_tokens          INTEGER,
  output_tokens         INTEGER,
  estimated_usd         REAL,
  report_text           TEXT,                      -- the free-form rendered report
  risk_report_json      TEXT,                      -- the structured RiskReport, when present
  structured_json       TEXT                       -- the full arm-specific trace, when present
);

CREATE TABLE IF NOT EXISTS finding (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id          INTEGER NOT NULL REFERENCES report(id) ON DELETE CASCADE,
  finding_id         TEXT,                         -- the finding's own id (e.g. "f1")
  title              TEXT,
  kind               TEXT,                         -- verified-behavior | observed-capability
  severity           TEXT,                         -- critical..info
  category           TEXT,                         -- closed taxonomy (which surface)
  finding_type       TEXT,                         -- threat-class: vulnerability | malicious | unwanted | risky-capability | benign | unknown
  confidence         TEXT,                         -- low | medium | high
  claim_type         TEXT,                         -- observed-capability | inferred-behavior
  is_verified        INTEGER NOT NULL,             -- 1 = asserted, 0 = excluded
  exclusion_reason   TEXT,                         -- when excluded (refuted, needs-dynamic, …)
  claimed_mechanism  TEXT,
  detail             TEXT,
  evidence_json      TEXT
);

CREATE TABLE IF NOT EXISTS usage (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  target_id      INTEGER REFERENCES target(id) ON DELETE CASCADE,  -- NULL = run-level accounting
  label          TEXT NOT NULL,                    -- pipeline step (monolith, verify:claim, judge:*, …)
  model          TEXT NOT NULL,
  calls          INTEGER,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  wall_clock_ms  INTEGER,
  estimated_usd  REAL
);

CREATE TABLE IF NOT EXISTS scorecard (
  run_id                 INTEGER PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
  coverage_known_shapes  REAL,                     -- A–G (primary)
  coverage_open_world    REAL,                     -- H
  tier_recall            REAL,
  unsafe_misses          INTEGER,
  false_dismissals       INTEGER,
  hedged_misses          INTEGER,
  false_alarm_count      INTEGER,
  stability              TEXT,                     -- number-as-text or "not measured (replay)"
  bellwether_b           REAL,
  bellwether_e           REAL,
  bellwether_g           REAL,
  per_arm_missed         INTEGER,
  h_detected             INTEGER,
  h_coverage             REAL,
  h_tier_masked          INTEGER,
  total_input_tokens     INTEGER,
  total_output_tokens    INTEGER,
  estimated_usd          REAL,
  raw_json               TEXT
);

CREATE TABLE IF NOT EXISTS sample_score (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  target_id         INTEGER REFERENCES target(id) ON DELETE CASCADE,
  sample            TEXT NOT NULL,
  label_kind        TEXT,
  expected_tier     TEXT,
  normalized_tier   TEXT,
  tier_source       TEXT,
  coverage          REAL,
  miss_kind         TEXT,                           -- malicious: confident-dismissal | hedged-miss | …
  false_alarm       INTEGER,                        -- benign: 0/1
  must_detect_json  TEXT,
  must_not_emit_json TEXT,
  input_tokens      INTEGER,
  output_tokens     INTEGER
);

-- The unified job queue. The runner-only columns (source, priority, origin_id,
-- attempts, not_before) exist ONLY in the local bake-off DB: the deployed D1
-- copy of this table is preserved across syncs and CREATE TABLE IF NOT EXISTS
-- never alters it, so it stays v5-shaped — remote pull / write-back queries
-- must not reference them.
CREATE TABLE IF NOT EXISTS submission (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  input_raw         TEXT NOT NULL,                 -- what the user typed (ID or URL)
  store_id          TEXT,                          -- extracted 32-char id, when valid
  status            TEXT NOT NULL,                 -- queued | running | succeeded | failed
  profile_json      TEXT,                          -- pinned pipeline the job runs
  requested_by      TEXT,                          -- role/user marker (auth later)
  created_at        TEXT NOT NULL,                 -- ISO 8601
  started_at        TEXT,
  finished_at       TEXT,
  error             TEXT,
  result_report_id  INTEGER REFERENCES report(id) ON DELETE SET NULL,
  source            TEXT,                          -- user | remote | discovery | admin
  priority          INTEGER NOT NULL DEFAULT 50,   -- higher claims first
  origin_id         INTEGER,                       -- remote D1 submission.id this row mirrors
  attempts          INTEGER NOT NULL DEFAULT 0,    -- rate-limit requeues so far
  not_before        TEXT,                          -- ISO: not claimable before (retry backoff)
  config_json       TEXT,                          -- immutable, secret-free analysis settings (local)
  config_key        TEXT,                          -- canonical configuration for active-job dedup
  batch_id          TEXT,                          -- durable batch identity (local)
  cancel_requested_at TEXT,
  retry_of INTEGER REFERENCES submission(id),
  current_attempt_id INTEGER
);

CREATE TABLE IF NOT EXISTS analysis_attempt (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submission(id),
  executor_token TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT
);
CREATE TABLE IF NOT EXISTS analysis_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submission(id),
  attempt_id INTEGER REFERENCES analysis_attempt(id),
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  stage TEXT,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(submission_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_attempt_submission ON analysis_attempt(submission_id,id);
CREATE INDEX IF NOT EXISTS idx_event_submission ON analysis_event(submission_id,sequence);
CREATE TABLE IF NOT EXISTS analysis_profile (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_profile_name ON analysis_profile(lower(name));
CREATE TABLE IF NOT EXISTS analysis_remote_origin (
  remote_id INTEGER PRIMARY KEY,
  submission_id INTEGER NOT NULL REFERENCES submission(id)
);

-- Budget/pacing observations the runner learns caps from: what happened
-- (rate_limit | probe_ok | probe_limited | backoff_start | backoff_end |
-- job_done | job_failed), when, and any context (e.g. the usage-window gauge
-- captured at 429 time, JSON in the detail column).
CREATE TABLE IF NOT EXISTS ledger_event (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL,                         -- ISO 8601
  kind      TEXT NOT NULL,
  source    TEXT,                                  -- assess | runner | probe
  store_id  TEXT,
  model     TEXT,
  detail    TEXT                                   -- free-form / JSON
);

CREATE TABLE IF NOT EXISTS analysis_batch_item (
  batch_id TEXT NOT NULL,
  submission_id INTEGER NOT NULL REFERENCES submission(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (batch_id, submission_id)
);

-- Runner daemon state that must survive a restart (backoff_until, last-ingest/
-- discovery/sync stamps, dirty-for-sync). One row per key.
CREATE TABLE IF NOT EXISTS runner_state (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL                        -- ISO 8601
);

CREATE INDEX IF NOT EXISTS idx_run_knobs    ON run(kind, methodology, model);
CREATE INDEX IF NOT EXISTS idx_target_run   ON target(run_id);
CREATE INDEX IF NOT EXISTS idx_target_ident ON target(sample, store_id);
CREATE INDEX IF NOT EXISTS idx_report_run   ON report(run_id);
CREATE INDEX IF NOT EXISTS idx_finding_rep  ON finding(report_id);
CREATE INDEX IF NOT EXISTS idx_finding_cat  ON finding(category, severity);
CREATE INDEX IF NOT EXISTS idx_usage_run    ON usage(run_id);
CREATE INDEX IF NOT EXISTS idx_sscore_run   ON sample_score(run_id);
CREATE INDEX IF NOT EXISTS idx_submission_status ON submission(status, created_at);
CREATE INDEX IF NOT EXISTS idx_submission_claim  ON submission(status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_ts         ON ledger_event(kind, ts);
`;
