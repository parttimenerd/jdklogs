// SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
// SPDX-License-Identifier: GPL-2.0-only

/**
 * Colorizes a HotSpot `-Xlog` selector string for the overlay mirror under the config input.
 * A light lexer (not the Ohm parser) is enough for coloring; the authoritative validity check
 * still comes from parseConfig() in selector.ts. Unknown tags and the parse-error column are
 * marked `tok-bad` (red). The emitted HTML aligns glyph-for-glyph with the transparent <input>.
 */

import { LEVELS } from "./types";

const LEVEL_SET = new Set<string>([...LEVELS, "off"]);

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * @param text     the raw config string (verbatim, including trailing spaces)
 * @param known    the set of valid tag names (from tags.json)
 * @param errorPos 0-based column of a parse error, or null
 */
export function highlightConfig(text: string, known: Set<string>, errorPos: number | null): string {
  let out = "";
  let i = 0;
  // A tag or level word is a run of [A-Za-z0-9_-]; everything else is punctuation we color per-char.
  const isWord = (c: string) => /[A-Za-z0-9_-]/.test(c);

  while (i < text.length) {
    const c = text[i];
    if (isWord(c)) {
      let j = i;
      while (j < text.length && isWord(text[j])) j++;
      const word = text.slice(i, j);
      // Is this word in the level position? A level follows `=`. Look back past spaces for `=`.
      let k = i - 1;
      while (k >= 0 && text[k] === " ") k--;
      const afterEq = k >= 0 && text[k] === "=";
      let cls: string;
      if (afterEq && LEVEL_SET.has(word)) cls = "tok-level";
      else if (afterEq) cls = "tok-bad";           // level slot but not a valid level
      else if (known.has(word)) cls = "tok-tag";
      else cls = "tok-bad";                          // unknown tag
      out += `<span class="${cls}">${esc(word)}</span>`;
      i = j;
    } else if (c === "*") {
      out += `<span class="tok-star">*</span>`; i++;
    } else if (c === "+" || c === "=") {
      out += `<span class="tok-op">${c}</span>`; i++;
    } else if (c === ",") {
      out += `<span class="tok-sep">,</span>`; i++;
    } else if (c === " ") {
      out += " "; i++;
    } else {
      out += `<span class="tok-bad">${esc(c)}</span>`; i++;   // stray punctuation
    }
  }

  // Overlay a red marker at the parse-error column if it lands inside the text.
  if (errorPos !== null && errorPos >= 0 && errorPos < text.length) {
    out = markColumn(text, known, errorPos);
  }
  return out;
}

/** Re-render coloring the single character at `pos` as an error caret. */
function markColumn(text: string, known: Set<string>, pos: number): string {
  const before = highlightConfig(text.slice(0, pos), known, null);
  const at = `<span class="tok-bad tok-caret">${esc(text[pos] || " ")}</span>`;
  const after = highlightConfig(text.slice(pos + 1), known, null);
  return before + at + after;
}
