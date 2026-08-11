// SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
// SPDX-License-Identifier: GPL-2.0-only

import * as ohm from "ohm-js";
import { grammarSource } from "./grammar";
import { LEVELS, levelRank, SelectorLevel, SiteJson } from "./types";

const grammar = ohm.grammar(grammarSource);

/** One parsed selector: a set of tags, whether it is a wildcard (`*`), and its level. */
export interface Selector {
  tags: string[];          // sorted, unique
  wildcard: boolean;       // trailing "*" or the "all" pseudo-tag
  isAll: boolean;          // matched literally "all"
  level: SelectorLevel;    // defaults to "info"; may be "off" to disable
  text: string;            // original selector text, for diagnostics
}

export interface ParseError {
  message: string;         // human-friendly
  index: number;           // 0-based column of the failure
  expected?: string;
}

export interface ParseResult {
  selectors: Selector[];
  error: ParseError | null;
}

/** Parse a config string into selectors, or a position-accurate error. Empty string → no selectors. */
export function parseConfig(input: string): ParseResult {
  const text = input.trim();
  if (text === "") return { selectors: [], error: null };

  const m = grammar.match(text);
  if (m.failed()) {
    // ohm's rightmost-failure info gives us position + "expected" text.
    const interval = (m as any).getInterval?.();
    const index = interval ? interval.startIdx : (m as any).getRightmostFailurePosition?.() ?? 0;
    return {
      selectors: [],
      error: {
        message: friendlyError(text, index, m.message ?? "syntax error"),
        index,
        expected: m.shortMessage ?? undefined,
      },
    };
  }

  const selectors = buildSemantics(m);
  return { selectors, error: null };
}

/** Turn Ohm's raw failure into a specific, position-flavoured message. */
function friendlyError(text: string, index: number, raw: string): string {
  const at = index >= text.length ? "end of input" : `column ${index + 1} (\`${text[index]}\`)`;
  if (text[index] === "=") return `Unexpected \`=\` at ${at}. Write it as \`tag=level\`, e.g. \`gc=info\`.`;
  if (index >= text.length && /=$/.test(text)) return `Expected a level after \`=\` (one of ${LEVELS.join(", ")}, off).`;
  const m = /Expected (.*)$/.exec(raw);
  if (m) return `Unexpected input at ${at}. Expected ${m[1]}.`;
  return `Could not parse config at ${at}.`;
}

// --- Ohm → Selector[] ------------------------------------------------------
let semantics: ohm.Semantics | null = null;
function buildSemantics(matchResult: ohm.MatchResult): Selector[] {
  if (!semantics) {
    semantics = grammar.createSemantics().addOperation<any>("eval", {
      Config(first, _commas, rest) {
        return [first.eval(), ...rest.children.map((c) => c.eval())];
      },
      Selector(tagset, _eq, level) {
        const ts = tagset.eval();
        const lvl = level.numChildren > 0 ? (level.child(0).sourceString as SelectorLevel) : "info";
        return { ...ts, level: lvl, text: this.sourceString.trim() } as Selector;
      },
      TagSet_allTag(_all) {
        return { tags: [], wildcard: true, isAll: true };
      },
      TagSet_tags(first, _plus, rest, star) {
        const tags = [first.sourceString, ...rest.children.map((c) => c.sourceString)];
        const uniq = Array.from(new Set(tags)).sort();
        return { tags: uniq, wildcard: star.numChildren > 0, isAll: false };
      },
    });
  }
  return semantics(matchResult).eval();
}

// --- HotSpot matching semantics -------------------------------------------

/** Does a single selector match a site's tag set? Mirrors logSelection.cpp. */
export function selectorMatchesSite(sel: Selector, siteTags: string[]): boolean {
  if (sel.isAll) return true;                       // "all" matches every tag set
  const siteSet = new Set(siteTags);
  if (sel.wildcard) {
    // wildcard: the site's tag set must *contain* all selector tags (superset test)
    return sel.tags.every((t) => siteSet.has(t));
  }
  // no wildcard: exact set equality
  if (sel.tags.length !== siteTags.length) return false;
  return sel.tags.every((t) => siteSet.has(t));
}

/**
 * Decide whether a site fires under the whole selector list.
 * HotSpot: the *last* selector that matches the site's tag set wins; the site fires iff that
 * selector's level is <= the site's level (i.e. the configured level is verbose enough).
 * Returns the winning selector (for diagnostics) or null if none matched / gated off.
 */
export function siteFires(selectors: Selector[], site: SiteJson): Selector | null {
  let winner: Selector | null = null;
  for (const sel of selectors) {
    if (selectorMatchesSite(sel, site.tags)) winner = sel;
  }
  if (!winner) return null;
  if (winner.level === "off") return null;          // `off` disables the matched selector
  // site fires if the configured (winner) level is at or below the site level in verbosity:
  // e.g. selector level=info fires an info/warning/error site, but not a debug/trace site.
  return levelRank(winner.level) <= levelRank(site.level) ? winner : null;
}

/** Firing set for a config over all sites. */
export function firingSites(selectors: Selector[], sites: SiteJson[]): SiteJson[] {
  return sites.filter((s) => siteFires(selectors, s) !== null);
}
