export interface AnalysisOutcome {
  artifact_generated: true;
  investigation: "complete" | "incomplete";
  final_submission: "accepted" | "not-accepted";
  reasons: string[];
}

// Mirrors of the API DTOs (src/product/dto.ts / plan §14.3). Admin-only fields
// are optional here because the server omits them from User payloads.

export type Role = "user" | "admin";
export type Tier = "clean" | "low-risk" | "concerning" | "high-risk" | "inconclusive";
export type Level = "none" | "low" | "notable" | "high";

export interface Signal {
  area: string;
  level: Level;
  note?: string;
}

export interface Pipeline {
  methodology: string;
  model: string;
  isFallback: boolean;
}

export interface CatalogRow {
  storeId: string;
  /** A labeled corpus sample, not a real extension — always badged. */
  synthetic: boolean;
  name: string;
  version: string | null;
  tier: Tier | null;
  headline: string;
  signals: Signal[];
  developerName: string | null;
  flags: { isTrader?: boolean; highRiskCountry?: boolean; nonStoreUpdate?: boolean };
  access: string[];
  findingTypes: string[];
  assessedAt: string;
  pipeline?: Pipeline;
  costUsd?: number | null;
  tokens?: { input: number; output: number };
}

export interface CatalogResult {
  rows: CatalogRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Finding {
  id: string;
  number: number | null;
  severity: "critical" | "high" | "medium" | "low" | "info" | "positive" | "";
  confidence: string | null;
  category: string;
  kind: string;
  title: string;
  detail: string;
  claimedMechanism: string | null;
  evidence: { file: string; line: number | null; symbolOrSink: string | null }[];
}

export interface ExtensionDetail {
  skillReview?: {
    harness: string;
    model: string;
    sessionId: string | null;
    skillVersion: string;
    sourceSha256: string;
    reviewSha256: string;
    investigation: string;
    candidates: Finding[];
    coverage: { dimension: string; status: string; note: string; checksRun: string[] }[];
  };
  identity: {
    storeId: string;
    name: string;
    version: string | null;
    manifestVersion: number | null;
    synthetic: boolean;
    sample: string | null;
  };
  verdict: { tier: Tier | null; headline: string; rationale: string; signals: Signal[] };
  provenance: {
    reportId?: number;
    assessedAt: string;
    engineVersion: string | null;
    pipeline?: Pipeline & { think: string | null; mode: string | null; gitSha: string | null };
  };
  partialAnalysis: boolean;
  outcome?: AnalysisOutcome;
  unparsedFiles: string[];
  summaries: { layperson: string; technical: string };
  descriptionDeviation: { statedPurpose: string; deviates: boolean | null } | null;
  findings: Finding[];
  permissions: {
    api: {
      permission: string;
      optional: boolean;
      status: string;
      totalUsage: number;
      description?: string;
      usagePlain?: string;
      docUrl?: string;
      installWarning?: string;
    }[];
    hostsRequired: string[];
    hostsOptional: string[];
    hostsPlain?: string;
    dangerousCombinations: { kind: string; evidence: string[] }[];
  };
  destinations: {
    rows: {
      host: string;
      references: number;
      anyDynamic: boolean;
      reachedVia: string[];
      party?: string;
      exampleSites?: { path: string; line: number | null; role: string | null }[];
    }[];
    unresolvedCount: number;
  };
  obfuscation: { flagged: { path: string }[] };
  developer: {
    name: string | null;
    website: string | null;
    country: string | null;
    isTrader: boolean | null;
    highRiskCountry: boolean | null;
    nonStoreUpdate: boolean | null;
  };
  excludedClaims: { id: string; title: string; reason: string; detail: string }[];
  dismissals: { concern: string; note: string | null; checksRun: string[] }[];
  structuralLimits: string[];
  cost?: { usd: number | null; inputTokens: number | null; outputTokens: number | null };
  otherAnalyses?: { reportId: number; methodology: string; model: string; tier: Tier | null; assessedAt: string; isCanonical: boolean }[];
}

/** Line window from GET /api/extensions/:storeId/source — the evidence viewer.
 *  Served only where the analyzed tree still exists locally; 404 elsewhere. */
export interface SourceSlice {
  path: string;
  firstLine: number;
  lines: string[];
  totalLines: number;
}

export interface Submission {
  jobId: number;
  status: "queued" | "running" | "succeeded" | "failed";
  storeId: string | null;
  createdAt: string;
  error?: string;
  resultStoreId?: string;
  costUsd?: number | null;
}

export interface SubmissionExists {
  existing: true;
  storeId: string;
}

export interface Stats {
  total: number;
  byTier: Record<string, number>;
  lastAssessed: string | null;
  totalCostUsd?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  byPipeline?: Record<string, number>;
}

export interface Meta {
  /** Admin queue and runner visibility, advertised by the server. */
  analyses?: boolean;
  analysisConfiguration?: boolean;
  tiers: Tier[];
  access: string[];
  developer: string[];
  findingTypes: string[];
  sorts: string[];
  severities: string[];
  roles?: Role[];
  /** Present only under the admin lens on a LOCAL server: the Discover view. */
  discover?: boolean;
  /** Present only under the admin lens on a LOCAL server: the Settings view. */
  settings?: boolean;
  /** Present only under the admin lens on a LOCAL server: corpus ingest. */
  corpusIngest?: boolean;
}

// ---- Settings (local-only admin view) ---------------------------------------
// Mirrors PublicSettings in src/product/settings.ts. There is no apiKey field
// and there never should be: the key lives server-side in a gitignored file and
// the API reports only whether one is set.

export interface SettingsPayload {
  methodology: string;
  model: string;
  provider: { id: string; baseUrl: string | null };
  apiKeySet: boolean;
  apiKeyFromEnv: boolean;
  modelStatus: "recommended" | "caution" | "untested";
  choices: {
    methodologies: string[];
    providers: string[];
    models: { family: string; status: string; note: string; unavailable?: { provider: string; since: string } }[];
  };
  /** Absolute path of the settings file, so the user knows where the key is. */
  path: string;
}

// ---- Discover & Analyze (local-only admin view) -----------------------------

export interface DiscoverCandidate {
  storeId: string;
  name: string | null;
  installs: number | null;
  rating: number | null;
  ratingCount: number | null;
  category: string | null;
  languages: string[] | null;
  source: "extpose" | "webstore";
  ref: string;
}

export interface DiscoverResponse {
  candidates: DiscoverCandidate[];
  skippedAnalyzed: number;
  droppedNoStoreId: number;
  total: number;
}

export interface BatchItem {
  jobId?: number;
  storeId: string;
  status: "queued" | "running" | "succeeded" | "failed";
  error?: string;
}

export interface BatchStatus {
  batchId: string;
  items: BatchItem[];
  done: boolean;
  startedAt: string;
  usage: string;
}
