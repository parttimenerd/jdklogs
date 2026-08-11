// SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
// SPDX-License-Identifier: GPL-2.0-only

import { classifySite, coverageBuckets, indexMappingsByKind } from "./coverage";
import { buildEventIndex } from "./reverse";
import { triggerJfcDownload } from "./jfc";
import { renderSnippet } from "./results";
import { CoverageRule, ghUrl, JfrMapping, SiteJson, VersionData, VolumeStats } from "./types";

/** Per-event rollup of estimated MB/hour and a few example log messages, from the firing sites. */
interface EventVolume {
  mbPerHour: number;
  examples: string[]; // distinct example log messages the event's sites emit
}

/** Human-friendly MB/hour: GB above 1024 MB, KB below 1 MB. */
function fmtMbPerHour(mb: number): string {
  if (mb >= 1024) return (mb / 1024).toFixed(1) + " GB";
  if (mb >= 1) return mb.toFixed(1) + " MB";
  return (mb * 1024).toFixed(0) + " KB";
}

/**
 * For each JFR event, sum the estimated MB/hour of the firing sites it covers (covered + partial) and
 * collect a few example log messages. MB/hour is apportioned from the benchmark's per-(level,tagset)
 * bytes, split evenly across the firing sites that share a bucket, then attributed to each site's
 * event. Best-effort: mirrors the Summary volume estimate, extrapolated from the benchmark wall-time.
 */
function eventVolumes(
  fires: SiteJson[],
  mappings: JfrMapping[],
  rules: CoverageRule[],
  volume: VolumeStats,
  gc: string
): Map<string, EventVolume> {
  const exact = indexMappingsByKind(mappings);
  const wall = volume.benchWallSeconds[gc] ?? 0;

  // How many firing sites share each (level,tagset) bucket, so we can split its bytes evenly.
  const bucketOf = (s: SiteJson) => `${s.level},${[...s.tags].sort().join("+")}`;
  const sitesPerBucket = new Map<string, number>();
  for (const s of fires) sitesPerBucket.set(bucketOf(s), (sitesPerBucket.get(bucketOf(s)) ?? 0) + 1);

  const out = new Map<string, EventVolume>();
  for (const s of fires) {
    const cov = classifySite(s, exact, rules);
    if (!cov.jfrEvent) continue;
    const ev = out.get(cov.jfrEvent) ?? { mbPerHour: 0, examples: [] };

    const byGc = volume.perTagset[bucketOf(s)];
    const v = byGc?.[gc];
    if (v && wall > 0) {
      const share = v.bytes / (sitesPerBucket.get(bucketOf(s)) ?? 1);
      ev.mbPerHour += (share / wall) * 3600 / (1024 * 1024);
    }

    const msg = s.formatString ?? "";
    if (msg && ev.examples.length < 4 && !ev.examples.includes(msg)) ev.examples.push(msg);

    out.set(cov.jfrEvent, ev);
  }
  return out;
}

/**
 * The dedicated "JFR coverage" tab: the coverage rollup (covered / partial / uncovered for the
 * firing sites) with downloadable `.jfc` configs, the uncovered gap worklist, and the reverse
 * "By JFR event" index. Moved out of the Summary tab so the transition-to-JFR story has room.
 */
export function renderCoverageTab(
  root: HTMLElement,
  data: VersionData,
  fires: SiteJson[],
  mappings: JfrMapping[],
  rules: CoverageRule[],
  gc: string
): void {
  root.innerHTML = "";

  const banner = document.createElement("div");
  banner.className = "jfr-experimental";
  banner.innerHTML =
    `<span class="jfr-exp-badge">Experimental</span>` +
    `The log&nbsp;→&nbsp;JFR mapping is derived from the JDK-25 event set and may be neither complete ` +
    `nor fully correct. Treat it as a starting point, not an authoritative equivalence.`;
  root.appendChild(banner);

  if (fires.length === 0) {
    const empty = document.createElement("div");
    empty.className = "note";
    empty.textContent =
      "No log sites fire for this config — nothing to map to JFR. Adjust the -Xlog selector above.";
    root.appendChild(empty);
    return;
  }

  const volumes = eventVolumes(fires, mappings, rules, data.volumeStats, gc);
  root.appendChild(renderCoverage(data, fires, mappings, rules, gc, volumes));
  root.appendChild(renderEventIndex(fires, mappings, rules, volumes));
}

