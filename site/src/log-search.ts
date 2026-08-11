// SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
// SPDX-License-Identifier: GPL-2.0-only

/**
 * Tab 2: the full captured sample log for a GC, with its own search bar. The raw log is fetched
 * lazily (it can be several MB) from data/<version>.<gc>.log and rendered as a filterable,
 * virtualised-enough list (we cap rendered lines to keep the DOM light).
 */
export class LogSearch {
  private lines: string[] = [];
  private loadedFor = "";
  constructor(
    private readonly root: HTMLElement,
    private readonly dataBase: string
  ) {}

  async show(version: string, gc: string, logFile: string | undefined): Promise<void> {
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

  private render(query: string): void {
    this.root.innerHTML = "";
    const search = document.createElement("input");
    search.type = "search";
    search.className = "log-search";
    search.placeholder = "Search the sample log…";
    search.value = query;
    search.addEventListener("input", () => this.render(search.value));
    this.root.appendChild(search);

    const q = query.toLowerCase();
    const matched = q ? this.lines.filter((l) => l.toLowerCase().includes(q)) : this.lines;
    const count = document.createElement("div");
    count.className = "log-count";
    count.textContent = `${matched.length.toLocaleString()} line(s)` + (q ? ` matching "${query}"` : "");
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
