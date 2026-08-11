// SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
// SPDX-License-Identifier: GPL-2.0-only

import "prismjs/themes/prism.css";
import "./style.css";
import { CoverageData, CoverageRule, JfrMapping, SiteJson, TagsData, VersionData } from "./types";
import { firingSites, parseConfig } from "./selector";
import { analyzeConfig, estimateVolume, Warning } from "./analysis";
import { suggest, applySuggestion, nearestTag, Suggestion } from "./autocomplete";
import { Wizard } from "./wizard";
import { renderFiringSites } from "./results";
import { renderSummary } from "./summary";
import { renderCoverageTab } from "./coverage-view";
import { LogSearch } from "./log-search";
import { highlightConfig } from "./highlight-config";
import { readUrlState, writeUrlState } from "./url-state";
import { copyToClipboard } from "./clipboard";
import { PLATFORMS, filterByPlatform, filterByGc } from "./platform";

const DATA_BASE = "./data/";
// Versions we ship (head = openjdk/jdk master). Add release branches here as data is generated.
const VERSIONS = ["head"];
const GCS = ["G1", "ZGC", "Parallel"];
const PLATFORM_VALUES = PLATFORMS.map((p) => p.value);

interface State {
  version: string;
  gc: string;
  platform: string;
  config: string;
  data: VersionData | null;
  tags: TagsData | null;
  mappings: JfrMapping[];
  coverage: CoverageRule[];
}

const state: State = {
  version: VERSIONS[0], gc: "G1", platform: "linux", config: "gc*=info",
  data: null, tags: null, mappings: [], coverage: [],
};

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

