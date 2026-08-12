// SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
// SPDX-License-Identifier: GPL-2.0-only

import { VolumeEstimate, Warning } from "./analysis";
import { SiteJson } from "./types";

/** Renders the summary rollup: per-(level,tagset) counts+volume, per-file counts, warnings.
 *  onFile (if given) jumps to the Sites tab filtered to that file, so the file list isn't a dead
 *  duplicate of the Sites tab but a navigational index into it. */
export function renderSummary(
  root: HTMLElement,
  fires: SiteJson[],
  warnings: Warning[],
  volume: VolumeEstimate,
  onFile?: (file: string) => void
): void {
  root.innerHTML = "";

  if (fires.length === 0 && warnings.length === 0) {
    const empty = document.createElement("div");
    empty.className = "note";
    empty.textContent = "No log sites fire for this config — nothing to summarize. Adjust the -Xlog selector above.";
    root.appendChild(empty);
    return;
  }

  // warnings first
  if (warnings.length > 0) {
    const box = document.createElement("div");
    box.className = "warnings";
    const title = document.createElement("div");
    title.className = "warn-title";
    title.textContent = "This config may not do what you expect:";
    box.appendChild(title);
    for (const w of warnings) {
      const item = document.createElement("div");
      item.className = "warn-item";
      item.textContent = w.message;
      box.appendChild(item);
    }
    root.appendChild(box);
  }

  // volume estimate — headline + provenance only; the per-tagset MB/h split is folded into the
  // "By level + tag set" table below, so the number and the breakdown live together.
  const vol = document.createElement("div");
  vol.className = "volume";
  if (volume.hasData && volume.totalMbPerHour > 0) {
    const total = document.createElement("div");
    total.className = "vol-total";
    total.textContent = "≈ " + fmtMb(volume.totalMbPerHour) + " / hour (" + volume.gc + ")";
    vol.appendChild(total);
    const sub = document.createElement("div");
    sub.className = "vol-note";
    sub.textContent = "Extrapolated from a " + volume.wallSeconds.toFixed(0) + "s benchmark run; real volume varies with workload.";
    vol.appendChild(sub);
  } else {
    vol.className = "volume note";
    vol.textContent = "No volume estimate (no sample capture for this GC).";
  }
  root.appendChild(vol);

  // per (level,tagset): count + estimated MB/h side by side. The volume estimate keys tagsets as
  // "level,sorted+tags"; match that so we can attach a rate to each count row.
  const byTagset = new Map<string, number>();
  const byFile = new Map<string, number>();
  for (const s of fires) {
    const k = s.level + " · " + s.tags.join("+");
    byTagset.set(k, (byTagset.get(k) ?? 0) + 1);
    byFile.set(s.file, (byFile.get(s.file) ?? 0) + 1);
  }
  const rateOf = new Map<string, number>();
  for (const p of volume.perTagset) {
    const [lvl, tags] = [p.key.slice(0, p.key.indexOf(",")), p.key.slice(p.key.indexOf(",") + 1)];
    rateOf.set(lvl + " · " + tags, p.mbPerHour);
  }

  root.appendChild(tagsetTable("By level + tag set", byTagset, rateOf));
  root.appendChild(fileTable("By file", byFile, onFile));
}

/** Count table with an optional MB/h column, for the (level,tagset) rollup. The tagset keys here are
 *  display keys ("level · a+b"); rates are looked up by a parallel map keyed the same way. Note the
 *  rate map uses sorted tags while the display key preserves source order, so a rate is attached only
 *  when the two coincide — a best-effort adornment, never load-bearing. */
function tagsetTable(title: string, counts: Map<string, number>, rates: Map<string, number>): HTMLElement {
  const sec = document.createElement("section");
  sec.className = "count-table";
  const h = document.createElement("h4");
  h.textContent = title + " (" + counts.size + ")";
  sec.appendChild(h);
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [k, n] of rows.slice(0, 30)) {
    const r = document.createElement("div");
    r.className = "count-row";
    const label = document.createElement("span");
    label.className = "count-label";
    label.textContent = k;
    const nums = document.createElement("span");
    nums.className = "count-nums";
    const val = document.createElement("span");
    val.className = "count-val";
    val.textContent = n + (n === 1 ? " site" : " sites");
    nums.appendChild(val);
    const rate = rates.get(k);
    if (rate && rate > 0) {
      const rv = document.createElement("span");
      rv.className = "count-rate";
      rv.textContent = "~" + fmtMb(rate) + "/h";
      rv.title = "Estimated log volume, extrapolated from the benchmark run";
      nums.appendChild(rv);
    }
    r.append(label, nums);
    sec.appendChild(r);
  }
  return sec;
}

/** File rollup: each row is a link that jumps to the Sites tab filtered to that file (via onFile),
 *  so this list is a navigational index into Sites, not a dead re-listing of it. */
function fileTable(title: string, counts: Map<string, number>, onFile?: (file: string) => void): HTMLElement {
  const sec = document.createElement("section");
  sec.className = "count-table";
  const h = document.createElement("h4");
  h.textContent = title + " (" + counts.size + ")";
  sec.appendChild(h);
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [file, n] of rows.slice(0, 30)) {
    const r = document.createElement("div");
    r.className = "count-row";
    const label = onFile ? document.createElement("a") : document.createElement("span");
    label.className = "count-label" + (onFile ? " count-file-link" : "");
    label.textContent = file;
    if (onFile) {
      (label as HTMLAnchorElement).href = "#";
      label.title = "Show these sites in the Firing sites tab";
      label.addEventListener("click", (e) => { e.preventDefault(); onFile(file); });
    }
    const val = document.createElement("span");
    val.className = "count-val";
    val.textContent = n + (n === 1 ? " site" : " sites");
    r.append(label, val);
    sec.appendChild(r);
  }
  return sec;
}

function fmtMb(mb: number): string {
  if (mb >= 1024) return (mb / 1024).toFixed(1) + " GB";
  if (mb >= 1) return mb.toFixed(1) + " MB";
  return (mb * 1024).toFixed(0) + " KB";
}
