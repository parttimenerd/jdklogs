// SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
// SPDX-License-Identifier: GPL-2.0-only

import Prism from "prismjs";
import "prismjs/components/prism-clike";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import { Block, ghUrl, SiteJson, VersionData, VolumeStats } from "./types";

/**
 * Tab 1: firing sites grouped by file. Each block is one context snippet (sites in the same block
 * share it, resolved from data.blocks). We render the snippet with Prism C++ highlighting, mark the
 * firing lines, show the enclosing function + a GitHub permalink (derived from repo+commit), and
 * attach sample emissions. JFR-coverage information lives exclusively in the JFR coverage tab.
 *
 * Broad selectors (e.g. `all=trace`) can match every one of ~2600 sites; highlighting that many
 * blocks at once costs ~1s and ~180k DOM nodes. We cap the initial render at BLOCK_CAP blocks and
 * offer a "render all" button, so the common case stays instant without hiding data.
 */
const BLOCK_CAP = 300;

export function renderFiringSites(
  root: HTMLElement,
  data: VersionData,
  fires: SiteJson[],
  gc: string
): void {
  root.innerHTML = "";
  if (fires.length === 0) {
    const d = document.createElement("div");
    d.className = "note";
    d.textContent = "No log sites fire for this config.";
    root.appendChild(d);
    return;
  }

  const header = document.createElement("div");
  header.className = "results-header";
  const summary = document.createElement("span");
  summary.textContent = fires.length + " firing site(s)";
  header.appendChild(summary);

  // Collapse/expand-all toggle for the per-file sections (broad configs list dozens of files).
  const toggleAll = document.createElement("button");
  toggleAll.type = "button";
  toggleAll.className = "collapse-all-btn";
  toggleAll.textContent = "Collapse all";
  toggleAll.addEventListener("click", () => {
    const groups = [...root.querySelectorAll<HTMLDetailsElement>(".file-group")];
    const anyOpen = groups.some((g) => g.open);
    for (const g of groups) g.open = !anyOpen;
    toggleAll.textContent = anyOpen ? "Expand all" : "Collapse all";
  });
  header.appendChild(toggleAll);
  root.appendChild(header);

  const byFile = new Map<string, SiteJson[]>();
  for (const s of fires) {
    const arr = byFile.get(s.file) ?? [];
    arr.push(s);
    byFile.set(s.file, arr);
  }

  // Flatten to (file, representative-site, block-sites) render units, deduped by blockId, so we can
  // cap on blocks rather than files (a single file may hold dozens of distinct context blocks).
  const units: { file: string; rep: SiteJson; blockSites: SiteJson[] }[] = [];
  for (const [file, sites] of [...byFile.entries()].sort()) {
    const seen = new Set<string>();
    for (const s of sites) {
      if (seen.has(s.blockId)) continue;
      seen.add(s.blockId);
      units.push({ file, rep: s, blockSites: sites.filter((x) => x.blockId === s.blockId) });
    }
  }

  const renderUpTo = (limit: number): void => {
    let curFile = "";
    let fileEl: HTMLElement | null = null;
    for (const u of units.slice(0, limit)) {
      if (u.file !== curFile) {
        curFile = u.file;
        fileEl = document.createElement("details");
        fileEl.className = "file-group";
        (fileEl as HTMLDetailsElement).open = true;
        const h = document.createElement("summary");
        h.className = "file-name";
        const path = document.createElement("code");
        path.className = "file-path";
        path.textContent = u.file;
        // The <summary> toggles on click, which would clobber text selection of the path. Let the
        // path be selectable/copyable by swallowing clicks on it (the chevron still toggles).
        path.addEventListener("click", (e) => e.preventDefault());
        h.appendChild(path);
        const n = byFile.get(u.file)!.length;
        const count = document.createElement("span");
        count.className = "file-count";
        count.textContent = `${n} log statement${n === 1 ? "" : "s"}`;
        h.appendChild(count);
        fileEl.appendChild(h);
        root.appendChild(fileEl);
      }
      fileEl!.appendChild(renderBlock(data, data.blocks[u.rep.blockId], u.rep, u.blockSites, gc));
    }
  };

  if (units.length <= BLOCK_CAP) {
    renderUpTo(units.length);
    return;
  }

  // Capped: render the first BLOCK_CAP blocks, offer to render the rest on demand.
  summary.textContent = `${fires.length} firing site(s) — showing first ${BLOCK_CAP} of ${units.length} context blocks`;
  const more = document.createElement("button");
  more.type = "button";
  more.className = "render-all-btn";
  more.textContent = `Render all ${units.length} blocks (may be slow)`;
  more.addEventListener("click", () => {
    more.remove();
    // clear the capped render and re-render everything
    root.querySelectorAll(".file-group").forEach((el) => el.remove());
    renderUpTo(units.length);
    summary.textContent = fires.length + " firing site(s)";
  });
  header.appendChild(more);
  renderUpTo(BLOCK_CAP);
}

