// SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
// SPDX-License-Identifier: GPL-2.0-only

import { Selector, selectorMatchesSite } from "./selector";
import { LevelName, LEVELS } from "./types";

/**
 * Tab 2: the full captured sample log for a GC, with its own search bar. The raw log is fetched
 * lazily (it can be several MB) from data/<version>.<gc>.log and rendered as a filterable,
 * virtualised-enough list (we cap rendered lines to keep the DOM light).
 */
export class LogSearch {
  private lines: string[] = [];
  private loadedFor = "";
  private selectors: Selector[] = [];
  private currentQuery = "";
  constructor(
    private readonly root: HTMLElement,
    private readonly dataBase: string
  ) {}

  async show(version: string, gc: string, logFile: string | undefined, selectors: Selector[] = []): Promise<void> {
    this.selectors = selectors;
    this.root.innerHTML = "";
    if (!logFile) {
      this.root.appendChild(note("No sample log captured for this version/GC."));
      return;
    }
    const key = version + "/" + gc;
    if (this.loadedFor !== key) {
      this.root.appendChild(note("Loading sample log…"));
      try {
        const res = await fetch(`${this.dataBase}${logFile}`);
        const text = await res.text();
        this.lines = text.split("\n");
        this.loadedFor = key;
      } catch {
        this.root.innerHTML = "";
        this.root.appendChild(note("Failed to load sample log."));
        return;
      }
    }
    this.render("");
  }

  /** Re-apply the current selectors without reloading the log file. */
  updateSelectors(selectors: Selector[]): void {
    this.selectors = selectors;
    if (this.loadedFor && this.root.offsetParent !== null) this.render(this.currentQuery);
  }

  private render(query: string): void {
    this.currentQuery = query;
    this.root.innerHTML = "";
    const search = document.createElement("input");
    search.type = "search";
    search.className = "log-search";
    search.placeholder = "Search the sample log…";
    search.value = query;
    search.addEventListener("input", () => this.render(search.value));
    this.root.appendChild(search);

    const q = query.toLowerCase();
    const configFiltered = this.selectors.length > 0
      ? this.lines.filter((l) => lineMatchesSelectors(l, this.selectors))
      : this.lines;
    const matched = q ? configFiltered.filter((l) => l.toLowerCase().includes(q)) : configFiltered;
    const count = document.createElement("div");
    count.className = "log-count";
    count.textContent = `${matched.length.toLocaleString()} line(s)` +
      (q ? ` matching "${query}"` : "") +
      (this.selectors.length > 0 ? ` (filtered by log config)` : "");
    this.root.appendChild(count);

    const pre = document.createElement("pre");
    pre.className = "log-body";
    const CAP = 2000;
    const shown = matched.slice(0, CAP);
    for (const line of shown) {
      pre.appendChild(renderLogLine(line, query));
    }
    if (matched.length > CAP) {
      const more = document.createElement("div");
      more.className = "log-more";
      more.textContent = `… (${matched.length - CAP} more lines; refine your search)`;
      pre.appendChild(more);
    }
    this.root.appendChild(pre);
  }
}

const LEVEL_WORDS = new Set(["trace", "debug", "info", "warning", "error"]);
// Wall-clock ISO-8601 timestamp decorator, e.g. `2026-08-11T12:51:33.733+0200`.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/**
 * Render one JVM log line: `[time][level][tags] message`. Color the level decorator group by its
 * level, tint the tag group, leave the message plain. The message is built with textContent (no
 * HTML injection from log data); only the decorator spans and the search `<mark>` are wrapped.
 */