async function loadData(version: string): Promise<void> {
  const [data, tags, mappings, coverage] = await Promise.all([
    fetch(`${DATA_BASE}${version}.json`).then((r) => r.json() as Promise<VersionData>),
    state.tags ? Promise.resolve(state.tags) : fetch(`${DATA_BASE}tags.json`).then((r) => r.json() as Promise<TagsData>),
    fetch(`${DATA_BASE}jfr-mappings.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
    fetch(`${DATA_BASE}jfr-coverage.json`).then((r) => (r.ok ? r.json() : { rules: [] })).catch(() => ({ rules: [] })),
  ]);
  state.data = data;
  state.tags = tags;
  state.mappings = mappings as JfrMapping[];
  state.coverage = (coverage as CoverageData).rules ?? [];
}

let wizard: Wizard | null = null;
let logSearch: LogSearch | null = null;

// Current derived results, recomputed on config/gc/version change and consumed lazily per tab. Only
// the active tab is rendered on each change; the others are marked dirty and rendered when shown —
// rendering all three (each up to ~2600 highlighted blocks) on every keystroke was the bottleneck.
interface Derived { fires: SiteJson[]; warnings: Warning[]; vol: ReturnType<typeof estimateVolume>; }
let derived: Derived | null = null;
const rendered = { sites: false, summary: false, coverage: false };

function recompute(): void {
  if (!state.data || !state.tags) return;
  const errBox = $("#error");

  const { selectors, error } = parseConfig(state.config);

  const known = new Set(state.tags.tags.map((t) => t.name));
  $("#config-hl").innerHTML = highlightConfig(state.config, known, error ? error.index : null);

  // syntax error
  if (error) {
    errBox.textContent = error.message;
    errBox.classList.add("show");
  } else {
    // semantic: unknown tags
    const unknown: string[] = [];
    for (const sel of selectors) for (const t of sel.tags) if (!known.has(t)) unknown.push(t);
    if (unknown.length > 0) {
      const t0 = unknown[0];
      const near = nearestTag(t0, state.tags.tags);
      errBox.textContent = `Unknown tag \`${t0}\`` + (near ? `. Did you mean \`${near}\`?` : ".");
      errBox.classList.add("show");
    } else {
      errBox.classList.remove("show");
    }
  }

  // Platform filter: hide OS-specific sites (os/<x>, os_cpu/<x>_…) that can't run on the selected
  // platform, so a Linux user isn't shown bsd/windows/aix log lines. share/ and cpu/ stay visible.
  // GC filter: hide other collectors' gc/<collector>/ dirs, so G1 doesn't show ZGC-only files.
  const allFires = error ? [] : firingSites(selectors, state.data.sites);
  const fires = filterByGc(filterByPlatform(allFires, state.platform), state.gc);
  const warnings = error ? [] : analyzeConfig(selectors, state.data.sites);
  const vol = estimateVolume(fires, state.data.volumeStats, state.gc);
  derived = { fires, warnings, vol };

  const btn = document.querySelector<HTMLElement>("#tab-summary-btn");
  if (btn) btn.textContent = warnings.length > 0 ? `Summary · ${warnings.length}` : "Summary";
}

function activePanelId(): string {
  const active = document.querySelector<HTMLElement>(".tab.active");
  return active?.dataset.panel ?? "tab-sites";
}

/** Render one tab panel from the current derived results, if it hasn't been rendered since recompute. */
function renderPanel(panelId: string): void {
  if (!state.data || !derived) return;
  const { fires, warnings, vol } = derived;
  if (panelId === "tab-sites" && !rendered.sites) {
    renderFiringSites($("#tab-sites"), state.data, fires, state.gc);
    rendered.sites = true;
  } else if (panelId === "tab-summary" && !rendered.summary) {
    renderSummary($("#tab-summary"), fires, warnings, vol);
    rendered.summary = true;
  } else if (panelId === "tab-coverage" && !rendered.coverage) {
    renderCoverageTab($("#tab-coverage"), state.data, fires, state.mappings, state.coverage, state.gc);
    rendered.coverage = true;
  }
}

/** Recompute derived results and render only the visible tab; mark the rest dirty for lazy render. */
function rerender(): void {
  recompute();
  rendered.sites = rendered.summary = rendered.coverage = false;
  renderPanel(activePanelId());
}

/**
 * Tell the wizard which tags can actually fire under the current gc/platform selection, so it can
 * grey out and sort-down the tags whose only log sites live in a hidden GC/OS tree. Independent of
 * the -Xlog config (it reflects the data set, not the selector), so this is driven by gc/platform.
 */
function updateWizardAvailability(): void {
  if (!wizard || !state.data) return;
  const visible = filterByGc(filterByPlatform(state.data.sites, state.platform), state.gc);
  const available = new Set<string>();
  for (const s of visible) for (const t of s.tags) available.add(t);
  wizard.setAvailableTags(available);
}

function setConfig(text: string, fromWizard = false): void {
  state.config = text;
  const input = $("#config") as HTMLInputElement;
  if (input.value !== text) input.value = text;
  if (!fromWizard && wizard) wizard.syncFromConfig(text);
  writeUrlState(state);
  rerender();
}

// --- autocomplete dropdown -------------------------------------------------
function setupAutocomplete(): void {
  const input = $("#config") as HTMLInputElement;
  const drop = $("#autocomplete");
  let items: Suggestion[] = [];
  let active = -1;

  const close = () => { drop.classList.remove("show"); active = -1; };
  const syncScroll = () => { $("#config-hl").scrollLeft = input.scrollLeft; };

  const refresh = () => {
    if (!state.tags) return;
    items = suggest(input.value, input.selectionStart ?? input.value.length, state.tags.tags);
    drop.innerHTML = "";
    if (items.length === 0) { close(); return; }
    items.forEach((s, i) => {
      const el = document.createElement("div");
      el.className = "ac-item" + (i === active ? " active" : "");
      el.innerHTML = `<span class="ac-text">${s.text}</span>` + (s.detail ? `<span class="ac-detail">${s.detail}</span>` : "");
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const [next, caret] = applySuggestion(input.value, input.selectionStart ?? input.value.length, s);
        setConfig(next);
        input.focus();
        input.setSelectionRange(caret, caret);
        close();
      });
      drop.appendChild(el);
    });
    drop.classList.add("show");
  };

  input.addEventListener("input", () => { setConfig(input.value); refresh(); syncScroll(); });
  input.addEventListener("scroll", syncScroll);
  input.addEventListener("keydown", (e) => {
    if (!drop.classList.contains("show")) return;
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, items.length - 1); refresh(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, 0); refresh(); }
    else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      const [next, caret] = applySuggestion(input.value, input.selectionStart ?? input.value.length, items[active]);
      setConfig(next);
      input.setSelectionRange(caret, caret);
      close();
    } else if (e.key === "Escape") close();
  });
  input.addEventListener("blur", () => setTimeout(close, 150));
}

// --- tabs ------------------------------------------------------------------
function setupTabs(): void {
  document.querySelectorAll<HTMLElement>(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      const panel = $("#" + tab.dataset.panel);
      panel.classList.add("active");
      renderPanel(tab.dataset.panel!);   // lazy: render this tab now if it was dirtied since last recompute
      if (tab.dataset.panel === "tab-log" && logSearch && state.data) {
        logSearch.show(state.version, state.gc, state.data.sampleLogFiles[state.gc]);
      }
    });
  });
}

// --- copy / share buttons --------------------------------------------------
function setupCopyButtons(): void {
  const copyBtn = $("#config-copy");
  copyBtn.addEventListener("click", () => copyToClipboard(state.config, copyBtn));

  const shareBtn = $("#share-link");
  shareBtn.addEventListener("click", () => {
    writeUrlState(state); // make sure the hash reflects the current state before copying it
    copyToClipboard(location.href, shareBtn);
  });
}

