// SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
// SPDX-License-Identifier: GPL-2.0-only

/** JSON shapes as emitted by the Kotlin generator (data/<version>.json, data/tags.json). */

export interface SiteJson {
  id: string;
  level: LevelName;
  tags: string[];
  file: string;
  blockId: string;
  funcSignature: string | null;
  formatString: string | null;
  samples: Record<string, string[]>; // GC -> sample lines
}

/** A shared context block referenced by one or more sites (dedups snippet text). */
export interface Block {
  file: string;
  startLine: number;
  endLine: number;
  snippet: string;
  firingLineOffsets: number[];
}

export interface TagsetVolume { bytes: number; lines: number; }

export interface VolumeStats {
  benchWallSeconds: Record<string, number>;
  perTagset: Record<string, Record<string, TagsetVolume>>; // "<level>,<tagset>" -> GC -> volume
}

export interface VersionData {
  version: string;
  commitSha: string;
  repo: string;
  generatedAt: string;
  blocks: Record<string, Block>;   // blockId -> shared block
  sites: SiteJson[];
  sampleLogFiles: Record<string, string>; // GC -> relative log path
  volumeStats: VolumeStats;
}

/** Build a GitHub permalink for a site from the version's repo + commit and its block. */
export function ghUrl(data: VersionData, block: Block): string {
  return `https://github.com/${data.repo}/blob/${data.commitSha}/${block.file}#L${block.startLine}-L${block.endLine}`;
}

export interface TagInfo { name: string; description: string; }
export interface TagsData { levels: LevelName[]; tags: TagInfo[]; }

export type LevelName = "trace" | "debug" | "info" | "warning" | "error";
export const LEVELS: LevelName[] = ["trace", "debug", "info", "warning", "error"];
export const levelRank = (l: LevelName): number => LEVELS.indexOf(l);

/** A selector's level may additionally be `off`, which disables it (no site fires). */
export type SelectorLevel = LevelName | "off";

/**
 * A hand-curated log-site → JFR-event mapping record (data/jfr-mappings.json).
 * `kind` distinguishes a verified 1:1 replacement (`exact`) from a per-site partial (`partial`):
 * most of the log line's datum is in `jfrEvent`, or computable from it — possibly by combining
 * `relatedEvents`. A record without `kind` is treated as `exact` (back-compat with the original file).
 */
export interface JfrMapping {
  file: string;
  function: string;
  logLine: string;   // trimmed format-string text
  jfrEvent: string;
  jfrEventsUrl: string;
  kind?: "exact" | "partial";  // absent => "exact"
  relatedEvents?: string[];    // other events that, combined with jfrEvent, recover the datum
  coverageNote?: string;       // how the log line's info is carried by / computable from the event(s)
}

/** How well a firing log site is captured by a JFR event. */
export type CoverageState = "covered" | "partial" | "uncovered";

/**
 * A tag-set → JFR-event rule (data/jfr-coverage.json). A site whose tag set relates to `tags`
 * (per `match`) is *partially* covered by `jfrEvent` — the event lives in the same subsystem but is
 * not a verified line-for-line match. Authored from the deep per-subsystem investigation.
 */
export interface CoverageRule {
  tags: string[];
  match: "superset" | "exact";  // "superset": site tags ⊇ rule tags; "exact": set-equal
  jfrEvent: string;
  jfrEventsUrl: string;
  note?: string;
}

export interface CoverageData { rules: CoverageRule[]; }

/** The coverage verdict for one site, plus the event it maps to (if any). */
export interface CoverageResult {
  state: CoverageState;
  jfrEvent?: string;
  jfrEventsUrl?: string;
  note?: string;
  relatedEvents?: string[];  // for a per-site partial: events that together recover the datum
}
