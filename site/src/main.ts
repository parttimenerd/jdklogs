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
import { buildPresence, Presence } from "./versions";

const DATA_BASE = "./data/";
// Candidate versions we may ship (head = openjdk/jdk master; LTS lines by number). Which ones are
// actually offered is decided at startup by probing for each `<version>.json` — so a version lights
// up automatically once CI has generated + cached its data, with no code change here.
const VERSION_CANDIDATES = ["head", "21", "25"];
// Effective, present-at-runtime versions; filled by detectVersions() before the selector is built.
let VERSIONS: string[] = ["head"];
const GCS = ["G1", "ZGC", "Parallel"];
const PLATFORM_VALUES = PLATFORMS.map((p) => p.value);

interface State {
  version: string;
  gc: string;
  platform: string;
  config: string;
  tab: string;
  sitesQuery: string;
  data: VersionData | null;
  tags: TagsData | null;
  mappings: JfrMapping[];
  coverage: CoverageRule[];
}

const state: State = {
  version: VERSIONS[0], gc: "G1", platform: "linux", config: "gc*=info", tab: "tab-sites", sitesQuery: "",
  data: null, tags: null, mappings: [], coverage: [],
};

const PANEL_IDS = ["tab-sites", "tab-summary", "tab-coverage", "tab-log"];

