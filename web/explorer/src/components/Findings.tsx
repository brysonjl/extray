import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api";
import { useRole } from "../role";
import type { Finding, SourceSlice } from "../types";
import { parseFindingProse, splitFindingParagraph } from "./finding-prose";

/** Inline "code chamber" (exploration): a line window from the analyzed source
 *  tree, cited line highlighted. Depends on the tree still existing on the API
 *  host — a 404 is the normal outcome elsewhere, rendered as an honest note. */
function CodeView({
  storeId,
  reportId,
  file,
  line,
}: {
  storeId: string;
  reportId: string | null;
  file: string;
  line: number | null;
}) {
  const { role } = useRole();
  const bodyRef = useRef<HTMLDivElement>(null);
  const qs = new URLSearchParams({ path: file });
  if (line != null) qs.set("line", String(line));
  if (reportId) qs.set("report", reportId);
  const { data, error, isPending } = useQuery({
    queryKey: ["source", role, storeId, reportId, file, line],
    queryFn: () => apiGet<SourceSlice>(`/api/extensions/${storeId}/source?${qs.toString()}`, role),
    staleTime: Infinity,
    retry: false,
  });

  // Park the cited line mid-viewport once the slice arrives.
  useEffect(() => {
    const box = bodyRef.current;
    const hit = box?.querySelector<HTMLElement>(".code-line.hit");
    if (box && hit) box.scrollTop = hit.offsetTop - box.clientHeight / 2;
  }, [data]);

  return (
    <div className="code-view">
      <div className="code-head">
        <span className="path">
          {file}
          {line != null ? `:${line}` : ""}
        </span>
        {data ? (
          <span>
            lines {data.firstLine}–{data.firstLine + data.lines.length - 1} of {data.totalLines}
          </span>
        ) : null}
      </div>
      {isPending ? <div className="code-empty">Loading source…</div> : null}
      {error ? <div className="code-empty">Source not available — the analyzed tree isn't retained on this host.</div> : null}
      {data && line != null && line > data.totalLines ? (
        <div className="code-empty warn-text">
          Cited line {line} is beyond the current file ({data.totalLines} lines) — the local tree may have changed
          since analysis.
        </div>
      ) : null}
      {data ? (
        <div className="code-body" ref={bodyRef}>
          {data.lines.map((text, i) => {
            const n = data.firstLine + i;
            return (
              <div key={n} className={`code-line${n === line ? " hit" : ""}`}>
                <span className="ln">{n}</span>
                <span className="code-text">{text || " "}</span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function EvidenceItem({
  e,
  storeId,
  reportId,
}: {
  e: Finding["evidence"][number];
  storeId: string;
  reportId: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button className="ev-open" onClick={() => setOpen(!open)} aria-expanded={open}>
        {e.file}
        {e.line != null ? `:${e.line}` : ""}
      </button>
      {e.symbolOrSink ? (
        <>
          {" · "}
          <span className="ev-sink">{e.symbolOrSink}</span>
        </>
      ) : null}
      {open ? <CodeView storeId={storeId} reportId={reportId} file={e.file} line={e.line} /> : null}
    </li>
  );
}

/** Only explicit backticks are styled as code. Everything remains escaped text. */
function InlineText({ text }: { text: string }) {
  // Fences and multi-backtick code may contain literal template strings.
  if (text.includes("``")) return text;
  return text.split(/(`[^`\n]+`)/g).map((part, index) => (
    part.startsWith("`") && part.endsWith("`") && part.length > 2
      ? <code key={index}>{part.slice(1, -1)}</code>
      : part
  ));
}

export function FindingProse({ text }: { text: string }) {
  return (
    <div className="finding-prose">
      {parseFindingProse(text).map((block, index) => block.type === "paragraph" ? (
        <ProseParagraphs key={index} text={block.text} />
      ) : (
        <ol key={index}>
          {block.items.map((item, itemIndex) => <li key={itemIndex}><ProseParagraphs text={item} /></li>)}
        </ol>
      ))}
    </div>
  );
}

function ProseParagraphs({ text }: { text: string }) {
  return splitFindingParagraph(text).map((paragraph, index) => <p key={index}><InlineText text={paragraph} /></p>);
}

export function FindingBody({ f, storeId, reportId }: { f: Finding; storeId: string; reportId: string | null }) {
  const baseId = useId();
  const evidenceId = `${baseId}-evidence`;
  return (
    <div className="finding-body">
      {f.claimedMechanism?.trim() ? (
        <section className="finding-mechanism" aria-labelledby={`${baseId}-mechanism`}>
          <h4 id={`${baseId}-mechanism`} className="finding-label">Claimed mechanism</h4>
          <FindingProse text={f.claimedMechanism} />
        </section>
      ) : null}
      <section className="finding-analysis" aria-labelledby={`${baseId}-analysis`}>
        <div className="finding-section-heading">
          <h4 id={`${baseId}-analysis`} className="finding-label">Analysis</h4>
          {f.evidence.length > 0 ? (
            <a className="finding-source-jump" href={`#${evidenceId}`}>
              {f.evidence.length} source reference{f.evidence.length === 1 ? "" : "s"} ↓
            </a>
          ) : null}
        </div>
        <FindingProse text={f.detail?.trim() ? f.detail : "No detail recorded."} />
      </section>
      {f.evidence.length > 0 ? (
        <section className="finding-evidence" aria-labelledby={evidenceId}>
          <h4 id={evidenceId} tabIndex={-1} className="finding-label">
            Source references <span className="finding-evidence-count">{f.evidence.length}</span>
          </h4>
          <p className="finding-evidence-help">Select a file to inspect the cited source.</p>
          <ul className="evidence-list">
            {f.evidence.map((e, index) => <EvidenceItem key={index} e={e} storeId={storeId} reportId={reportId} />)}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export function FindingRow({ f, storeId, reportId }: { f: Finding; storeId: string; reportId: string | null }) {
  const [open, setOpen] = useState(false);
  const baseId = useId();
  const detailId = `${baseId}-detail`;
  return (
    <article className={`finding${open ? " is-open" : ""}`}>
      <h3 className="finding-heading">
        <button type="button" className="finding-row" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={detailId}>
          <span className="finding-heading-text">
            <span className="finding-title">{f.title || "(untitled finding)"}</span>
            <span className="finding-meta">
              <span className={`sev sev-${f.severity || "unknown"}`}>{f.severity || "unknown"}</span>
              {f.category ? <span>{f.category}</span> : null}
              {f.confidence ? <span>{f.confidence} confidence</span> : null}
            </span>
          </span>
          <svg className="finding-chevron" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
            <path d="m6 8 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </h3>
      <div className="finding-detail" id={detailId} hidden={!open}>
        {open ? <FindingBody f={f} storeId={storeId} reportId={reportId} /> : null}
      </div>
    </article>
  );
}