function renderLogLine(line: string, query: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "log-line";

  // Consume leading `[...]` decorator groups.
  let i = 0;
  while (i < line.length && line[i] === "[") {
    const end = line.indexOf("]", i);
    if (end === -1) break;
    const inner = line.slice(i + 1, end);
    // Drop the wall-clock ISO-8601 timestamp decorator (e.g. `[2026-08-11T12:51:33.733+0200]`)
    // entirely — it's noise for reading the log; the `[16.680s]` uptime decorator is kept.
    if (ISO_TIMESTAMP.test(inner)) { i = end + 1; continue; }
    const span = document.createElement("span");
    const word = inner.trim().toLowerCase();
    if (LEVEL_WORDS.has(word)) span.className = "log-deco log-lvl-" + word;
    else if (/[a-z]/i.test(inner) && !/[0-9]/.test(inner.replace(/[.:]/g, ""))) span.className = "log-deco log-tags";
    else span.className = "log-deco";
    span.textContent = line.slice(i, end + 1);
    row.appendChild(span);
    i = end + 1;
  }

  const message = line.slice(i);
  appendMessage(row, message, query);
  return row;
}

/** Append the message text, wrapping case-insensitive matches of `query` in <mark>. */
function appendMessage(row: HTMLElement, message: string, query: string): void {
  if (!query) { row.appendChild(document.createTextNode(message)); return; }
  const lower = message.toLowerCase();
  const q = query.toLowerCase();
  let from = 0;
  let idx = lower.indexOf(q, from);
  while (idx !== -1) {
    if (idx > from) row.appendChild(document.createTextNode(message.slice(from, idx)));
    const mark = document.createElement("mark");
    mark.textContent = message.slice(idx, idx + q.length);
    row.appendChild(mark);
    from = idx + q.length;
    idx = lower.indexOf(q, from);
  }
  if (from < message.length) row.appendChild(document.createTextNode(message.slice(from)));
}

function note(text: string): HTMLElement {
  const d = document.createElement("div");
  d.className = "note";
  d.textContent = text;
  return d;
}

/**
 * Parse the level and tags from a JVM log line's decorator groups.
 * Format: `[<iso-ts>][<uptime>s][<level>][<tag1>,<tag2>,...] message`
 * Returns null if the line has no recognisable level+tags decorators.
 */
function parseLineDecorators(line: string): { level: LevelName; tags: string[] } | null {
  let level: LevelName | null = null;
  let tags: string[] | null = null;
  let i = 0;
  while (i < line.length && line[i] === "[") {
    const end = line.indexOf("]", i);
    if (end === -1) break;
    const inner = line.slice(i + 1, end).trim();
    i = end + 1;
    if (ISO_TIMESTAMP.test(inner)) continue; // wall-clock timestamp — skip
    const word = inner.toLowerCase();
    if (level === null && (LEVELS as readonly string[]).includes(word)) {
      level = word as LevelName;
      continue;
    }
    // Tags group: only letters, digits, underscores, commas — no dots or colons (rules out uptime/pid)
    if (level !== null && tags === null && /^[a-z][a-z0-9_]*(,[a-z][a-z0-9_]*)*\s*$/i.test(inner)) {
      tags = inner.split(",").map((t) => t.trim().toLowerCase());
      break;
    }
  }
  if (level === null || tags === null) return null;
  return { level, tags };
}

/**
 * Returns true if the log line should be shown given the active selectors.
 * Uses the same last-match-wins semantics as HotSpot: the last selector whose tags match the
 * line's tag set wins; the line is shown iff that selector's level ≤ the line's level.
 * Lines with unparseable decorators are always shown (we can't know, so we err on the side of
 * inclusion — e.g. blank lines, header lines, continuation lines).
 */
function lineMatchesSelectors(line: string, selectors: Selector[]): boolean {
  const parsed = parseLineDecorators(line);
  if (!parsed) return true;
  const { level, tags } = parsed;
  let winner: Selector | null = null;
  for (const sel of selectors) {
    if (selectorMatchesSite(sel, tags)) winner = sel;
  }
  if (!winner) return false;
  if (winner.level === "off") return false;
  // Line is shown if the configured level is at or below the line's verbosity level.
  const lineRank = (LEVELS as readonly string[]).indexOf(level);
  const selRank = (LEVELS as readonly string[]).indexOf(winner.level);
  return selRank <= lineRank;
}
