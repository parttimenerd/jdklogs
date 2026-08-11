// SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// Unit test for the reverse (event → log lines) index. Asserts that buildEventIndex groups a known
// exact mapping record under its JFR event, and that a partial-only site increments the subsystem
// count without inventing an exact line.
//
// Run with:  node --import tsx site/test/reverse.mts

import { buildEventIndex } from "../src/reverse.ts";
import { CoverageRule, JfrMapping, SiteJson } from "../src/types.ts";

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (!cond) { console.error("FAIL: " + msg); failures++; }
  else console.log("ok  " + msg);
}

const mappings: JfrMapping[] = [
  {
    file: "src/hotspot/share/gc/shared/gcTraceTime.cpp",
    function: "GCTraceCPUTime::~GCTraceCPUTime()",
    logLine: "User=%.2fs Sys=%.2fs Real=%.2fs",
    jfrEvent: "jdk.GCCPUTime",
    jfrEventsUrl: "https://sap.github.io/jfrevents/25.html#gccputime",
  },
  // A per-site partial: the event carries most of the datum but is not a 1:1 line replacement.
  {
    file: "src/hotspot/share/gc/g1/g1CollectedHeap.cpp",
    function: "void G1CollectedHeap::do_collection()",
    logLine: "Heap region count %u total %u",
    jfrEvent: "jdk.G1HeapRegionTypeChange",
    jfrEventsUrl: "https://sap.github.io/jfrevents/25.html#g1heapregiontypechange",
    kind: "partial",
    relatedEvents: ["jdk.GCHeapSummary"],
    coverageNote: "region count derivable from per-region type-change events plus the heap summary",
  },
];

const rules: CoverageRule[] = [
  { tags: ["gc", "phases"], match: "superset", jfrEvent: "jdk.GCPhasePause", jfrEventsUrl: "u" },
];

function site(tags: string[], file: string, func: string | null, fmt: string | null): SiteJson {
  return { id: "s", level: "info", tags, file, blockId: file + "|1-1", funcSignature: func, formatString: fmt, samples: {} };
}

// A firing site that matches the exact mapping (so it is "covered", not counted as partial); a site
// that only matches the rule (partial); and a site that matches the per-site partial mapping.
const fires: SiteJson[] = [
  site(["gc"], "src/hotspot/share/gc/shared/gcTraceTime.cpp", "GCTraceCPUTime::~GCTraceCPUTime()", "User=%.2fs Sys=%.2fs Real=%.2fs"),
  site(["gc", "phases"], "src/hotspot/share/gc/g1/g1Foo.cpp", "G1::phase()", "Some phase %u"),
  site(["gc", "heap"], "src/hotspot/share/gc/g1/g1CollectedHeap.cpp", "void G1CollectedHeap::do_collection()", "Heap region count %u total %u"),
];

const idx = buildEventIndex(mappings, rules, fires);

const cpu = idx.find((e) => e.event === "jdk.GCCPUTime");
check(!!cpu, "jdk.GCCPUTime appears in the event index");
check(cpu!.exact.length === 1, "jdk.GCCPUTime has exactly one exact log line");
check(cpu!.exact[0].logLine === "User=%.2fs Sys=%.2fs Real=%.2fs", "the log line text is preserved verbatim");
check(cpu!.jfrEventsUrl === "https://sap.github.io/jfrevents/25.html#gccputime", "the jfrevents URL is carried through");

const phase = idx.find((e) => e.event === "jdk.GCPhasePause");
check(!!phase, "the partial rule's event jdk.GCPhasePause appears");
check(phase!.exact.length === 0, "a partial-only event has no invented exact lines");
check(phase!.partialCount === 1, "the partial site is counted once");

// The covered site must not also inflate a partial count for its own event.
check(cpu!.partialCount === 0, "an exactly-covered site does not add to its event's partial count");

// A per-site partial mapping must NOT show up as a 1:1 exact line for its event...
const region = idx.find((e) => e.event === "jdk.G1HeapRegionTypeChange");
check(!!region, "a per-site partial mapping's event appears in the index");
check(region!.exact.length === 0, "a per-site partial record is not listed as an exact line");
check(region!.partialCount === 1, "the firing site is counted as partial for the partial event");
check(
  region!.jfrEventsUrl === "https://sap.github.io/jfrevents/25.html#g1heapregiontypechange",
  "the partial mapping's jfrEvents URL is carried through"
);

// ...and its related event should also accrue the partial count, with a canonical URL derived.
const summary = idx.find((e) => e.event === "jdk.GCHeapSummary");
check(!!summary, "a per-site partial's relatedEvents also appear in the index");
check(summary!.partialCount === 1, "the related event accrues the partial count too");
check(summary!.exact.length === 0, "the related event has no invented exact lines");
check(
  summary!.jfrEventsUrl === "https://sap.github.io/jfrevents/25.html#gcheapsummary",
  "the related event gets a canonical jfrEvents URL"
);

console.log(`\n${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