/** Distinct JFR events that cover the firing sites (covered + partial, incl. related), for the dynamic .jfc. */
function firingEvents(fires: SiteJson[], mappings: JfrMapping[], rules: CoverageRule[]): string[] {
  const index = indexMappingsByKind(mappings);
  const set = new Set<string>();
  for (const s of fires) {
    const cov = classifySite(s, index, rules);
    if (cov.jfrEvent) set.add(cov.jfrEvent);
    for (const rel of cov.relatedEvents ?? []) set.add(rel);
  }
  return [...set].sort();
}

/** Every event named anywhere in the mapping data — the full static preset. */
function allMappedEvents(mappings: JfrMapping[], rules: CoverageRule[]): string[] {
  const set = new Set<string>();
  for (const m of mappings) {
    set.add(m.jfrEvent);
    for (const rel of m.relatedEvents ?? []) set.add(rel);
  }
  for (const r of rules) set.add(r.jfrEvent);
  return [...set].sort();
}

/**
 * The coverage rollup: how many firing sites are covered / partial / uncovered by a JFR event, the
 * `.jfc` download actions, then the uncovered set grouped by tag set — the worklist of log lines that
 * no JFR event captures, i.e. candidates for a new JFR event.
 */
function renderCoverage(
  data: VersionData,
  fires: SiteJson[],
  mappings: JfrMapping[],
  rules: CoverageRule[],
  gc: string,
  volumes: Map<string, EventVolume>
): HTMLElement {
  const sec = document.createElement("section");
  sec.className = "coverage";
  const { covered, partial, uncovered } = coverageBuckets(fires, indexMappingsByKind(mappings), rules);

  const h = document.createElement("h4");
  h.textContent = "JFR coverage";
  sec.appendChild(h);

  // Clickable rollup: each count toggles a shared detail panel below the bar. Covered/partial expand
  // to their sites grouped by covering JFR event; uncovered expands to the tag-set gap worklist.
  const bar = document.createElement("div");
  bar.className = "cov-summary";

  const detail = document.createElement("div");
  detail.className = "cov-detail hidden";

  const renderers: Record<string, () => HTMLElement> = {
    covered: () => renderBucketByEvent(covered, "covered", data, mappings, rules, volumes),
    partial: () => renderBucketByEvent(partial, "partial", data, mappings, rules, volumes),
    uncovered: () => renderUncovered(data, uncovered, gc),
  };
  let open = "";
  const counts: Record<string, number> = {
    covered: covered.length,
    partial: partial.length,
    uncovered: uncovered.length,
  };

  const toggle = (bucket: string, span: HTMLElement): void => {
    if (open === bucket) {
      open = "";
      detail.classList.add("hidden");
      detail.innerHTML = "";
      span.setAttribute("aria-expanded", "false");
      return;
    }
    open = bucket;
    detail.innerHTML = "";
    detail.appendChild(renderers[bucket]());
    detail.classList.remove("hidden");
    for (const el of bar.querySelectorAll<HTMLElement>("[data-bucket]")) {
      el.setAttribute("aria-expanded", el.dataset.bucket === bucket ? "true" : "false");
    }
  };

  for (const [bucket, glyph, cls] of [
    ["covered", "●", "cov-covered"],
    ["partial", "◐", "cov-partial"],
    ["uncovered", "○", "cov-uncovered"],
  ] as const) {
    const span = document.createElement("span");
    span.className = cls;
    span.dataset.bucket = bucket;
    span.setAttribute("role", "button");
    span.setAttribute("tabindex", "0");
    span.setAttribute("aria-expanded", "false");
    span.textContent = `${glyph} ${counts[bucket]} ${bucket}`;
    const fire = (): void => { if (counts[bucket] > 0) toggle(bucket, span); };
    span.addEventListener("click", fire);
    span.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fire(); }
    });
    if (counts[bucket] === 0) span.setAttribute("aria-disabled", "true");
    bar.appendChild(span);
  }
  sec.appendChild(bar);
  sec.appendChild(detail);

  // .jfc download actions
  const dyn = firingEvents(fires, mappings, rules);
  const actions = document.createElement("div");
  actions.className = "jfc-actions";
  if (dyn.length > 0) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "jfc-btn";
    b.textContent = `Download .jfc for these events (${dyn.length})`;
    b.addEventListener("click", () =>
      triggerJfcDownload(dyn, `jdklogs-${gc}.jfc`, {
        label: `jdklogs — events for this -Xlog config (${gc})`,
      })
    );
    actions.appendChild(b);
  }
  const all = allMappedEvents(mappings, rules);
  if (all.length > 0) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "jfc-btn jfc-btn-secondary";
    b.textContent = `Full preset — all mapped events (${all.length})`;
    b.addEventListener("click", () =>
      triggerJfcDownload(all, "jdklogs-full.jfc", { label: "jdklogs — all mapped JFR events" })
    );
    actions.appendChild(b);
  }
  if (actions.children.length > 0) sec.appendChild(actions);

  return sec;
}

