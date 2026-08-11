// SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
// SPDX-License-Identifier: GPL-2.0-only

import { SiteJson } from "./types";

/**
 * HotSpot organises platform-specific source under three trees:
 *   src/hotspot/os/<os>/           — OS-specific (linux, bsd, windows, aix, posix)
 *   src/hotspot/os_cpu/<os>_<cpu>/ — OS+CPU-specific
 *   src/hotspot/cpu/<cpu>/         — CPU-specific
 * Everything else (src/hotspot/share/…) is platform-independent.
 *
 * A user browsing on Linux never runs the bsd/windows/aix code, so those log sites can never fire
 * for them. The platform selector lets them hide the OS trees that don't apply. We filter on the OS
 * dimension only: `posix` is shared by the Unix family (linux/bsd/aix) but NOT windows; `cpu/` sites
 * (a handful) are left visible since arch selection isn't offered.
 */

/** The OS values the selector offers, plus "all" (no filtering). Value → display label. */
export const PLATFORMS: { value: string; label: string }[] = [
  { value: "all", label: "All platforms" },
  { value: "linux", label: "Linux" },
  { value: "bsd", label: "macOS/BSD" },
  { value: "windows", label: "Windows" },
  { value: "aix", label: "AIX" },
];

/** OS dir names each platform includes. `posix` is shared across the Unix family. */
const OS_DIRS_FOR: Record<string, Set<string>> = {
  linux: new Set(["linux", "posix"]),
  bsd: new Set(["bsd", "posix"]),
  aix: new Set(["aix", "posix"]),
  windows: new Set(["windows"]),
};

const OS_RE = /^src\/hotspot\/os\/([^/]+)\//;
const OS_CPU_RE = /^src\/hotspot\/os_cpu\/([^/_]+)_/;

/**
 * Should a site be shown for the selected platform? `platform === "all"` shows everything. A site
 * under an OS tree (os/<x> or os_cpu/<x>_…) is shown only if <x> belongs to the selected OS; sites
 * outside any OS tree (share/, cpu/) are always shown.
 */
export function sitePlatformVisible(site: SiteJson, platform: string): boolean {
  if (platform === "all") return true;
  const allowed = OS_DIRS_FOR[platform];
  if (!allowed) return true;
  const os = OS_RE.exec(site.file) ?? OS_CPU_RE.exec(site.file);
  if (!os) return true; // share/ or cpu/ — platform-independent
  return allowed.has(os[1]);
}

/** Filter a firing set down to the sites visible on the selected platform. */
export function filterByPlatform(sites: SiteJson[], platform: string): SiteJson[] {
  if (platform === "all") return sites;
  return sites.filter((s) => sitePlatformVisible(s, platform));
}

/**
 * HotSpot keeps each collector's code under `src/hotspot/share/gc/<collector>/` (and the OS trees
 * mirror this: `os/<os>/gc/<collector>/…`). A file under one collector's dir can never fire for a
 * different collector, so the GC selector hides the other collectors' dirs. `gc/shared/` common
 * code, plus everything outside a `gc/<collector>/` dir, stays visible.
 */
const GC_DIR_FOR: Record<string, string> = { G1: "g1", ZGC: "z", Parallel: "parallel" };
const OTHER_GC_DIRS = new Set(["g1", "z", "parallel", "shenandoah", "serial", "epsilon"]);
const GC_DIR_RE = /\/gc\/([^/]+)\//;

/**
 * Should a site be shown for the selected GC? A site under `…/gc/<collector>/…` is shown only if
 * <collector> is the selected GC (or a non-collector dir like `shared`); sites outside any
 * `gc/<collector>/` dir are always shown.
 */
export function siteGcVisible(site: SiteJson, gc: string): boolean {
  const m = GC_DIR_RE.exec(site.file);
  if (!m) return true; // not under a per-collector dir
  const dir = m[1];
  if (!OTHER_GC_DIRS.has(dir)) return true; // shared/common GC code
  return dir === GC_DIR_FOR[gc];
}

/** Filter a firing set down to the sites that belong to the selected collector. */
export function filterByGc(sites: SiteJson[], gc: string): SiteJson[] {
  return sites.filter((s) => siteGcVisible(s, gc));
}
