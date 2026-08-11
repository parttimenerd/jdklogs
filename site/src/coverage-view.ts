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
  root.appendChild(renderCoverage(data, fires, mappings, rules, gc));
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
  gc: string
): HTMLElement {
  const sec = document.createElement("section");
  sec.className = "coverage";
  const { covered, partial, uncovered } = coverageBuckets(fires, indexMappingsByKind(mappings), rules);

  const h = document.createElement("h4");
  h.textContent = "JFR coverage";
  sec.appendChild(h);

  const bar = document.createElement("div");
  bar.className = "cov-summary";
  bar.innerHTML =
    `<span class="cov-covered">● ${covered.length} covered</span>` +
    `<span class="cov-partial">◐ ${partial.length} partial</span>` +
    `<span class="cov-uncovered">○ ${uncovered.length} uncovered</span>`;
  sec.appendChild(bar);

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

  if (uncovered.length > 0) {
    const gh = document.createElement("h4");
    gh.className = "gap-title";
    gh.textContent = `Uncovered sites — candidate JFR events (${uncovered.length})`;
    sec.appendChild(gh);

    // group uncovered by tag set for a compact worklist
    const byTagset = new Map<string, SiteJson[]>();
    for (const s of uncovered) {
      const k = [...s.tags].sort().join("+");
      const arr = byTagset.get(k) ?? [];
      arr.push(s);
      byTagset.set(k, arr);
    }
    const rows = [...byTagset.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [tagset, arr] of rows.slice(0, 20)) {
      sec.appendChild(renderGapGroup(data, tagset, arr, gc));
    }
  }
  return sec;
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
