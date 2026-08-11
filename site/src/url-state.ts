// SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
// SPDX-License-Identifier: GPL-2.0-only

/** The shareable slice of app state: version, GC, platform, the -Xlog config, and view position. */
export interface UrlState {
  version?: string;
  gc?: string;
  platform?: string;
  config?: string;
  /** Active tab panel id (e.g. `tab-sites`); validated against known panels by the caller. */
  tab?: string;
  /** Sites-tab filter query. Omitted from the hash when empty. */
  q?: string;
  /** Transient deep-link to a specific firing block (`block-<id>`); only ever set via "Link". */
  block?: string;
}

/** Read version / GC / platform / config / tab / filter from the location hash. */
export function readUrlState(): UrlState {
  const raw = location.hash.replace(/^#/, "");
  if (!raw) return {};
  const p = new URLSearchParams(raw);
  const out: UrlState = {};
  const v = p.get("v");
  const gc = p.get("gc");
  const plat = p.get("plat");
  const xlog = p.get("xlog");
  const tab = p.get("tab");
  const q = p.get("q");
  const block = p.get("b");
  if (v) out.version = v;
  if (gc) out.gc = gc;
  if (plat) out.platform = plat;
  if (xlog !== null) out.config = xlog;
  if (tab) out.tab = tab;
  if (q) out.q = q;
  if (block) out.block = block;
  return out;
}

/**
 * Write the state into the location hash without pushing a history entry (replaceState), so typing
 * in the config box doesn't spam the back button. `tab`/`q` are persisted; `q` is omitted when
 * empty so plain links stay clean. `block` is only written when explicitly passed (the "Link"
 * button) and is intentionally left out of the resting hash.
 */
export function writeUrlState(state: {
  version: string;
  gc: string;
  platform: string;
  config: string;
  tab?: string;
  sitesQuery?: string;
  block?: string;
}): void {
  const p = new URLSearchParams();
  p.set("v", state.version);
  p.set("gc", state.gc);
  p.set("plat", state.platform);
  p.set("xlog", state.config);
  if (state.tab) p.set("tab", state.tab);
  if (state.sitesQuery) p.set("q", state.sitesQuery);
  if (state.block) p.set("b", state.block);
  history.replaceState(null, "", "#" + p.toString());
}
