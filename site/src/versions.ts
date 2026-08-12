// SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
// SPDX-License-Identifier: GPL-2.0-only
import { VersionData } from "./types";
import { mappingKey } from "./coverage";

/** siteKey → set of versions the site appears in. Key is line-number-independent (mappingKey). */
export type Presence = Map<string, Set<string>>;

/** Build the presence map from every present version's data. `present` is the effective, ordered
 *  (newest-first: head, then descending LTS) version list from detectVersions(). */
export function buildPresence(datas: VersionData[], present: string[]): Presence {
  const p: Presence = new Map();
  for (const d of datas) {
    if (!present.includes(d.version)) continue;
    for (const s of d.sites) {
      const key = mappingKey(s.file, s.funcSignature, s.formatString);
      (p.get(key) ?? p.set(key, new Set()).get(key)!).add(d.version);
    }
  }
  return p;
}

/**
 * A badge label for a site given the versions it appears in, or null when it appears in ALL present
 * versions (the common case — no badge, no noise). `present` is newest-first (present[0] === newest).
 *  - absent from newest but in older → "removed" (gone from master head).
 *  - present only in newest → "new in <newest>".
 *  - otherwise a strict subset → "<v1>, <v2> only" (present-order).
 */
export function versionBadge(inVersions: Set<string>, present: string[]): string | null {
  if (present.length < 2) return null;              // single version → feature inert
  if (inVersions.size === present.length) return null; // in all → silent
  const newest = present[0];
  const hasNewest = inVersions.has(newest);
  if (!hasNewest) return "removed";
  if (inVersions.size === 1 && hasNewest) return `new in ${newest}`;
  const kept = present.filter((v) => inVersions.has(v));
  return `${kept.join(", ")} only`;
}
