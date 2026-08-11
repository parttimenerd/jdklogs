// SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
// SPDX-License-Identifier: GPL-2.0-only

import { VolumeEstimate, Warning } from "./analysis";
import { SiteJson } from "./types";

/** Renders the summary rollup: per-(level,tagset) + per-file counts, warnings, volume. */
export function renderSummary(
  root: HTMLElement,
  fires: SiteJson[],
  warnings: Warning[],
  volume: VolumeEstimate
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

  // volume estimate
  const vol = document.createElement("div");
  vol.className = "volume";
  if (volume.hasData && volume.totalMbPerHour > 0) {
    const total = document.createElement("div");
    total.className = "vol-total";
    total.textContent = "≈ " + fmtMb(volume.totalMbPerHour) + " / hour (" + volume.gc + ", best-effort)";
    vol.appendChild(total);
    const sub = document.createElement("div");
    sub.className = "vol-note";
    sub.textContent = "Extrapolated from a " + volume.wallSeconds.toFixed(0) + "s benchmark run; real volume varies with workload.";
    vol.appendChild(sub);
    const list = document.createElement("div");
    list.className = "vol-split";
    for (const p of volume.perTagset.slice(0, 8)) {
      const r = document.createElement("div");
      r.className = "vol-row";
      r.textContent = p.key + ": " + fmtMb(p.mbPerHour) + "/h";
      list.appendChild(r);
    }
    vol.appendChild(list);
  } else {
    vol.className = "volume note";
    vol.textContent = "No volume estimate (no sample capture for this GC).";
  }
  root.appendChild(vol);

  // per (level,tagset) counts
  const byTagset = new Map<string, number>();
  const byFile = new Map<string, number>();
  for (const s of fires) {
    const k = s.level + " · " + s.tags.join("+");
    byTagset.set(k, (byTagset.get(k) ?? 0) + 1);
    byFile.set(s.file, (byFile.get(s.file) ?? 0) + 1);
  }

  root.appendChild(countTable("By level + tag set", byTagset));
  root.appendChild(countTable("By file", byFile));
}

function countTable(title: string, counts: Map<string, number>): HTMLElement {
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
    const val = document.createElement("span");
    val.className = "count-val";
    val.textContent = String(n);
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
