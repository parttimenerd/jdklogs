// SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
// SPDX-License-Identifier: GPL-2.0-only

/** The shareable slice of app state: version, GC, platform, and the -Xlog config. */
export interface UrlState {
  version?: string;
  gc?: string;
  platform?: string;
  config?: string;
}

/** Read version / GC / platform / config from the location hash (`#v=…&gc=…&plat=…&xlog=…`). */
export function readUrlState(): UrlState {
  const raw = location.hash.replace(/^#/, "");
  if (!raw) return {};
  const p = new URLSearchParams(raw);
  const out: UrlState = {};
  const v = p.get("v");
  const gc = p.get("gc");
  const plat = p.get("plat");
  const xlog = p.get("xlog");
  if (v) out.version = v;
  if (gc) out.gc = gc;
  if (plat) out.platform = plat;
  if (xlog !== null) out.config = xlog;
  return out;
}

/**
 * Write the state into the location hash without pushing a history entry (replaceState), so typing
 * in the config box doesn't spam the back button.
 */
export function writeUrlState(state: { version: string; gc: string; platform: string; config: string }): void {
  const p = new URLSearchParams();
  p.set("v", state.version);
  p.set("gc", state.gc);
  p.set("plat", state.platform);
  p.set("xlog", state.config);
  history.replaceState(null, "", "#" + p.toString());
}
