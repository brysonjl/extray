// Research outputs remain in the raw database, but a hold prevents any
// product selection/export from treating them as publishable reports.
// CASE protects JSON extraction even when an unrelated ledger row is malformed.
// Embed only in queries that bind the run table as r. The importer writes
// detail.runHash; holds are persistent exclusions, with no implicit expiry.
export const ELIGIBLE_RUN_SQL = `NOT EXISTS (
  SELECT 1 FROM ledger_event hold
  WHERE hold.kind = 'canonical_hold'
    AND json_type(CASE WHEN json_valid(hold.detail) THEN hold.detail ELSE '{}' END, '$.runHash') = 'text'
    AND json_extract(CASE WHEN json_valid(hold.detail) THEN hold.detail ELSE '{}' END, '$.runHash') = r.run_hash
)`;