// One-line "what am I looking at" caption shown under the tab bar for the active panel. Newcomers
// can't predict what "JFR coverage" or "Summary" hold from the label alone; this names each tab's job.
const TAB_INTROS: Record<string, string> = {
  "tab-sites": "Every OpenJDK log statement your selector switches on, grouped by source file.",
  "tab-summary": "Warnings about your selector plus an estimated log volume for the selected GC.",
  "tab-coverage": "Which of these log lines a JFR event can replace — and the .jfc to record them instead.",
  "tab-log": "A real captured log for this selector, from a Renaissance benchmark run.",
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

/** Probe each candidate `<version>.json` in parallel and keep only those that respond OK, in
 *  candidate order (head first). This is what makes 21/25 light up automatically once CI has
 *  generated + cached their data — no code change here. Falls back to `["head"]` if the probe
 *  finds nothing (head is always cached, so that shouldn't happen). 404s for absent versions are
 *  expected and swallowed. */
async function detectVersions(): Promise<string[]> {
  const results = await Promise.all(
    VERSION_CANDIDATES.map((v) =>
      fetch(`${DATA_BASE}${v}.json`, { method: "HEAD" })
        .then((r) => r.ok)
        .catch(() => false)
    )
  );
  const present = VERSION_CANDIDATES.filter((_, i) => results[i]);
  return present.length > 0 ? present : ["head"];
}

/** Fills the right-aligned data-freshness segment of the header meta line: which OpenJDK commit the
 *  data was scanned from, and when. Rendered as "data <date> from <repo> @ <sha>", with the SHA
 *  linking to the commit. Cleared if the fields are absent (older data). */
function renderProvenance(): void {
  const el = document.querySelector<HTMLElement>("#data-provenance");
  if (!el || !state.data) return;
  el.textContent = "";
  const { generatedAt, commitSha, repo } = state.data;
  if (!generatedAt || !commitSha || !repo) return;
  const date = new Date(generatedAt).toISOString().slice(0, 10); // UTC, locale-free
  const short = commitSha.slice(0, 7);
  el.appendChild(document.createTextNode(`data ${date} from ${repo} @ `));
  const a = document.createElement("a");
  a.href = `https://github.com/${repo}/commit/${commitSha}`;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = short;
  el.appendChild(a);
}

let wizard: Wizard | null = null;
let logSearch: LogSearch | null = null;
// Tags with at least one log site for the current gc/platform. Shared by the wizard (grey-out) and
// the autocomplete dropdown (dead-tag signal); recomputed in updateWizardAvailability().
let availableTags: Set<string> | null = null;

// Cross-version site presence, built after first paint from ALL present versions' JSON. Null until
// built (and stays effectively empty when only one version is present — see versionBadge()).
let presence: Presence | null = null;

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

/** Build a shareable href pointing at a specific firing block, without leaving `b` in the resting
 *  hash: write the state with the extra `block` field, snapshot the URL, then rewrite it clean. */
function blockLinkFor(blockId: string): string {
  writeUrlState({ ...state, tab: "tab-sites", block: blockId });
  const href = location.href;
  writeUrlState(state);
  return href;
}

/** Render one tab panel from the current derived results, if it hasn't been rendered since recompute. */
function renderPanel(panelId: string): void {
  if (!state.data || !derived) return;
  const { fires, warnings, vol } = derived;
  if (panelId === "tab-sites" && !rendered.sites) {
    renderFiringSites(
      $("#tab-sites"), state.data, fires, state.gc,
      state.sitesQuery,
      (q) => { state.sitesQuery = q; writeUrlState(state); },
      blockLinkFor,
      (cfg) => setConfig(cfg)
    );
    rendered.sites = true;
  } else if (panelId === "tab-summary" && !rendered.summary) {
    renderSummary($("#tab-summary"), fires, warnings, vol, (file) => {
      // Jump to the Sites tab filtered to this file: set the filter, switch tabs, persist, render.
      state.sitesQuery = file;
      state.tab = "tab-sites";
      rendered.sites = false;
      writeUrlState(state);
      activateTab("tab-sites");
      document.querySelector<HTMLElement>(".tab.active")?.scrollIntoView({ block: "nearest" });
    });
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
  if (!state.data) return;
  const visible = filterByGc(filterByPlatform(state.data.sites, state.platform), state.gc);
  const available = new Set<string>();
  for (const s of visible) for (const t of s.tags) available.add(t);
  availableTags = available;
  wizard?.setAvailableTags(available);
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
    items = suggest(input.value, input.selectionStart ?? input.value.length, state.tags.tags, availableTags ?? undefined);
    drop.innerHTML = "";
    if (items.length === 0) { close(); return; }
    items.forEach((s, i) => {
      const el = document.createElement("div");
      el.className = "ac-item" + (i === active ? " active" : "") + (s.dead ? " ac-dead" : "");
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
/** Activate a tab panel by id: toggle the active classes, lazily render it, and (for the log tab)
 *  load the sample log. Does NOT write the URL — callers decide whether the change is persisted. */
function activateTab(panelId: string): void {
  const tab = document.querySelector<HTMLElement>(`.tab[data-panel="${panelId}"]`);
  if (!tab) return;
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
  tab.classList.add("active");
  $("#" + panelId).classList.add("active");
  const intro = document.querySelector<HTMLElement>("#tab-intro");
  if (intro) intro.textContent = TAB_INTROS[panelId] ?? "";
  renderPanel(panelId);
  if (panelId === "tab-log" && logSearch && state.data) {
    logSearch.show(state.version, state.gc, state.data.sampleLogFiles[state.gc]);
  }
}

function setupTabs(): void {
  document.querySelectorAll<HTMLElement>(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const panel = tab.dataset.panel!;
      state.tab = panel;
      writeUrlState(state);
      activateTab(panel);
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
  // Probe which versions CI has actually generated, before touching the selector or the URL state.
  VERSIONS = await detectVersions();
  state.version = VERSIONS[0];

  // restore shareable state from the URL hash (validate against detected versions/known GCs)
  const url = readUrlState();
  if (url.version && VERSIONS.includes(url.version)) state.version = url.version;
  if (url.gc && GCS.includes(url.gc)) state.gc = url.gc;
  if (url.platform && PLATFORM_VALUES.includes(url.platform)) state.platform = url.platform;
  if (url.config !== undefined) state.config = url.config;
  if (url.tab && PANEL_IDS.includes(url.tab)) state.tab = url.tab;
  if (url.q) state.sitesQuery = url.q;
  const deepLinkBlock = url.block;

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
    renderProvenance();
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
  renderProvenance();

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
    $("#wizard-toggle").textContent = $("#wizard").classList.contains("open") ? "Hide logging categories" : "Browse logging categories";
  });

  setupAutocomplete();
  setupTabs();
  setupCopyButtons();
  setupConfigHint();

  const input = $("#config") as HTMLInputElement;
  input.value = state.config;
  wizard.syncFromConfig(state.config);

  // Restore the active tab from the URL before the first render, so a shared link lands on the
  // right panel (and only that panel renders — the others stay lazy).
  recompute();
  rendered.sites = rendered.summary = rendered.coverage = false;
  activateTab(state.tab);

  // Version-specific labeling: after the selected version has painted, fetch every OTHER present
  // version's JSON in parallel, build the presence map, and re-render the Sites tab so badges appear.
  // With only one present version this is a no-op the user never sees. 404s can't happen (we only
  // fetch detected versions), but guard anyway so a transient failure never blanks the site.
  if (VERSIONS.length > 1 && state.data) {
    const others = VERSIONS.filter((v) => v !== state.version);
    Promise.all(
      others.map((v) =>
        fetch(`${DATA_BASE}${v}.json`).then((r) => (r.ok ? (r.json() as Promise<VersionData>) : null)).catch(() => null)
      )
    ).then((loaded) => {
      const datas = [state.data!, ...loaded.filter((d): d is VersionData => d !== null)];
      presence = buildPresence(datas, VERSIONS);
      rendered.sites = false;           // invalidate so badges render on next paint
      renderPanel(activePanelId());
    });
  }

  // Deep-link to a specific firing block: force the Sites tab, scroll it into view, and flash it.
  // Defer to the next frame so the just-rendered block list is laid out before we measure/scroll.
  if (deepLinkBlock) {
    if (state.tab !== "tab-sites") { state.tab = "tab-sites"; activateTab("tab-sites"); }
    requestAnimationFrame(() => {
      const target = document.getElementById("block-" + deepLinkBlock);
      if (target) {
        // File groups render collapsed by default; open the one containing the deep-linked block so
        // it can actually be scrolled into view (a closed <details> hides its content from layout).
        target.closest("details.file-group")?.setAttribute("open", "");
        target.scrollIntoView({ block: "center" });
        target.classList.add("block-flash");
        setTimeout(() => target.classList.remove("block-flash"), 1500);
      }
    });
  }

  input.focus();
  input.select();
}

main();