function renderBlock(
  data: VersionData,
  block: Block,
  rep: SiteJson,
  blockSites: SiteJson[],
  gc: string
): HTMLElement {
  const blockEl = document.createElement("div");
  blockEl.className = "block";

  const meta = document.createElement("div");
  meta.className = "block-meta";
  if (rep.funcSignature) {
    const fn = document.createElement("code");
    fn.className = "func-sig";
    fn.textContent = rep.funcSignature;
    meta.appendChild(fn);
  }
  const link = document.createElement("a");
  link.className = "gh-link";
  link.href = ghUrl(data, block);
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "L" + block.startLine + "-" + block.endLine + " on GitHub";
  meta.appendChild(link);

  const chips = document.createElement("span");
  chips.className = "chips";
  const uniq = new Map<string, SiteJson>();
  for (const s of blockSites) uniq.set(s.level + "|" + s.tags.join("+"), s);
  for (const [, s] of uniq) {
    const c = document.createElement("span");
    c.className = "chip lvl-" + s.level;
    c.textContent = s.level + " " + s.tags.join("+");
    chips.appendChild(c);
  }
  meta.appendChild(chips);
  blockEl.appendChild(meta);

  blockEl.appendChild(renderSnippet(block, blockSites, gc));

  // Under each snippet: a collapsible with example emitted log lines and an approximate lines/hour
  // rate, extrapolated from the Renaissance benchmark run for this GC. Absent when nothing was
  // captured for this GC — an empty "no example" row is noise, so we omit it entirely.
  const examples = renderExamples(blockSites, data.volumeStats, gc);
  if (examples) blockEl.appendChild(examples);

  return blockEl;
}

/** Approximate emitted lines/hour for a block's (level,tagset) buckets, from the benchmark run. */
function linesPerHour(blockSites: SiteJson[], vol: VolumeStats, gc: string): number {
  const wall = vol.benchWallSeconds[gc] ?? 0;
  if (wall <= 0) return 0;
  const keys = new Set(blockSites.map((s) => `${s.level},${[...s.tags].sort().join("+")}`));
  let lines = 0;
  for (const key of keys) {
    const v = vol.perTagset[key]?.[gc];
    if (v) lines += v.lines;
  }
  return (lines / wall) * 3600;
}

function fmtRate(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return Math.round(n).toString();
}

/** Collapsible showing example emitted log lines + an approximate lines/hour rate for the block.
 *  Returns null when nothing was captured for this GC — the caller omits the row entirely. */
function renderExamples(blockSites: SiteJson[], vol: VolumeStats, gc: string): HTMLElement | null {
  const samples = collectSamples(blockSites, gc);
  if (samples.length === 0) return null;
  const rate = linesPerHour(blockSites, vol, gc);

  const details = document.createElement("details");
  details.className = "examples";

  const summary = document.createElement("summary");
  summary.className = "examples-head";
  const parts: string[] = [`${samples.length} example log line(s)`];
  if (rate > 0) parts.push(`≈ ${fmtRate(rate)} lines/hour (${gc}, Renaissance)`);
  summary.textContent = parts.join(" · ");
  details.appendChild(summary);

  const box = document.createElement("pre");
  box.className = "examples-box";
  box.textContent = samples.join("\n");
  details.appendChild(box);

  return details;
}

/** Render a highlighted snippet with firing lines marked and per-line hover samples. */
export function renderSnippet(block: Block, blockSites: SiteJson[], gc: string): HTMLElement {
  const pre = document.createElement("pre");
  pre.className = "snippet language-cpp";
  const lines = block.snippet.split("\n");
  const firing = new Set(block.firingLineOffsets);

  lines.forEach((line, i) => {
    const row = document.createElement("div");
    row.className = "code-line" + (firing.has(i) ? " firing" : "");
    const html = Prism.highlight(line, Prism.languages.cpp, "cpp");
    row.innerHTML = html || "&nbsp;";
    if (firing.has(i)) {
      const s = blockSites[0];
      const ex = collectSamples([s], gc);
      if (ex.length > 0) {
        row.title = "Sample:\n" + ex.slice(0, 3).join("\n");
        row.classList.add("has-sample");
      }
    }
    pre.appendChild(row);
  });
  return pre;
}

function collectSamples(sites: SiteJson[], gc: string): string[] {
  const out: string[] = [];
  for (const s of sites) {
    const arr = s.samples[gc] ?? [];
    for (const line of arr) if (!out.includes(line)) out.push(line);
  }
  return out;
}