/** jfrevents doc URL for an event name, matching the convention in jfr-mappings.json. */
function jfrUrl(event: string): string {
  return "https://sap.github.io/jfrevents/25.html#" + event.replace("jdk.", "").toLowerCase();
}

const EVENT_PREVIEW = 8;

/**
 * Covered/partial detail: the bucket's firing sites grouped by the JFR event that covers them. Each
 * group links to the event's jfrevents doc and lists the log line + GitHub source link per site.
 * For partials, the covering note and any related events are surfaced under the group head.
 */
function renderBucketByEvent(
  bucket: SiteJson[],
  state: "covered" | "partial",
  data: VersionData,
  mappings: JfrMapping[],
  rules: CoverageRule[],
  volumes: Map<string, EventVolume>
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "cov-bucket";
  const index = indexMappingsByKind(mappings);

  interface Group { event: string; url: string; note?: string; related?: string[]; sites: SiteJson[]; }
  const groups = new Map<string, Group>();
  for (const s of bucket) {
    const cov = classifySite(s, index, rules);
    const event = cov.jfrEvent ?? "(no specific event)";
    const url = cov.jfrEventsUrl ?? (cov.jfrEvent ? jfrUrl(cov.jfrEvent) : "");
    const g = groups.get(event) ?? { event, url, sites: [] };
    if (cov.note && !g.note) g.note = cov.note;
    if (cov.relatedEvents && !g.related) g.related = cov.relatedEvents;
    g.sites.push(s);
    groups.set(event, g);
  }
  const ordered = [...groups.values()].sort((a, b) => b.sites.length - a.sites.length);

  const siteLine = (s: SiteJson): HTMLElement => {
    const a = document.createElement("a");
    a.className = "evt-line";
    a.href = ghUrl(data, data.blocks[s.blockId]);
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = (s.formatString ?? s.file.split("/").pop() ?? s.file).slice(0, 90);
    a.title = s.file + " :: " + (s.funcSignature ?? "");
    return a;
  };

  for (const g of ordered) {
    const el = document.createElement("div");
    el.className = "evt-group";

    const head = document.createElement("div");
    head.className = "evt-head";
    if (g.url) {
      const link = document.createElement("a");
      link.className = "evt-name";
      link.href = g.url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = g.event;
      head.appendChild(link);
    } else {
      const name = document.createElement("span");
      name.className = "evt-name";
      name.textContent = g.event;
      head.appendChild(name);
    }
    const count = document.createElement("span");
    count.className = "evt-count";
    count.textContent = `${g.sites.length} log line${g.sites.length === 1 ? "" : "s"}`;
    head.appendChild(count);

    const vol = volumes.get(g.event);
    if (vol && vol.mbPerHour > 0) {
      const v = document.createElement("span");
      v.className = "evt-vol";
      v.textContent = `~${fmtMbPerHour(vol.mbPerHour)}/h`;
      v.title = "Estimated log volume these sites emit, extrapolated from the benchmark";
      head.appendChild(v);
    }
    el.appendChild(head);

    if (g.note) {
      const note = document.createElement("div");
      note.className = "evt-note";
      note.textContent = g.note;
      el.appendChild(note);
    }
    if (state === "partial" && g.related && g.related.length > 0) {
      const rel = document.createElement("div");
      rel.className = "evt-rel";
      rel.appendChild(document.createTextNode("also: "));
      for (const r of g.related) {
        const c = document.createElement("a");
        c.className = "chip evt-rel-chip";
        c.href = jfrUrl(r);
        c.target = "_blank";
        c.rel = "noopener";
        c.textContent = r;
        rel.appendChild(c);
      }
      el.appendChild(rel);
    }

    for (const s of g.sites.slice(0, EVENT_PREVIEW)) el.appendChild(siteLine(s));
    if (g.sites.length > EVENT_PREVIEW) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "gap-more";
      more.textContent = `… ${g.sites.length - EVENT_PREVIEW} more`;
      more.addEventListener("click", () => {
        const frag = document.createDocumentFragment();
        for (const s of g.sites.slice(EVENT_PREVIEW)) frag.appendChild(siteLine(s));
        el.insertBefore(frag, more);
        more.remove();
      });
      el.appendChild(more);
    }
    wrap.appendChild(el);
  }
  return wrap;
}

