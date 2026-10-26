// Catalog — search + browse (plan §7). Default sort is risk-descending: a
// reviewer's queue, worst first. Filter/search state lives in the URL so a
// filtered view is shareable. Admin rows add pipeline + cost columns; the User
// payload simply doesn't carry them.

import { useMutation, useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { apiGet, apiPost } from "../api";
import { useRole } from "../role";
import { Cbox, ErrorNote, SignalMeter, Spinner, SyntheticBadge, TierBadge, formatDate, formatUsd } from "../components/ui";
import type { CatalogResult, Meta, Stats, Tier } from "../types";
import QueuePreview from "../components/QueuePreview";

// Facet values stay canonical (they go in the URL / API); these map them to the
// friendlier text shown in the dropdowns. Unknown values fall back to the raw key.
const CAPABILITY_LABELS: Record<string, string> = {
  "cookies": "cookies",
  "all-sites": "all-sites (host access)",
  "injects-code": "injects code (scripting)",
  "intercepts-network": "intercepts network",
  "native-messaging": "native messaging",
  "downloads": "downloads",
  "reads-history": "reads history",
  "remote-code": "remote code",
  "obfuscated": "obfuscated",
};
const PUBLISHER_LABELS: Record<string, string> = {
  "trader": "registered trader",
  "high-risk-country": "high-risk country",
  "non-store-update": "side-loaded update",
};
const FINDING_TYPE_LABELS: Record<string, string> = {
  "malicious": "malicious",
  "vulnerability": "vulnerability",
  "unwanted": "unwanted",
  "risky-capability": "risky capability",
};
const label = (map: Record<string, string>, value: string) => map[value] ?? value;

/** Offered when the catalog is empty: populate it from the labeled synthetic
 *  corpus that ships with the repo. Offline (committed replay fixtures), free,
 *  and every row it creates is badged synthetic — an empty page teaches a
 *  newcomer nothing about what this tool produces. */
function CorpusIngest() {
  const { role } = useRole();
  const qc = useQueryClient();
  const { data: meta } = useQuery({ queryKey: ["meta", role], queryFn: () => apiGet<Meta>("/api/meta", role) });
  const ingest = useMutation({
    mutationFn: () => apiPost<{ ingested: string[]; skipped: { sample: string; reason: string }[] }>("/api/corpus/ingest", role, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["catalog"] });
      void qc.invalidateQueries({ queryKey: ["stats"] });
    },
  });
  // Advertised by the server only where the capability is actually wired.
  if (!meta?.corpusIngest) return null;

  return (
    <div className="corpus-ingest">
      <p>
        Nothing analyzed yet. You can fill the catalog with the <strong>labeled synthetic corpus</strong> that ships
        with this repo — 11 derived test fixtures, each with a committed answer key. It replays
        committed fixtures, so it runs offline, needs no API key, and costs nothing. Every row is badged{" "}
        <em>synthetic test fixture</em>.
      </p>
      <button className="btn" disabled={ingest.isPending} onClick={() => ingest.mutate()}>
        {ingest.isPending ? "Ingesting…" : "Ingest the synthetic corpus"}
      </button>
      {ingest.error ? <ErrorNote error={ingest.error} /> : null}
      {ingest.data ? (
        <p className="faint">
          Ingested {ingest.data.ingested.length} sample{ingest.data.ingested.length === 1 ? "" : "s"}.
          {ingest.data.skipped.length > 0
            ? ` Skipped ${ingest.data.skipped.length} with no committed fixture for this arm: ${ingest.data.skipped
                .map((s) => s.sample)
                .join(", ")}.`
            : ""}
        </p>
      ) : null}
    </div>
  );
}

function StatTiles() {
  const { role } = useRole();
  const { data } = useQuery({
    queryKey: ["stats", role],
    queryFn: () => apiGet<Stats>("/api/stats", role),
  });
  if (!data) return null;
  const tiers = ["high-risk", "concerning", "inconclusive", "low-risk", "clean"];
  return (
    <div className="stat-tiles">
      <div className="stat-tile">
        <div className="stat-num">{data.total}</div>
        <div className="stat-label">extensions assessed</div>
      </div>
      {tiers
        .filter((t) => data.byTier[t])
        .map((t) => (
          <div className="stat-tile" key={t}>
            <div className="stat-num">{data.byTier[t]}</div>
            <div className="stat-label">
              <TierBadge tier={t as Tier} />
            </div>
          </div>
        ))}
      {data.totalCostUsd !== undefined ? (
        <div className="stat-tile">
          <div className="stat-num">{formatUsd(data.totalCostUsd)}</div>
          <div className="stat-label">analysis spend (admin)</div>
        </div>
      ) : null}
    </div>
  );
}

