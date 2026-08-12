// SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
// SPDX-License-Identifier: GPL-2.0-only

import Prism from "prismjs";
import "prismjs/components/prism-clike";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import { Block, ghUrl, SiteJson, VersionData, VolumeStats } from "./types";
import { copyToClipboard } from "./clipboard";
import { Presence, versionBadge } from "./versions";
import { mappingKey } from "./coverage";

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
  gc: string,
  initialQuery = "",
  onQueryChange?: (q: string) => void,
  blockLinkFor?: (blockId: string) => string,
  onExample?: (cfg: string) => void,
  presence?: Presence | null,
  versions?: string[]
): void {
  root.innerHTML = "";
  if (fires.length === 0) {
    const d = document.createElement("div");
    d.className = "note empty-state";
    const p = document.createElement("p");
    p.textContent = "No log sites fire for this config.";
    d.appendChild(p);
    const hint = document.createElement("p");
    hint.className = "empty-hint";
    hint.appendChild(document.createTextNode("Try a broader selector like "));
    const ex = document.createElement("a");
    ex.className = "empty-ex";
    ex.textContent = "gc*=info";
    if (onExample) ex.addEventListener("click", () => onExample("gc*=info"));
    hint.appendChild(ex);
    hint.appendChild(document.createTextNode(", or open the tag wizard to browse every logging category."));
    d.appendChild(hint);
    root.appendChild(d);
    return;
  }

  const header = document.createElement("div");
  header.className = "results-header";
  const summary = document.createElement("span");
  header.appendChild(summary);

  // Filter box: narrow the file list by path, log message, or tag/level (mirrors the Sample log
  // tab's search). Re-renders the list in place on input.
  const filter = document.createElement("input");
  filter.type = "search";
  filter.className = "sites-filter";
  filter.placeholder = "Filter by path, message, or tag…";
  header.appendChild(filter);

  // Collapse/expand-all toggle for the per-file sections (broad configs list dozens of files).
  const toggleAll = document.createElement("button");
  toggleAll.type = "button";
  toggleAll.className = "collapse-all-btn";
  toggleAll.textContent = "Expand all";
  toggleAll.addEventListener("click", () => {
    const groups = [...root.querySelectorAll<HTMLDetailsElement>(".file-group")];
    const anyOpen = groups.some((g) => g.open);
    for (const g of groups) g.open = !anyOpen;
    toggleAll.textContent = anyOpen ? "Expand all" : "Collapse all";
  });
  header.appendChild(toggleAll);

  // Sort order for the file groups: by firing-site count (busiest first, the default — highest signal
  // on top) or alphabetically by path. A small toggle so a user hunting a known file can switch.
  let sortByCount = true;
  const sortBtn = document.createElement("button");
  sortBtn.type = "button";
  sortBtn.className = "collapse-all-btn";
  sortBtn.textContent = "Sort: most sites";
  header.appendChild(sortBtn);
  root.appendChild(header);

  const byFile = new Map<string, SiteJson[]>();
  for (const s of fires) {
    const arr = byFile.get(s.file) ?? [];
    arr.push(s);
    byFile.set(s.file, arr);
  }

  // Flatten to (file, representative-site, block-sites) render units, deduped by blockId, so we can
  // cap on blocks rather than files (a single file may hold dozens of distinct context blocks).
  interface Unit { file: string; rep: SiteJson; blockSites: SiteJson[]; }
  let units: Unit[] = [];
  const buildUnits = (): void => {
    units = [];
    const fileEntries = [...byFile.entries()];
    fileEntries.sort(
      sortByCount
        ? (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])
        : (a, b) => a[0].localeCompare(b[0])
    );
    for (const [file, sites] of fileEntries) {
      const seen = new Set<string>();
      for (const s of sites) {
        if (seen.has(s.blockId)) continue;
        seen.add(s.blockId);
        units.push({ file, rep: s, blockSites: sites.filter((x) => x.blockId === s.blockId) });
      }
    }
  };
  buildUnits();

  // Chip filters: click a level to narrow the list without typing. Composes (AND) with the text
  // filter. Levels are the fixed five; we render only those with at least one firing site so a user
  // isn't offered a dead filter.
  const activeLevels = new Set<string>();
  const chipRow = document.createElement("div");
  chipRow.className = "chip-filter-row";
  const presentLevels = new Set(fires.map((s) => s.level));
  for (const lvl of ["trace", "debug", "info", "warning", "error"]) {
    if (!presentLevels.has(lvl as SiteJson["level"])) continue;
    const c = document.createElement("button");
    c.type = "button";
    c.className = "chip-filter lvl-" + lvl;
    c.dataset.level = lvl;
    c.textContent = lvl;
    c.addEventListener("click", () => {
      if (activeLevels.has(lvl)) { activeLevels.delete(lvl); c.classList.remove("active"); }
      else { activeLevels.add(lvl); c.classList.add("active"); }
      apply(filter.value);
    });
    chipRow.appendChild(c);
  }
  if (chipRow.children.length > 0) root.insertBefore(chipRow, root.children[1] ?? null);

  // A unit matches the filter if its file path, or ANY of its block-sites' message / level / tags,
  // contain the query (case-insensitive) — so a tag or message hit keeps the whole context block.
  const matchUnit = (u: Unit, q: string): boolean => {
    if (activeLevels.size > 0 && !u.blockSites.some((s) => activeLevels.has(s.level))) return false;
    if (!q) return true;
    if (u.file.toLowerCase().includes(q)) return true;
    return u.blockSites.some(
      (s) =>
        (s.formatString ?? "").toLowerCase().includes(q) ||
        s.level.toLowerCase().includes(q) ||
        s.tags.join("+").toLowerCase().includes(q)
    );
  };

  // Render a list of units into per-file <details> groups, capped at BLOCK_CAP with a "render all"
  // affordance. Clears any previously-rendered groups/buttons first so re-filtering is idempotent.
  const renderList = (list: Unit[], expand: boolean): void => {
    root.querySelectorAll(".file-group, .render-all-btn").forEach((el) => el.remove());

    const fileCountIn = (file: string) => list.filter((u) => u.file === file).length;

    const renderUpTo = (limit: number): void => {
      let curFile = "";
      let fileEl: HTMLElement | null = null;
      for (const u of list.slice(0, limit)) {
        if (u.file !== curFile) {
          curFile = u.file;
          fileEl = document.createElement("details");
          fileEl.className = "file-group";
          (fileEl as HTMLDetailsElement).open = expand;
          const h = document.createElement("summary");
          h.className = "file-name";
          const path = document.createElement("code");
          path.className = "file-path";
          path.textContent = u.file;
          // The <summary> toggles on click, which would clobber text selection of the path. Let the
          // path be selectable/copyable by swallowing clicks on it (the chevron still toggles).
          path.addEventListener("click", (e) => e.preventDefault());
          h.appendChild(path);
          const n = fileCountIn(u.file);
          const count = document.createElement("span");
          count.className = "file-count";
          count.textContent = `${n} log statement${n === 1 ? "" : "s"}`;
          h.appendChild(count);
          fileEl.appendChild(h);
          root.appendChild(fileEl);
        }
        fileEl!.appendChild(renderBlock(data, u.rep.blockId, data.blocks[u.rep.blockId], u.rep, u.blockSites, gc, blockLinkFor, presence, versions));
      }
    };

    const noun = "context block";
    if (list.length === 0) {
      const d = document.createElement("div");
      d.className = "file-group note";
      d.textContent = "No firing sites match this filter.";
      root.appendChild(d);
      return;
    }
    if (list.length <= BLOCK_CAP) {
      renderUpTo(list.length);
      return;
    }
    // Capped: render the first BLOCK_CAP blocks, offer to render the rest on demand.
    const more = document.createElement("button");
    more.type = "button";
    more.className = "render-all-btn";
    more.textContent = `Render all ${list.length} blocks (may be slow)`;
    more.addEventListener("click", () => {
      more.remove();
      root.querySelectorAll(".file-group").forEach((el) => el.remove());
      renderUpTo(list.length);
      updateSummary(list.length, list.length, noun);
    });
    header.appendChild(more);
    renderUpTo(BLOCK_CAP);
  };

  const updateSummary = (shown: number, total: number, noun: string): void => {
    if (shown < total) {
      summary.textContent = `${fires.length} firing site(s) — showing first ${shown} of ${total} ${noun}s`;
    } else {
      summary.textContent = `${fires.length} firing site(s)`;
    }
  };

  // Full render, then re-filter on each keystroke against the precomputed units. With no filter the
  // file groups render collapsed (74 expanded groups is a wall of code on load); a filter expands
  // the matching groups so the hits are visible without a second click.
  const apply = (query: string): void => {
    const q = query.trim().toLowerCase();
    onQueryChange?.(query);
    const filtering = q !== "" || activeLevels.size > 0;
    const list = filtering ? units.filter((u) => matchUnit(u, q)) : units;
    if (filtering) {
      summary.textContent = `${list.length} of ${units.length} context blocks match`;
    } else {
      updateSummary(Math.min(units.length, BLOCK_CAP), units.length, "context block");
    }
    renderList(list, filtering);
    toggleAll.textContent = filtering ? "Collapse all" : "Expand all";
  };

  filter.addEventListener("input", () => apply(filter.value));
  sortBtn.addEventListener("click", () => {
    sortByCount = !sortByCount;
    sortBtn.textContent = sortByCount ? "Sort: most sites" : "Sort: A–Z";
    buildUnits();
    apply(filter.value);
  });
  filter.value = initialQuery;
  apply(initialQuery);
}