/** Uncovered detail: the candidate-JFR-event worklist, grouped by tag set (unchanged behaviour). */
function renderUncovered(data: VersionData, uncovered: SiteJson[], gc: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "cov-bucket";

  const gh = document.createElement("h4");
  gh.className = "gap-title";
  gh.textContent = `Uncovered sites — candidate JFR events (${uncovered.length})`;
  wrap.appendChild(gh);

  const byTagset = new Map<string, SiteJson[]>();
  for (const s of uncovered) {
    const k = [...s.tags].sort().join("+");
    const arr = byTagset.get(k) ?? [];
    arr.push(s);
    byTagset.set(k, arr);
  }
  const rows = [...byTagset.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [tagset, arr] of rows.slice(0, 20)) {
    wrap.appendChild(renderGapGroup(data, tagset, arr, gc));
  }
  return wrap;
}

const GAP_PREVIEW = 4;

/**
 * One uncovered tag-set group: a preview of representative sites (each a source link), an expandable
 * "… N more" that reveals the rest, and a "Show source" toggle that renders the highlighted snippet
 * for each site's context block. Snippets are built lazily on first expand to keep the tab light.
 */
function renderGapGroup(data: VersionData, tagset: string, arr: SiteJson[], gc: string): HTMLElement {
  const g = document.createElement("div");
  g.className = "gap-group";

  const head = document.createElement("div");
  head.className = "gap-head";
  head.innerHTML = `<span class="gap-tagset">${tagset}</span><span class="gap-count">${arr.length}</span>`;

  // "Show source" toggle for the whole group.
  const srcBtn = document.createElement("button");
  srcBtn.type = "button";
  srcBtn.className = "gap-src-btn";
  srcBtn.textContent = "Show source";
  head.appendChild(srcBtn);
  g.appendChild(head);

  const siteLink = (s: SiteJson): HTMLElement => {
    const a = document.createElement("a");
    a.className = "gap-site";
    a.href = ghUrl(data, data.blocks[s.blockId]);
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = (s.formatString ?? s.file.split("/").pop() ?? s.file).slice(0, 70);
    return a;
  };

  for (const s of arr.slice(0, GAP_PREVIEW)) g.appendChild(siteLink(s));

  // Expandable overflow: "… N more" reveals the remaining site links in place.
  if (arr.length > GAP_PREVIEW) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "gap-more";
    more.textContent = `… ${arr.length - GAP_PREVIEW} more`;
    more.addEventListener("click", () => {
      const frag = document.createDocumentFragment();
      for (const s of arr.slice(GAP_PREVIEW)) frag.appendChild(siteLink(s));
      g.insertBefore(frag, more);
      more.remove();
      // if sources are already shown, extend them to the newly revealed sites too
      if (srcShown) renderSources();
    });
    g.appendChild(more);
  }

  // Lazily-built source snippets, one per distinct context block in the group.
  let srcShown = false;
  let srcWrap: HTMLElement | null = null;
  const renderSources = (): void => {
    if (srcWrap) srcWrap.remove();
    srcWrap = document.createElement("div");
    srcWrap.className = "gap-src";
    const seen = new Set<string>();
    for (const s of arr) {
      if (seen.has(s.blockId)) continue;
      seen.add(s.blockId);
      const block = data.blocks[s.blockId];
      if (!block) continue;
      const blockSites = arr.filter((x) => x.blockId === s.blockId);
      srcWrap.appendChild(renderSnippet(block, blockSites, gc));
    }
    g.appendChild(srcWrap);
  };
  srcBtn.addEventListener("click", () => {
    srcShown = !srcShown;
    if (srcShown) { renderSources(); srcBtn.textContent = "Hide source"; }
    else { srcWrap?.remove(); srcWrap = null; srcBtn.textContent = "Show source"; }
  });

  return g;
}

