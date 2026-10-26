// Discover & Analyze (local-only admin): build a discovery query with a form
// instead of remembering CLI flags, review the matched extensions in a table,
// select some, and launch real analyses — watched live. Backend routes:
// POST /api/discover, POST /api/analyze-batch, GET /api/analyze-batch/:id
// (all local-only; see src/server/app.ts + scripts/explorer-capabilities.ts).

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { apiGet, apiPost } from "../api";
import { useRole } from "../role";
import { ErrorNote, PiCaveat, Ring, SafeLink, Spinner, formatTokens } from "../components/ui";
import type { BatchStatus, DiscoverCandidate, DiscoverResponse } from "../types";

const EXTPOSE_COLLECTIONS = ["top-installed", "top-grossing", "featured", "new", "delisted"];
const SORTS = ["installs", "rating", "reviews", "none"];

const numOrUndef = (s: string): number | undefined => {
  const t = s.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
};

const compact = (n: number | null): string => (n == null ? "—" : formatTokens(n));

// Declared locales as a compact cell: "—" when unknown/none, else up to 4 codes
// with a "+N" overflow (full list is in the cell's title tooltip).
const langLabel = (langs: string[] | null): string => {
  if (!langs || langs.length === 0) return "—";
  return langs.length <= 4 ? langs.join(" ") : `${langs.slice(0, 4).join(" ")} +${langs.length - 4}`;
};