function renderBlock(
  data: VersionData,
  blockId: string,
  block: Block,
  rep: SiteJson,
  blockSites: SiteJson[],
  gc: string,
  blockLinkFor?: (blockId: string) => string,
  presence?: Presence | null,
  versions?: string[]
): HTMLElement {
  const blockEl = document.createElement("div");
  blockEl.className = "block";
  blockEl.id = "block-" + blockId;

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

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "copy-src-btn";
  copyBtn.textContent = "Copy source";
  copyBtn.title = "Copy this snippet's source";
  copyBtn.addEventListener("click", () => copyToClipboard(block.snippet, copyBtn));
  meta.appendChild(copyBtn);

  if (blockLinkFor) {
    const linkBtn = document.createElement("button");
    linkBtn.type = "button";
    linkBtn.className = "block-link-btn";
    linkBtn.textContent = "Link";
    linkBtn.title = "Copy a shareable link to this block";
    linkBtn.addEventListener("click", () => copyToClipboard(blockLinkFor(blockId), linkBtn));
    meta.appendChild(linkBtn);
  }

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

  // Version-specific badge: mark blocks whose representative site is NOT present in every offered JDK
  // version (e.g. "new in head", "removed", "21 only"). Silent when uniform or when only one version
  // is offered — the common case, so no badge noise. presence is built after first paint (main.ts).
  if (presence && versions && versions.length > 1) {
    const key = mappingKey(rep.file, rep.funcSignature, rep.formatString);
    const inV = presence.get(key);
    const label = inV ? versionBadge(inV, versions) : null;
    if (label) {
      const vb = document.createElement("span");
      vb.className = "ver-badge";
      vb.textContent = label;
      vb.title = "This log statement is not present in every offered JDK version.";
      meta.appendChild(vb);
    }
  }
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
