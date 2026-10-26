// Small shared presentational pieces: tier badges, per-area signal chips,
// collapsible sections, safe external links. All report-derived strings render
// as text (React escaping); dangerouslySetInnerHTML is forbidden on this
// surface, and only http(s) URLs may become hrefs (plan §12).

import { useId, useState, type CSSProperties, type ReactNode } from "react";
import { PI_INJECTION_CAVEAT_TEXT } from "@pi/caveat";
import type { Signal, Tier } from "../types";

export function TierBadge({ tier, large }: { tier: Tier | null; large?: boolean }) {
  const t = tier ?? "inconclusive";
  return <span className={`tier-badge tier-${t} ${large ? "tier-large" : ""}`}>{t.replace("-", " ")}</span>;
}

const TIER_ABBR: Record<Tier, string> = {
  "high-risk": "HI",
  concerning: "C",
  inconclusive: "IN",
  "low-risk": "LO",
  clean: "CL",
};

/** Containment square — tier glyph tile at the head of catalog rows. Purely
 *  decorative (the tier badge next to the name carries the info), so hidden
 *  from assistive tech. */
export function Cbox({ tier }: { tier: Tier | null }) {
  const t = tier ?? "inconclusive";
  return (
    <div className={`cbox fg-${t}`} aria-hidden="true">
      <span className="corner tl" />
      <span className="corner tr" />
      <span className="corner bl" />
      <span className="corner br" />
      <span className="abbr">{TIER_ABBR[t]}</span>
    </div>
  );
}

/** Plain-language explainer for each risk dimension. Surfaced through the "?"
 *  tips in the detail glance so the axis labels aren't jargon — keyed by the
 *  canonical (lowercase) area name from the verdict contract. */
const AREA_INFO: Record<string, string> = {
  permissions:
    "What the extension can do and which sites it can touch — its declared Chrome permissions, host access, and risky combinations like running scripts on every site.",
  network:
    "Where the extension sends data — the external servers its code contacts, and whether any data exfiltration was verified in the source.",
  obfuscation:
    "Whether the code hides what it does — obfuscated code or dynamic execution (e.g. eval) that makes the extension hard to audit.",
  developer:
    "Who publishes the extension and how it updates — developer identity, trader status, hosting country, and whether updates come from outside the Web Store.",
};

/** Accessible hover/focus tooltip. The trigger is a real button so keyboard and
 *  screen-reader users reach it, and the bubble is linked via aria-describedby.
 *  align="end" opens the bubble leftward for cells near the right edge. */
export function InfoTip({ label, children, align = "start" }: { label: string; children: ReactNode; align?: "start" | "end" }) {
  const id = useId();
  return (
    <span className="infotip">
      <button type="button" className="infotip-trigger" aria-label={label} aria-describedby={id}>
        ?
      </button>
      <span id={id} role="tooltip" className={`infotip-bubble infotip-${align}`}>
        {children}
      </span>
    </span>
  );
}

/** Per-area intensity meter. Level reads three ways — fill width, color, and
 *  the spelled-out label — so hue is never the sole cue. With `describe`, each
 *  head grows a "?" tip explaining what the dimension measures (detail glance
 *  only; the catalog keeps the bare bars). */