export default function DiscoverPage() {
  const { role, canDiscover } = useRole();

  // Query form state
  const [source, setSource] = useState<"extpose" | "webstore">("extpose");
  const [collection, setCollection] = useState("top-installed");
  const [webMode, setWebMode] = useState<"category" | "sitemap">("category");
  const [category, setCategory] = useState("");
  const [minInstalls, setMinInstalls] = useState("");
  const [maxInstalls, setMaxInstalls] = useState("");
  const [minRating, setMinRating] = useState("");
  const [maxRating, setMaxRating] = useState("");
  const [minReviews, setMinReviews] = useState("");
  const [sort, setSort] = useState("installs");
  const [limit, setLimit] = useState("50");
  const [enrich, setEnrich] = useState(false);
  const [excludeAnalyzed, setExcludeAnalyzed] = useState(true);
  const [excludeNonEnglish, setExcludeNonEnglish] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchId, setBatchId] = useState<string | null>(null);

  const webstoreNeedsCategory = source === "webstore" && webMode === "category" && category.trim() === "";

  const discover = useMutation({
    mutationFn: () => {
      const filters = {
        minInstalls: numOrUndef(minInstalls),
        maxInstalls: numOrUndef(maxInstalls),
        minRating: numOrUndef(minRating),
        maxRating: numOrUndef(maxRating),
        minReviews: numOrUndef(minReviews),
      };
      const base = { source, sort, limit: numOrUndef(limit) ?? 50, excludeAnalyzed, ...filters };
      const body =
        source === "extpose"
          ? { ...base, collection, category: category.trim() || undefined, enrich: false, excludeNonEnglish }
          : webMode === "sitemap"
            ? { ...base, collection: "sitemap", enrich }
            : { ...base, category: category.trim() || undefined, enrich };
      return apiPost<DiscoverResponse>("/api/discover", role, body);
    },
    onSuccess: (res) => {
      setBatchId(null);
      setSelected(new Set(res.candidates.map((c) => c.storeId))); // default: select all
    },
  });

  const launch = useMutation({
    mutationFn: (storeIds: string[]) => apiPost<{ batchId: string }>("/api/analyze-batch", role, { storeIds }),
    onSuccess: (res) => setBatchId(res.batchId),
  });

  // Re-attach to a still-running batch after navigating away and back: this
  // component's batchId is lost on unmount, but the server keeps the run — so on
  // return, adopt the newest active batch and resume showing its progress.
  const { data: activeBatches } = useQuery({
    queryKey: ["active-batches", role],
    queryFn: () => apiGet<{ batches: BatchStatus[] }>("/api/analyze-batch", role),
    enabled: canDiscover,
    refetchInterval: 5000,
    refetchIntervalInBackground: true,
  });
  useEffect(() => {
    if (!batchId && activeBatches?.batches?.length) setBatchId(activeBatches.batches[0]!.batchId);
  }, [activeBatches, batchId]);

  const candidates = discover.data?.candidates ?? [];
  const allSelected = candidates.length > 0 && selected.size === candidates.length;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(candidates.map((c) => c.storeId)));

  const onRun = (e: FormEvent) => {
    e.preventDefault();
    setBatchId(null);
    discover.mutate();
  };

  if (!canDiscover) {
    return (
      <div className="discover-page">
        <h1>Discover &amp; Analyze</h1>
        <p className="hint">
          This view is available only on the local Explorer server (<span className="mono">npm run explorer</span>) under
          the admin lens — it scrapes discovery sources and runs analyses on this machine.
        </p>
      </div>
    );
  }

  return (
    <div className="discover-page">
      <h1>Discover &amp; Analyze</h1>
      <p className="hint">
        Query a discovery source, review the matches, then launch analyses on the ones you pick. Runs the pinned
        production pipeline locally and records verdicts in the catalog.
      </p>
      <PiCaveat />

      <form className="discover-form" onSubmit={onRun}>
        <div className="form-grid">
          <label className="field">
            <span>Source</span>
            <select value={source} onChange={(e) => setSource(e.target.value === "webstore" ? "webstore" : "extpose")}>
              <option value="extpose">extpose</option>
              <option value="webstore">chrome web store</option>
            </select>
          </label>

          {source === "extpose" ? (
            <label className="field">
              <span>Collection</span>
              <select value={collection} onChange={(e) => setCollection(e.target.value)}>
                {EXTPOSE_COLLECTIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="field">
              <span>Mode</span>
              <select value={webMode} onChange={(e) => setWebMode(e.target.value === "sitemap" ? "sitemap" : "category")}>
                <option value="category">category</option>
                <option value="sitemap">sitemap (all)</option>
              </select>
            </label>
          )}

          <label className="field">
            <span>
              Category{" "}
              <span className="faint">
                {source === "extpose" ? "(optional; overrides collection)" : webMode === "category" ? "(group/sub)" : "(n/a)"}
              </span>
            </span>
            <input
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder={source === "extpose" ? "e.g. tools" : "e.g. productivity/tools"}
              disabled={source === "webstore" && webMode === "sitemap"}
              spellCheck={false}
            />
          </label>

          <label className="field">
            <span>Sort</span>
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              {SORTS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Min installs</span>
            <input value={minInstalls} onChange={(e) => setMinInstalls(e.target.value)} placeholder="e.g. 1000000" inputMode="numeric" />
          </label>
          <label className="field">
            <span>Max installs</span>
            <input value={maxInstalls} onChange={(e) => setMaxInstalls(e.target.value)} placeholder="—" inputMode="numeric" />
          </label>
          <label className="field">
            <span>Min rating</span>
            <input value={minRating} onChange={(e) => setMinRating(e.target.value)} placeholder="0–5" inputMode="decimal" />
          </label>
          <label className="field">
            <span>Max rating</span>
            <input value={maxRating} onChange={(e) => setMaxRating(e.target.value)} placeholder="0–5" inputMode="decimal" />
          </label>
          <label className="field">
            <span>Min reviews</span>
            <input value={minReviews} onChange={(e) => setMinReviews(e.target.value)} placeholder="e.g. 50" inputMode="numeric" />
          </label>
          <label className="field">
            <span>Limit</span>
            <input value={limit} onChange={(e) => setLimit(e.target.value)} inputMode="numeric" />
          </label>
        </div>

        <div className="form-checks">
          <label className="check">
            <input type="checkbox" checked={excludeAnalyzed} onChange={(e) => setExcludeAnalyzed(e.target.checked)} />
            Exclude already-analyzed
          </label>
          {source === "extpose" ? (
            <label className="check" title="Drop extensions whose declared locales lack English (rough foreign-market filter). Keeps ones that declare no locales.">
              <input type="checkbox" checked={excludeNonEnglish} onChange={(e) => setExcludeNonEnglish(e.target.checked)} />
              Exclude non-English
            </label>
          ) : null}
          {source === "webstore" ? (
            <label className="check" title="Chrome Web Store needs a detail fetch per id for installs/rating">
              <input type="checkbox" checked={enrich} onChange={(e) => setEnrich(e.target.checked)} />
              Enrich (fetch installs/rating)
            </label>
          ) : null}
          <span className="spacer" />
          <button className="btn" type="submit" disabled={discover.isPending || webstoreNeedsCategory}>
            {discover.isPending ? "Discovering…" : "Run discovery"}
          </button>
        </div>
        {webstoreNeedsCategory ? <p className="faint small">Enter a category (e.g. productivity/tools) or switch Mode to sitemap.</p> : null}
      </form>

      {discover.error ? <ErrorNote error={discover.error} /> : null}
      {discover.isPending ? <Spinner label="Scraping discovery source…" /> : null}

      {discover.data ? (
        <ResultsTable
          data={discover.data}
          candidates={candidates}
          selected={selected}
          allSelected={allSelected}
          toggle={toggle}
          toggleAll={toggleAll}
          onLaunch={() => launch.mutate([...selected])}
          launching={launch.isPending}
          launchError={launch.error}
        />
      ) : null}

      {batchId ? <BatchProgress batchId={batchId} /> : null}
    </div>
  );
}

function ResultsTable({
  data,
  candidates,
  selected,
  allSelected,
  toggle,
  toggleAll,
  onLaunch,
  launching,
  launchError,
}: {
  data: DiscoverResponse;
  candidates: DiscoverCandidate[];
  selected: Set<string>;
  allSelected: boolean;
  toggle: (id: string) => void;
  toggleAll: () => void;
  onLaunch: () => void;
  launching: boolean;
  launchError: unknown;
}) {
  return (
    <div className="results">
      <div className="results-head">
        <span>
          <strong>{candidates.length}</strong> matches
          {data.skippedAnalyzed > 0 ? <span className="faint"> · {data.skippedAnalyzed} already analyzed</span> : null}
          {data.droppedNoStoreId > 0 ? <span className="faint"> · {data.droppedNoStoreId} unresolved</span> : null}
        </span>
        <span className="spacer" />
        <button className="btn" onClick={onLaunch} disabled={launching || selected.size === 0}>
          {launching ? "Launching…" : `Analyze ${selected.size} selected`}
        </button>
      </div>
      {launchError ? <ErrorNote error={launchError} /> : null}

      {candidates.length === 0 ? (
        <p className="faint">No matches. Loosen the filters, raise the limit, or turn off “exclude already-analyzed”.</p>
      ) : (
        <div className="table-scroll">
          <table className="results-table">
            <thead>
              <tr>
                <th className="col-check">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="select all" />
                </th>
                <th>Name</th>
                <th className="num">Installs</th>
                <th className="num">Rating</th>
                <th className="num">Reviews</th>
                <th>Langs</th>
                <th>Store ID</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => (
                <tr key={c.storeId} className={selected.has(c.storeId) ? "sel" : ""} onClick={() => toggle(c.storeId)}>
                  <td className="col-check">
                    <input type="checkbox" checked={selected.has(c.storeId)} onChange={() => toggle(c.storeId)} onClick={(e) => e.stopPropagation()} />
                  </td>
                  <td className="col-name">{c.name ?? c.ref}</td>
                  <td className="num">{compact(c.installs)}</td>
                  <td className="num">{c.rating != null ? `★ ${c.rating}` : "—"}</td>
                  <td className="num">{compact(c.ratingCount)}</td>
                  <td className="faint small" title={c.languages?.join(" ") ?? ""}>{langLabel(c.languages)}</td>
                  <td className="mono col-id">
                    <SafeLink href={`https://chromewebstore.google.com/detail/${c.storeId}`}>{c.storeId.slice(0, 12)}…</SafeLink>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function BatchProgress({ batchId }: { batchId: string }) {
  const { role } = useRole();
  const { data, error } = useQuery({
    queryKey: ["analyze-batch", role, batchId],
    queryFn: () => apiGet<BatchStatus>(`/api/analyze-batch/${batchId}`, role),
    refetchInterval: (q) => (q.state.data?.done ? false : 3000),
    refetchIntervalInBackground: true,
  });

  const counts = useMemo(() => {
    const c = { queued: 0, running: 0, succeeded: 0, failed: 0 };
    for (const it of data?.items ?? []) c[it.status]++;
    return c;
  }, [data]);

  if (error) return <ErrorNote error={error} />;
  if (!data) return null;

  return (
    <div className="batch-progress" aria-live="polite">
      <h2>
        Analysis {data.done ? "complete" : "running"} {!data.done ? <Ring /> : null}
      </h2>
      <p className="batch-summary">
        {counts.succeeded} done · {counts.running} running · {counts.queued} queued
        {counts.failed > 0 ? <span className="lvl-high"> · {counts.failed} failed</span> : null}
      </p>
      <p className="faint small">{data.usage}</p>
      <ul className="batch-list">
        {data.items.map((it) => (
          <li key={it.storeId} className={`batch-item status-${it.status}`}>
            <span className="status-dot" />
            <span className="mono">{it.storeId}</span>
            <span className="batch-item-status">{it.status}</span>
            {it.status === "succeeded" ? <Link to={`/ext/${it.storeId}`}>view ›</Link> : null}
            {it.error ? <span className="faint batch-item-err">{it.error}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
