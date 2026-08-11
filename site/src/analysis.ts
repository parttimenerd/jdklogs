// SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
// SPDX-License-Identifier: GPL-2.0-only

import { Selector, selectorMatchesSite } from "./selector";
import { LevelName, levelRank, SiteJson, VolumeStats } from "./types";

export interface Warning { kind: string; message: string; }

/**
 * Flags configs that won't do what the user likely intends:
 *  - a selector matched by NO known site (tagset typo / nonexistent combination)
 *  - a selector whose level is too high to ever fire any site it matches (e.g. gc=error but the
 *    only gc-exact sites are info)
 *  - a selector fully shadowed by a later selector with the same tag set
 *  - exact duplicate selectors
 */
export function analyzeConfig(selectors: Selector[], sites: SiteJson[]): Warning[] {
  const warnings: Warning[] = [];

  selectors.forEach((sel, i) => {
    const matched = sites.filter((s) => selectorMatchesSite(sel, s.tags));
    if (matched.length === 0) {
      warnings.push({
        kind: "no-site",
        message: `\`${sel.text}\`: no log site has ${describeTagset(sel)}. Nothing will fire from it.`,
      });
      return;
    }
    // `off` intentionally disables the selector — never warn that it fires nothing.
    if (sel.level !== "off") {
      const fireable = matched.filter((s) => levelRank(sel.level as LevelName) <= levelRank(s.level));
      if (fireable.length === 0) {
        const avail = minLevel(matched);
        warnings.push({
          kind: "level-too-high",
          message: `\`${sel.text}\`: level \`${sel.level}\` is too high — the matching sites are at most \`${avail}\`. Try \`=${avail}\` or lower.`,
        });
      }
    }
    // shadowing: a later selector with an identical tag set + wildcard overrides this one
    for (let j = i + 1; j < selectors.length; j++) {
      if (sameTagset(sel, selectors[j])) {
        warnings.push({
          kind: "shadowed",
          message: `\`${sel.text}\` is overridden by a later \`${selectors[j].text}\` (same tag set). The earlier one has no effect.`,
        });
        break;
      }
    }
  });

  return warnings;
}

function sameTagset(a: Selector, b: Selector): boolean {
  return a.isAll === b.isAll && a.wildcard === b.wildcard &&
    a.tags.length === b.tags.length && a.tags.every((t, k) => t === b.tags[k]);
}

function describeTagset(sel: Selector): string {
  if (sel.isAll) return "the `all` selector";
  const join = sel.tags.join("+");
  return sel.wildcard ? `tags containing \`${join}\`` : `exactly the tag set \`${join}\``;
}

function minLevel(sites: SiteJson[]): LevelName {
  return sites.reduce<LevelName>((acc, s) => (levelRank(s.level) < levelRank(acc) ? s.level : acc), "error");
}

// --- volume estimate -------------------------------------------------------

export interface VolumeEstimate {
  totalMbPerHour: number;
  perTagset: { key: string; mbPerHour: number }[]; // sorted desc
  gc: string;
  wallSeconds: number;
  hasData: boolean;
}

/**
 * Estimate MB/hour for the firing config from the benchmark's measured bytes per (level,tagset),
 * extrapolated from the run wall-time. Only counts (level,tagset) buckets that the current config
 * would actually fire.
 */
export function estimateVolume(
  fires: SiteJson[],
  volume: VolumeStats,
  gc: string
): VolumeEstimate {
  const wall = volume.benchWallSeconds[gc] ?? 0;
  const hasData = wall > 0 && Object.keys(volume.perTagset).length > 0;
  // A (level,tagset) bucket is "firing" if any firing site shares that exact level+tagset.
  const firingKeys = new Set(fires.map((s) => `${s.level},${[...s.tags].sort().join("+")}`));

  const perTagset: { key: string; mbPerHour: number }[] = [];
  let totalBytesPerSec = 0;
  for (const [key, byGc] of Object.entries(volume.perTagset)) {
    if (!firingKeys.has(key)) continue;
    const v = byGc[gc];
    if (!v || wall <= 0) continue;
    const bps = v.bytes / wall;
    totalBytesPerSec += bps;
    perTagset.push({ key, mbPerHour: (bps * 3600) / (1024 * 1024) });
  }
  perTagset.sort((a, b) => b.mbPerHour - a.mbPerHour);

  return {
    totalMbPerHour: (totalBytesPerSec * 3600) / (1024 * 1024),
    perTagset,
    gc,
    wallSeconds: wall,
    hasData,
  };
}
