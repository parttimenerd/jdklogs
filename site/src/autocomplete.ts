// SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
// SPDX-License-Identifier: GPL-2.0-only

import { LEVELS, TagInfo } from "./types";

export interface Suggestion { text: string; kind: "tag" | "level" | "all"; detail?: string; dead?: boolean; }

/**
 * Suggest completions for the token under the cursor in a config string.
 * Rules of thumb mirroring the grammar:
 *  - after `=` → suggest levels
 *  - inside a tag token (after `,` or `+` or at start) → suggest tags (+ `all`)
 *
 * When `available` is provided, tags with no log sites for the current gc/platform are kept but
 * marked dead (muted, with a "no sites for this GC" note) and sorted after the live ones.
 */
export function suggest(input: string, caret: number, tags: TagInfo[], available?: Set<string>): Suggestion[] {
  const before = input.slice(0, caret);
  // find the current token boundaries
  const tokenStart = Math.max(
    before.lastIndexOf(","),
    before.lastIndexOf("+"),
    before.lastIndexOf("="),
    -1
  ) + 1;
  const sep = before[tokenStart - 1];
  const token = before.slice(tokenStart).trim();

  if (sep === "=") {
    return LEVELS.filter((l) => l.startsWith(token)).map((l) => ({ text: l, kind: "level" }));
  }

  const out: Suggestion[] = [];
  if ("all".startsWith(token) && token.length > 0) out.push({ text: "all", kind: "all", detail: "every tag set" });
  for (const t of tags) {
    if (!t.name.startsWith(token)) continue;
    const dead = available !== undefined && !available.has(t.name);
    out.push({
      text: t.name,
      kind: "tag",
      detail: dead ? `${t.description} · no sites for this GC` : t.description,
      dead,
    });
  }
  // Bias live tags to the top (stable) so dead ones don't crowd out useful completions in the cap.
  out.sort((a, b) => Number(a.dead ?? false) - Number(b.dead ?? false));
  return out.slice(0, 12);
}

/** Nearest known tag by edit distance, for "did you mean" errors. */
export function nearestTag(name: string, tags: TagInfo[]): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const t of tags) {
    const d = editDistance(name, t.name);
    if (d < bestD) { bestD = d; best = t.name; }
  }
  return bestD <= 2 ? best : null;
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
  return dp[a.length][b.length];
}

/** Replace the token under the cursor with a chosen suggestion; returns [newText, newCaret]. */
export function applySuggestion(input: string, caret: number, sugg: Suggestion): [string, number] {
  const before = input.slice(0, caret);
  const tokenStart = Math.max(
    before.lastIndexOf(","),
    before.lastIndexOf("+"),
    before.lastIndexOf("="),
    -1
  ) + 1;
  const head = input.slice(0, tokenStart);
  const tail = input.slice(caret);
  const next = head + sugg.text + tail;
  return [next, (head + sugg.text).length];
}