export function SignalMeter({ signals, style, describe }: { signals: Signal[]; style?: CSSProperties; describe?: boolean }) {
  if (signals.length === 0) return null;
  const half = Math.ceil(signals.length / 2);
  return (
    <div className="signal-meter" style={style}>
      {signals.map((s, i) => {
        const info = AREA_INFO[s.area.toLowerCase()];
        return (
          <div className="meter-cell" key={s.area} title={describe ? undefined : s.note}>
            <div className="meter-head">
              <span className="meter-area">
                {s.area}
                {describe && info ? (
                  <InfoTip label={`What the ${s.area} signal measures`} align={i >= half ? "end" : "start"}>
                    {info}
                  </InfoTip>
                ) : null}
              </span>
              <span className={`lvl-${s.level}`}>{s.level}</span>
            </div>
            <div className="meter-track">
              <div className={`meter-fill lvl-${s.level}`} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

const DECISION: Record<Tier, { glyph: string; verb: string }> = {
  "high-risk": { glyph: "⚠", verb: "Investigate before allowing" },
  concerning: { glyph: "⚠", verb: "Review before allowing" },
  "low-risk": { glyph: "✓", verb: "Low risk — likely safe to allow" },
  clean: { glyph: "✓", verb: "No risk signals — safe to allow" },
  inconclusive: { glyph: "?", verb: "Inconclusive — verify manually" },
};

/** Decision-first readout for the detail glance: turns the tier into an
 *  allow/investigate call and counts the areas driving it. Replaces the
 *  abstract "N of M signal areas tripped". Tinted by tier via fg-*. */
export function RiskVerdict({ signals, tier }: { signals: Signal[]; tier: Tier | null }) {
  const t = tier ?? "inconclusive";
  const { glyph, verb } = DECISION[t];
  const total = signals.length;
  const high = signals.filter((s) => s.level === "high").length;
  const notable = signals.filter((s) => s.level === "notable").length;
  const low = signals.filter((s) => s.level === "low").length;
  const line = high
    ? `${high} of ${total} areas show strong risk signals`
    : notable
      ? `${notable} of ${total} areas worth a closer look`
      : low
        ? `Only minor signals across ${total} areas`
        : `No risk signals across ${total} areas`;
  return (
    <div className={`risk-verdict fg-${t}`}>
      <div className="risk-decision">
        <span className="risk-glyph" aria-hidden="true">
          {glyph}
        </span>
        <span>{verb}</span>
      </div>
      {total > 0 ? <div className="risk-subline">{line}</div> : null}
    </div>
  );
}

/** Compact key for the meter's four levels, with a tip spelling out each. */
export function LevelLegend() {
  return (
    <div className="level-legend">
      <span>levels</span>
      <span className="lvl-none">none</span>
      <span className="lvl-low">low</span>
      <span className="lvl-notable">notable</span>
      <span className="lvl-high">high</span>
      <InfoTip label="What the risk levels mean" align="end">
        <b className="lvl-none">none</b> — nothing notable · <b className="lvl-low">low</b> — present but expected ·{" "}
        <b className="lvl-notable">notable</b> — worth a look · <b className="lvl-high">high</b> — strong risk signal
      </InfoTip>
    </div>
  );
}

/** Containment frame with the animated scanline — the "under active analysis"
 *  motif. CSS freezes the scanline under prefers-reduced-motion. */
export function ScanFrame({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="scan-frame" style={style}>
      <span className="corner tl" />
      <span className="corner tr" />
      <span className="corner bl" />
      <span className="corner br" />
      <div className="scanline" />
      {children}
    </div>
  );
}

export function Ring() {
  return <span className="ring" aria-hidden="true" />;
}

export function Section({
  title,
  count,
  children,
  defaultOpen = false,
}: {
  title: string;
  count?: number | string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <section className="panel">
      <button className="panel-header" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={bodyId}>
        <span className="panel-caret">{open ? "▾" : "▸"}</span>
        <span className="panel-title">{title}</span>
        {count !== undefined ? <span className="panel-count">{count}</span> : null}
      </button>
      {open ? (
        <div className="panel-body" id={bodyId}>
          {children}
        </div>
      ) : null}
    </section>
  );
}

/** External link that only ever emits http(s) hrefs — an ingested report can't
 *  smuggle a javascript: URL through here. Non-http values render as text. */
export function SafeLink({ href, children }: { href: string; children?: ReactNode }) {
  if (!/^https?:\/\//i.test(href)) return <span>{children ?? href}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children ?? href}
    </a>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="spinner">
      <Ring /> {label ?? "Loading…"}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : String(error);
  return <div className="error-note">⚠ {msg}</div>;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
}

export function formatUsd(v: number | null | undefined): string {
  return v == null ? "—" : `$${v.toFixed(3)}`;
}

export function formatTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** The one place the synthetic marker is rendered. Every surface that can show
 *  a corpus sample must use it: a mutant we wrote being mistaken for a real
 *  extension is the worst failure mode this product has. */
export function SyntheticBadge({ sample }: { sample?: string | null }) {
  return (
    <span className="synthetic-badge" title={`ExtRay test fixture${sample ? ` (${sample})` : ""} — findings apply only to this fixture`}>
      synthetic test fixture
    </span>
  );
}

/** The pi arm's injection caveat, verbatim from the one shared constant. Shown
 *  wherever a run can be started, because pi is the default arm. */
export function PiCaveat() {
  return (
    <div className="pi-caveat hint warn-text" role="note">
      <strong>Warning - prompt injection (pi arm, the default).</strong> {PI_INJECTION_CAVEAT_TEXT}
    </div>
  );
}