/**
 * The reverse view: "I use JFR event X — which -Xlog lines does it replace?" Each referenced event
 * links to its jfrevents doc anchor, lists the log lines it covers 1:1 (verified), and shows how many
 * firing sites in its subsystem it relates to but does not capture line-for-line.
 */
function renderEventIndex(
  fires: SiteJson[],
  mappings: JfrMapping[],
  rules: CoverageRule[],
  volumes: Map<string, EventVolume>
): HTMLElement {
  const sec = document.createElement("section");
  sec.className = "event-index";
  const entries = buildEventIndex(mappings, rules, fires);

  const h = document.createElement("h4");
  h.textContent = "By JFR event";
  sec.appendChild(h);

  const withExact = entries.filter((e) => e.exact.length > 0 || e.partialCount > 0);
  if (withExact.length === 0) {
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = "No JFR event maps to the firing sites for this config.";
    sec.appendChild(note);
    return sec;
  }

  for (const e of withExact) {
    const g = document.createElement("div");
    g.className = "evt-group";

    const head = document.createElement("div");
    head.className = "evt-head";
    const link = document.createElement("a");
    link.className = "evt-name";
    link.href = e.jfrEventsUrl;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = e.event;
    head.appendChild(link);
    const count = document.createElement("span");
    count.className = "evt-count";
    const bits: string[] = [];
    if (e.exact.length > 0) bits.push(`${e.exact.length} log line${e.exact.length === 1 ? "" : "s"}`);
    if (e.partialCount > 0) bits.push(`${e.partialCount} partial`);
    count.textContent = bits.join(" · ");
    head.appendChild(count);

    const vol = volumes.get(e.event);
    if (vol && vol.mbPerHour > 0) {
      const v = document.createElement("span");
      v.className = "evt-vol";
      v.textContent = `~${fmtMbPerHour(vol.mbPerHour)}/h`;
      v.title = "Estimated log volume this event's firing sites emit, extrapolated from the benchmark";
      head.appendChild(v);
    }
    g.appendChild(head);

    for (const line of e.exact.slice(0, 6)) {
      const r = document.createElement("div");
      r.className = "evt-line";
      r.textContent = line.logLine;
      r.title = line.file + " :: " + line.function;
      g.appendChild(r);
    }
    if (e.exact.length > 6) {
      const more = document.createElement("div");
      more.className = "evt-more";
      more.textContent = `… ${e.exact.length - 6} more`;
      g.appendChild(more);
    }

    if (vol && vol.examples.length > 0) {
      const det = document.createElement("details");
      det.className = "evt-examples";
      const sum = document.createElement("summary");
      sum.textContent = `Example log messages (${vol.examples.length})`;
      det.appendChild(sum);
      for (const ex of vol.examples) {
        const r = document.createElement("div");
        r.className = "evt-example";
        r.textContent = ex;
        det.appendChild(r);
      }
      g.appendChild(det);
    }

    sec.appendChild(g);
  }
  return sec;
}
