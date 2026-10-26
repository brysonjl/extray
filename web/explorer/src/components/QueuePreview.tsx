import { useQuery } from "@tanstack/react-query";
import { Link, NavLink } from "react-router-dom";
import type { AnalysisList } from "../../../../src/product/analysis-contract";
import { apiGet } from "../api";
import { useRole } from "../role";
import { Freshness, StatusBadge, waitingReason } from "./analysis";
import { ErrorNote, Spinner } from "./ui";
import "./queue-preview.css";

/** Shared by the navigation and catalog so both reflect the same snapshot. */
function useQueuePreview() {
  const { role, canAnalyses } = useRole();
  return useQuery({
    queryKey: ["analyses", role, "preview"],
    queryFn: () => apiGet<AnalysisList>("/api/analyses?status=active&sort=queue&pageSize=5", role),
    enabled: canAnalyses,
    refetchInterval: 10_000,
  });
}

export function QueueNavLink() {
  const { canAdmin, role } = useRole();
  const queue = useQueuePreview();
  if (!canAdmin || role !== "admin") return null;
  return <NavLink to="/analyses">
    Analysis queue
    {queue.data && !queue.isError ? <span className="queue-nav-count" aria-label={`${queue.data.total} active analyses`}>{queue.data.total.toLocaleString()}</span> : null}
  </NavLink>;
}

export default function QueuePreview() {
  const { canAnalyses, canAdmin, role } = useRole();
  const queue = useQueuePreview();
  if (!canAdmin || role !== "admin") return null;
  if (!canAnalyses) return <section className="queue-preview" aria-labelledby="queue-preview-title">
    <div className="queue-preview-heading"><h2 id="queue-preview-title">Analysis queue</h2><Link className="btn secondary" to="/analyses">Queue setup →</Link></div>
    <p className="queue-preview-empty">The running API does not advertise queue support. Stop and restart the Explorer API to load the current version, then reload this page.</p>
  </section>;
  const data = queue.data;
  return <section className="queue-preview" aria-labelledby="queue-preview-title">
    <div className="queue-preview-heading">
      <div>
        <h2 id="queue-preview-title">Analysis queue</h2>
        <p>{data ? `${data.counts.running.toLocaleString()} running · ${data.counts.queued.toLocaleString()} queued` : "Follow extensions waiting for analysis and running now."}</p>
      </div>
      <Link className="btn secondary" to="/analyses">View full queue →</Link>
    </div>
    {queue.isPending ? <Spinner label="Loading analysis queue…" /> : null}
    {queue.error ? <div className="queue-preview-error"><ErrorNote error={queue.error} /><span>{data ? "Showing the last successful snapshot." : "Queue status unavailable."}</span><button className="btn secondary" type="button" disabled={queue.isFetching} onClick={() => void queue.refetch()}>Try again</button></div> : null}
    {data?.rows.length ? <ul className="queue-preview-list">
      {data.rows.map((job) => <li key={job.jobId}>
        <Link to={`/analyses/${job.jobId}`}>
          <span className="queue-preview-identity"><strong>{job.name || job.storeId || "Unknown extension"}</strong><span>#{job.jobId}{job.name && job.storeId ? ` · ${job.storeId}` : ""}</span></span>
          <StatusBadge status={job.status} eligibility={job.eligibility} />
          <span className="queue-preview-reason">{waitingReason(job)}</span>
        </Link>
      </li>)}
    </ul> : data ? <p className="queue-preview-empty">No extensions are queued or running. <Link to="/submit">Start an analysis</Link> or <Link to="/analyses?status=history">view history</Link>.</p> : null}
    <div className="queue-preview-footer">
      <Freshness updatedAt={queue.dataUpdatedAt} fetching={queue.isFetching} failed={queue.isError} />
      {data && data.total > data.rows.length ? <Link to="/analyses">See all {data.total.toLocaleString()} active analyses →</Link> : null}
    </div>
  </section>;
}
