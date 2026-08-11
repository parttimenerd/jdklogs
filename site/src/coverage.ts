// SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
// SPDX-License-Identifier: GPL-2.0-only

import { CoverageResult, CoverageRule, JfrMapping, SiteJson } from "./types";

/**
 * Key a site the same way jfr-mappings.json does: line-number-independent, so reformatting or line
 * shifts in a later JDK don't invalidate the mapping. Shared by the exact-mapping join and coverage.
 */
export function mappingKey(file: string, func: string | null, logLine: string | null): string {
  return [file, func ?? "", (logLine ?? "").trim()].join(" | ");
}

/** Build the exact-mapping index once, keyed by mappingKey. */
export function indexMappings(mappings: JfrMapping[]): Map<string, JfrMapping> {
  const idx = new Map<string, JfrMapping>();
  for (const m of mappings) idx.set(mappingKey(m.file, m.function, m.logLine), m);
  return idx;
}

/**
 * Index mappings split by kind: `exact` (kind absent or "exact") drives the `covered` verdict;
 * `partial` (kind "partial") is a per-site partial that beats a broad tag-set rule.
 */
export function indexMappingsByKind(
  mappings: JfrMapping[]
): { exact: Map<string, JfrMapping>; partial: Map<string, JfrMapping> } {
  const exact = new Map<string, JfrMapping>();
  const partial = new Map<string, JfrMapping>();
  for (const m of mappings) {
    const key = mappingKey(m.file, m.function, m.logLine);
    (m.kind === "partial" ? partial : exact).set(key, m);
  }
  return { exact, partial };
}

function ruleMatches(rule: CoverageRule, siteTags: string[]): boolean {
  const siteSet = new Set(siteTags);
  if (rule.match === "exact") {
    return rule.tags.length === siteTags.length && rule.tags.every((t) => siteSet.has(t));
  }
  // superset: the site's tag set must contain all of the rule's tags
  return rule.tags.every((t) => siteSet.has(t));
}

/**
 * Classify a site's JFR coverage:
 *  - `covered`   — a per-site exact (file, function, logLine) mapping exists (verified 1:1 match).
 *  - `partial`   — no exact mapping, but either a per-site partial mapping (most of the datum is in
 *                  the event or computable from it, possibly via `relatedEvents`) OR the site's tag
 *                  set matches a coverage rule (same-subsystem event, not verified line-for-line).
 *                  A per-site partial beats a broad rule.
 *  - `uncovered` — none of the above. A genuine gap: a candidate for a new JFR event.
 * On a rule tie, the most-specific rule (most tags) wins.
 */
export function classifySite(
  site: SiteJson,
  index: { exact: Map<string, JfrMapping>; partial: Map<string, JfrMapping> },
  rules: CoverageRule[]
): CoverageResult {
  const key = mappingKey(site.file, site.funcSignature, site.formatString);

  const ex = index.exact.get(key);
  if (ex) {
    return { state: "covered", jfrEvent: ex.jfrEvent, jfrEventsUrl: ex.jfrEventsUrl };
  }
  const pm = index.partial.get(key);
  if (pm) {
    return {
      state: "partial",
      jfrEvent: pm.jfrEvent,
      jfrEventsUrl: pm.jfrEventsUrl,
      note: pm.coverageNote,
      relatedEvents: pm.relatedEvents,
    };
  }
  let best: CoverageRule | null = null;
  for (const r of rules) {
    if (!ruleMatches(r, site.tags)) continue;
    if (best === null || r.tags.length > best.tags.length) best = r;
  }
  if (best) {
    return { state: "partial", jfrEvent: best.jfrEvent, jfrEventsUrl: best.jfrEventsUrl, note: best.note };
  }
  return { state: "uncovered" };
}

/** Split firing sites into coverage buckets (for the summary rollup + gap worklist). */
export function coverageBuckets(
  fires: SiteJson[],
  index: { exact: Map<string, JfrMapping>; partial: Map<string, JfrMapping> },
  rules: CoverageRule[]
): { covered: SiteJson[]; partial: SiteJson[]; uncovered: SiteJson[] } {
  const covered: SiteJson[] = [];
  const partial: SiteJson[] = [];
  const uncovered: SiteJson[] = [];
  for (const s of fires) {
    const { state } = classifySite(s, index, rules);
    (state === "covered" ? covered : state === "partial" ? partial : uncovered).push(s);
  }
  return { covered, partial, uncovered };
}
