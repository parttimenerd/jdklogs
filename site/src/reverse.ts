// SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
// SPDX-License-Identifier: GPL-2.0-only

import { CoverageRule, JfrMapping, SiteJson } from "./types";
import { classifySite, indexMappingsByKind } from "./coverage";

/** One log line an event exactly replaces (verified 1:1). */
export interface ExactLine {
  file: string;
  function: string;
  logLine: string;
}

/** The transition picture for one JFR event: which log lines it replaces, and how much it touches. */
export interface EventEntry {
  event: string;
  jfrEventsUrl: string;
  exact: ExactLine[];      // verified log lines this event replaces (from jfr-mappings.json)
  partialCount: number;    // firing sites in this event's subsystem, related but not verified 1:1
}

/**
 * Invert the coverage model into an event-first view: "I use JFR event X — which -Xlog lines does it
 * replace?" Exact lines come from the verified mappings; partial counts come from coverage rules
 * resolved against the currently-firing sites (so the number reflects the active config). Only events
 * that either replace a log line or relate to a firing site appear.
 */
export function buildEventIndex(
  mappings: JfrMapping[],
  rules: CoverageRule[],
  fires: SiteJson[]
): EventEntry[] {
  const byEvent = new Map<string, EventEntry>();
  const canonUrl = (event: string) =>
    "https://sap.github.io/jfrevents/25.html#" + event.replace("jdk.", "").toLowerCase();
  const get = (event: string, url: string): EventEntry => {
    let e = byEvent.get(event);
    if (!e) {
      e = { event, jfrEventsUrl: url || canonUrl(event), exact: [], partialCount: 0 };
      byEvent.set(event, e);
    }
    if (!e.jfrEventsUrl && url) e.jfrEventsUrl = url;
    return e;
  };

  for (const m of mappings) {
    // Only verified 1:1 (exact) mappings are "lines this event replaces". A per-site partial relates
    // to the event but is not a line-for-line replacement, so it feeds partialCount below, not exact.
    if (m.kind === "partial") continue;
    const entry = get(m.jfrEvent, m.jfrEventsUrl);
    // Dedup by log-line text: the same message can be printed from several files/functions, but the
    // reader only cares which distinct lines the event replaces.
    if (entry.exact.some((x) => x.logLine === m.logLine)) continue;
    entry.exact.push({
      file: m.file,
      function: m.function,
      logLine: m.logLine,
    });
  }

  const index = indexMappingsByKind(mappings);
  for (const s of fires) {
    const cov = classifySite(s, index, rules);
    if (cov.state === "partial" && cov.jfrEvent) {
      get(cov.jfrEvent, cov.jfrEventsUrl ?? "").partialCount++;
      // A per-site partial may name companion events that together recover the datum; count the site
      // against each so the event index reflects its partial reach too.
      for (const rel of cov.relatedEvents ?? []) {
        get(rel, "").partialCount++;
      }
    }
  }

  // Most-impactful events first: exact matches carry the most weight, then partial reach.
  return [...byEvent.values()].sort(
    (a, b) => b.exact.length - a.exact.length || b.partialCount - a.partialCount || a.event.localeCompare(b.event)
  );
}