// --- first-run hint: clickable example selectors ---------------------------
function setupConfigHint(): void {
  const hint = $("#config-hint");
  hint.appendChild(document.createTextNode("Try: "));
  const examples = ["gc*=info", "gc+heap=debug", "safepoint=info"];
  examples.forEach((ex, i) => {
    if (i > 0) hint.appendChild(document.createTextNode(" · "));
    const a = document.createElement("a");
    a.className = "hint-ex";
    a.textContent = ex;
    a.addEventListener("click", () => {
      setConfig(ex);
      ($("#config") as HTMLInputElement).focus();
    });
    hint.appendChild(a);
  });
}

async function main(): Promise<void> {
  // restore shareable state from the URL hash (validate against known versions/GCs)
  const url = readUrlState();
  if (url.version && VERSIONS.includes(url.version)) state.version = url.version;
  if (url.gc && GCS.includes(url.gc)) state.gc = url.gc;
  if (url.platform && PLATFORM_VALUES.includes(url.platform)) state.platform = url.platform;
  if (url.config !== undefined) state.config = url.config;

  // version selector
  const vsel = $("#version") as HTMLSelectElement;
  for (const v of VERSIONS) {
    const o = document.createElement("option"); o.value = v; o.textContent = v; vsel.appendChild(o);
  }
  vsel.value = state.version;
  vsel.addEventListener("change", async () => {
    state.version = vsel.value;
    await loadData(state.version);
    writeUrlState(state);
    updateWizardAvailability();
    rerender();
  });

  // gc selector
  const gsel = $("#gc") as HTMLSelectElement;
  for (const g of GCS) {
    const o = document.createElement("option"); o.value = g; o.textContent = g; gsel.appendChild(o);
  }
  gsel.value = state.gc;
  gsel.addEventListener("change", () => {
    state.gc = gsel.value;
    writeUrlState(state);
    updateWizardAvailability();
    rerender();
    if ($("#tab-log").classList.contains("active") && logSearch && state.data)
      logSearch.show(state.version, state.gc, state.data.sampleLogFiles[state.gc]);
  });

  // platform selector (hides OS-specific sites that can't run on the chosen platform)
  const psel = $("#platform") as HTMLSelectElement;
  for (const p of PLATFORMS) {
    const o = document.createElement("option"); o.value = p.value; o.textContent = p.label; psel.appendChild(o);
  }
  psel.value = state.platform;
  psel.addEventListener("change", () => {
    state.platform = psel.value;
    writeUrlState(state);
    updateWizardAvailability();
    rerender();
  });

  await loadData(state.version);

  // Group each tag under its "main tag" (primary subsystem) for the wizard. A tag that appears as
  // the first tag of some site is its own primary; a modifier tag (e.g. `ergo`, never first) is
  // assigned to the primary it co-occurs with most often. Drives the wizard's collapsible groups.
  const firstTagCount = new Map<string, Map<string, number>>(); // tag -> (candidate primary -> count)
  const isPrimary = new Set<string>();
  for (const s of state.data!.sites) {
    if (s.tags.length === 0) continue;
    const p = s.tags[0];
    isPrimary.add(p);
    for (const t of s.tags) {
      const m = firstTagCount.get(t) ?? new Map<string, number>();
      m.set(p, (m.get(p) ?? 0) + 1);
      firstTagCount.set(t, m);
    }
  }
  const primaryOf = new Map<string, string>();
  for (const t of state.tags!.tags) {
    if (isPrimary.has(t.name)) { primaryOf.set(t.name, t.name); continue; }
    const m = firstTagCount.get(t.name);
    if (m) {
      const best = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
      primaryOf.set(t.name, best);
    } else {
      primaryOf.set(t.name, t.name); // orphan tag with no site: its own group
    }
  }

  wizard = new Wizard($("#wizard"), state.tags!.tags, primaryOf, (cfg) => setConfig(cfg, true));
  logSearch = new LogSearch($("#tab-log"), DATA_BASE);
  updateWizardAvailability();

  $("#wizard-toggle").addEventListener("click", () => {
    $("#wizard").classList.toggle("open");
    $("#wizard-toggle").textContent = $("#wizard").classList.contains("open") ? "Hide tag wizard" : "Show tag wizard";
  });

  setupAutocomplete();
  setupTabs();
  setupCopyButtons();
  setupConfigHint();

  const input = $("#config") as HTMLInputElement;
  input.value = state.config;
  wizard.syncFromConfig(state.config);
  rerender();
  input.focus();
  input.select();
}

main();
