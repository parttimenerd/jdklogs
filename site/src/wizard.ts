// SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
// SPDX-License-Identifier: GPL-2.0-only

import { LEVELS, LevelName, TagInfo } from "./types";
import { parseConfig, Selector } from "./selector";

/** One row in the wizard: a tag, whether enabled, its chosen level, and wildcard-vs-exact. */
interface WizardRow { level: LevelName; wildcard: boolean; }

/**
 * The selector wizard. Renders a searchable list of all tags with descriptions; each enabled tag
 * contributes a selector `tag*=level` to the config. Two-way bound: {@link syncFromConfig} updates
 * the rows when the user edits the text; toggling a row calls back with the rebuilt config string.
 *
 * Tags are grouped by their *main tag* (the primary subsystem they belong to, e.g. every gc-family
 * tag lands under `gc`). Each group is a collapsible `<details>` that starts closed, so the first
 * open shows a compact index of primary tags the user can expand.
 */
export class Wizard {
  private rows = new Map<string, WizardRow>();
  // Which <details> groups the user has expanded (persists across re-renders within a session).
  private open = new Set<string>();
  // Tags that have at least one log site for the current version/gc/platform. A tag outside this
  // set can never fire under the current selection, so we grey it out and sort it below the live
  // tags in its group. `null` means "not yet computed" — treat every tag as available.
  private available: Set<string> | null = null;
  constructor(
    private readonly root: HTMLElement,
    private readonly tags: TagInfo[],
    private readonly primaryOf: Map<string, string>,
    private readonly onChange: (config: string) => void
  ) {
    this.render();
  }

  /**
   * Restrict which tags are shown as "live" for the current version/gc/platform combo. Tags not in
   * `available` are greyed out and sorted after the live ones in their group; a group with no live
   * tags sorts to the bottom of the list. Call on init and whenever the gc/platform selection changes.
   */
  setAvailableTags(available: Set<string>): void {
    this.available = available;
    this.render();
  }

  private isAvailable(tag: string): boolean {
    return this.available === null || this.available.has(tag);
  }

  /** Parse a config string and reflect it into the toggles (single-tag wildcard selectors only). */
  syncFromConfig(config: string): void {
    const { selectors } = parseConfig(config);
    this.rows.clear();
    for (const sel of selectors) {
      // `off` disables a selector; the wizard represents that as an un-toggled row (skip it).
      if (sel.level === "off") continue;
      if (sel.isAll) { this.rows.set("all", { level: sel.level, wildcard: true }); continue; }
      if (sel.tags.length === 1) this.rows.set(sel.tags[0], { level: sel.level, wildcard: sel.wildcard });
    }
    this.render();
  }

  private buildConfig(): string {
    const parts: string[] = [];
    for (const [tag, row] of this.rows) {
      const t = tag === "all" ? "all" : tag + (row.wildcard ? "*" : "");
      parts.push(`${t}=${row.level}`);
    }
    return parts.join(",");
  }

  private toggle(tag: string, on: boolean): void {
    if (on) this.rows.set(tag, this.rows.get(tag) ?? { level: "info", wildcard: true });
    else this.rows.delete(tag);
    this.onChange(this.buildConfig());
    this.render();
  }

  private setLevel(tag: string, level: LevelName): void {
    const row = this.rows.get(tag);
    if (row) { row.level = level; this.onChange(this.buildConfig()); }
  }

  private render(): void {
    const existing = this.root.querySelector<HTMLInputElement>(".wiz-filter");
    const filter = (existing?.value ?? "").toLowerCase();
    this.root.innerHTML = "";

    const search = el("input", "wiz-filter") as HTMLInputElement;
    search.setAttribute("type", "search");
    search.setAttribute("placeholder", "Filter tags…");
    search.value = filter;
    search.addEventListener("input", () => this.render());
    this.root.appendChild(search);

    const shown = this.tags.filter((t) => !filter || t.name.includes(filter) || t.description.toLowerCase().includes(filter));

    // Bucket the visible tags by their main tag (primary subsystem).
    const groups = new Map<string, TagInfo[]>();
    for (const t of shown) {
      const key = this.primaryOf.get(t.name) ?? t.name;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(t);
    }
    // While filtering, auto-expand every matching group so results are visible without clicking.
    const forceOpen = filter.length > 0;

    // A group with at least one live tag (for the current gc/platform) sorts above the fully-dead
    // groups; within each availability class, sort alphabetically by primary tag.
    const groupHasLive = (primary: string) => groups.get(primary)!.some((t) => this.isAvailable(t.name));
    const order = [...groups.keys()].sort((a, b) => {
      const la = groupHasLive(a), lb = groupHasLive(b);
      if (la !== lb) return la ? -1 : 1;
      return a.localeCompare(b);
    });
    for (const primary of order) {
      this.root.appendChild(this.group(primary, groups.get(primary)!, forceOpen));
    }
  }

  /** Build one collapsible group of tag rows, keyed by its main tag; starts closed unless expanded. */
  private group(primary: string, tags: TagInfo[], forceOpen: boolean): HTMLElement {
    const details = document.createElement("details");
    details.className = "wiz-group";
    const live = tags.filter((t) => this.isAvailable(t.name)).length;
    if (live === 0) details.classList.add("wiz-group-dead");
    const enabled = tags.filter((t) => this.rows.has(t.name)).length;
    details.open = forceOpen || this.open.has(primary) || enabled > 0;
    details.addEventListener("toggle", () => {
      if (details.open) this.open.add(primary);
      else this.open.delete(primary);
    });

    const summary = document.createElement("summary");
    summary.className = "wiz-group-head";
    summary.textContent = `${primary} (${tags.length}` + (enabled ? `, ${enabled} on` : "") + `)`;
    details.appendChild(summary);

    // Live tags first, then dead ones; stable within each class so the source order is preserved.
    const sorted = [...tags].sort((a, b) => Number(this.isAvailable(b.name)) - Number(this.isAvailable(a.name)));
    const list = el("div", "wiz-list");
    for (const t of sorted) list.appendChild(this.row(t));
    details.appendChild(list);
    return details;
  }

  /** Build one tag row (checkbox + label + level select), wired to the two-way binding. */
  private row(t: TagInfo): HTMLElement {
    const row = this.rows.get(t.name);
    const dead = !this.isAvailable(t.name);
    const item = el("div", "wiz-row" + (row ? " on" : "") + (dead ? " wiz-unavailable" : ""));
    if (dead) item.title = "No log sites for this tag under the current GC / platform selection";

    const cb = el("input", "wiz-cb") as HTMLInputElement;
    cb.type = "checkbox";
    cb.checked = !!row;
    cb.addEventListener("change", () => this.toggle(t.name, cb.checked));

    const label = el("label", "wiz-label");
    const name = el("span", "wiz-name"); name.textContent = t.name;
    const desc = el("span", "wiz-desc"); desc.textContent = t.description;
    label.append(name, desc);

    const lvl = el("select", "wiz-level") as HTMLSelectElement;
    for (const L of LEVELS) {
      const o = document.createElement("option"); o.value = L; o.textContent = L;
      if (row?.level === L) o.selected = true;
      lvl.appendChild(o);
    }
    lvl.disabled = !row;
    lvl.addEventListener("change", () => this.setLevel(t.name, lvl.value as LevelName));

    item.append(cb, label, lvl);
    return item;
  }
}

function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

export type { Selector };