export default function CatalogPage() {
  const { role } = useRole();
  const [params, setParams] = useSearchParams();

  const q = params.get("q") ?? "";
  const tier = params.get("tier") ?? "";
  const access = params.get("access") ?? "";
  const developer = params.get("developer") ?? "";
  const findingType = params.get("findingType") ?? "";
  const sort = params.get("sort") ?? "risk";
  const page = Number(params.get("page") ?? "1") || 1;

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "page") next.delete("page");
    setParams(next, { replace: true });
  };

  const queryString = new URLSearchParams({
    ...(q ? { q } : {}),
    ...(tier ? { tier } : {}),
    ...(access ? { access } : {}),
    ...(developer ? { developer } : {}),
    ...(findingType ? { findingType } : {}),
    sort,
    page: String(page),
    pageSize: "25",
  }).toString();

  const { data: meta } = useQuery({
    queryKey: ["meta", role],
    queryFn: () => apiGet<Meta>("/api/meta", role),
  });
  const { data, error, isPending } = useQuery({
    queryKey: ["catalog", role, queryString],
    queryFn: () => apiGet<CatalogResult>(`/api/catalog?${queryString}`, role),
    placeholderData: keepPreviousData,
  });

  const filtersActive = Boolean(q || tier || access || developer || findingType);
  const pages = data ? Math.max(Math.ceil(data.total / data.pageSize), 1) : 1;

  return (
    <div>
      <QueuePreview />
      {!filtersActive ? <StatTiles /> : null}
      <div className="search-row">
        <input
          type="search"
          placeholder="Search name, ID, or publisher…"
          value={q}
          onChange={(e) => setParam("q", e.target.value)}
        />
        <select value={tier} onChange={(e) => setParam("tier", e.target.value)}>
          <option value="">Tier: all</option>
          {(meta?.tiers ?? []).map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <select value={findingType} onChange={(e) => setParam("findingType", e.target.value)}>
          <option value="">Finding type: any</option>
          {(meta?.findingTypes ?? []).map((f) => (
            <option key={f} value={f}>{label(FINDING_TYPE_LABELS, f)}</option>
          ))}
        </select>
        <select value={access} onChange={(e) => setParam("access", e.target.value)}>
          <option value="">Capability: any</option>
          {(meta?.access ?? []).map((a) => (
            <option key={a} value={a}>{label(CAPABILITY_LABELS, a)}</option>
          ))}
        </select>
        <select value={developer} onChange={(e) => setParam("developer", e.target.value)}>
          <option value="">Publisher: any</option>
          {(meta?.developer ?? []).map((d) => (
            <option key={d} value={d}>{label(PUBLISHER_LABELS, d)}</option>
          ))}
        </select>
        <select value={sort} onChange={(e) => setParam("sort", e.target.value)}>
          <option value="risk">Sort: risk</option>
          <option value="recent">Sort: recent</option>
          <option value="name">Sort: name</option>
        </select>
      </div>

      {error ? <ErrorNote error={error} /> : null}
      {isPending ? <Spinner /> : null}

      {data && data.rows.length === 0 ? (
        <div className="empty">
          No extensions match.{" "}
          {role === "user" ? (
            <>
              Not in the catalog? <Link to="/submit">Submit it for analysis.</Link>
            </>
          ) : null}
          {data.total === 0 ? <CorpusIngest /> : null}
        </div>
      ) : null}

      <div className="catalog-list">
        {(data?.rows ?? []).map((r) => (
          <Link className="catalog-row" key={r.storeId} to={`/ext/${r.storeId}`}>
            <div className="scanline" />
            <Cbox tier={r.tier} />
            <div className="row-main">
              <div className="row-name">
                {r.name}
                {r.version ? <span className="row-version">v{r.version}</span> : null}{" "}
                <TierBadge tier={r.tier} />
                {r.synthetic ? <SyntheticBadge /> : null}
                {r.flags.isTrader ? <span className="row-version" title="registered trader">trader ✓</span> : null}
                {r.flags.highRiskCountry ? <span className="row-version warn-text">high-risk country</span> : null}
              </div>
              {r.synthetic ? <div className="mono row-version">{r.storeId}</div> : null}
              <div className="row-headline">{r.headline || "No rationale recorded."}</div>
              <SignalMeter signals={r.signals} style={{ maxWidth: 520 }} />
            </div>
            <div className="row-side">
              <div>{r.developerName ?? ""}</div>
              <div>assessed {formatDate(r.assessedAt)}</div>
              {r.pipeline ? (
                <div className="mono" title={r.pipeline.isFallback ? "fallback arm" : "pinned arm"}>
                  {r.pipeline.methodology} · {r.pipeline.model}
                  {r.pipeline.isFallback ? " (fallback)" : ""}
                </div>
              ) : null}
              {r.costUsd !== undefined ? <div>{formatUsd(r.costUsd)}</div> : null}
            </div>
          </Link>
        ))}
      </div>

      {data ? (
        <div className="result-meta">
          <span>
            Showing {data.rows.length} of {data.total} · sorted by {sort}
          </span>
          <span style={{ flex: 1 }} />
          {pages > 1 ? (
            <span className="pager">
              <button aria-label="Previous page" disabled={page <= 1} onClick={() => setParam("page", String(page - 1))}>‹</button>
              <span>
                {page} / {pages}
              </span>
              <button aria-label="Next page" disabled={page >= pages} onClick={() => setParam("page", String(page + 1))}>›</button>
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
