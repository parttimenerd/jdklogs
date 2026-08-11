// SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// Oracle test: the HotSpot JVM is ground truth for -Xlog selector semantics. For a set of
// configs we ask a real JVM which (level, tagset) combinations it emits (running a tiny
// System.gc() workload), then assert our TS matcher (siteFires) reproduces the SAME fire /
// no-fire decision for every observed tagset — at the emitted level (must fire) and at a
// level one notch too high (must NOT fire), plus control tagsets the JVM never emitted.
//
// Run with:  node --import tsx site/test/oracle.mts   (or via the npm script)

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, siteFires } from "../src/selector.ts";
import { LevelName, LEVELS, SiteJson } from "../src/types.ts";

const JAVA = process.env.JAVA ?? "java";

const PROG = `public class P { public static void main(String[] a) throws Exception {
  System.gc(); Thread.sleep(50); System.gc();
} }`;
const progPath = join(tmpdir(), "OracleP.java");
writeFileSync(progPath, PROG);

/** Ask the JVM: for this config, which (level, tagset) combos does it actually emit? */
function jvmEmitted(cfg: string): Set<string> {
  let out = "";
  try {
    out = execFileSync(JAVA, [`-Xlog:${cfg}:stdout:level,tags`, progPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e: any) {
    out = (e.stdout ?? "") + (e.stderr ?? "");
  }
  const set = new Set<string>();
  for (const line of out.split("\n")) {
    const m = /^\[\s*([a-z]+)\s*\]\[\s*([a-z0-9,+]+)\s*\]/.exec(line);
    if (m) set.add(`${m[1]}|${m[2].split(",").sort().join("+")}`);
  }
  return set;
}

function site(level: LevelName, tags: string[]): SiteJson {
  return {
    id: "t", level, tags, file: "x", blockId: "x|1-1",
    funcSignature: null, samples: {}, formatString: null,
  };
}

function lower(level: LevelName): LevelName | null {
  const i = LEVELS.indexOf(level);
  return i > 0 ? LEVELS[i - 1] : null; // one notch more verbose = "too high to fire"
}

const CONFIGS = [
  "gc=info",
  "gc*=info",
  "gc*=debug",
  "gc+heap=debug",
  "gc*=info,gc+init=off",
];

// Control tagsets the JVM does not emit at startup — the matcher must not fire them for a
// gc-scoped config. (Exact sets, so a gc* superset selector won't match them.)
const CONTROLS: string[][] = [["compiler"], ["jit"], ["os"], ["metaspace", "map"]];

let failures = 0;
let checks = 0;

for (const cfg of CONFIGS) {
  const { selectors, error } = parseConfig(cfg);
  if (error) { console.error(`PARSE FAIL ${cfg}: ${error.message}`); failures++; continue; }
  const emitted = jvmEmitted(cfg);
  if (emitted.size === 0) { console.error(`WARN ${cfg}: JVM emitted nothing (skipping)`); continue; }

  for (const key of emitted) {
    const [lvl, tagsetStr] = key.split("|");
    const tags = tagsetStr.split("+");
    const level = lvl as LevelName;

    // 1. must fire at the emitted level
    checks++;
    if (!siteFires(selectors, site(level, tags))) {
      console.error(`MISMATCH ${cfg}: expected FIRE ${key}, matcher said NO`);
      failures++;
    }

    // 2. a hypothetical site one notch more verbose than the winning level must NOT fire
    //    (the config's level gate should exclude it) — only checked when the emitted level
    //    equals the config's intent, i.e. there is a strictly-more-verbose level.
    const lo = lower(level);
    if (lo) {
      // find the winning selector's level for this tagset to know the gate
      const win = siteFires(selectors, site(level, tags));
      if (win && LEVELS.indexOf(win.level) < LEVELS.indexOf(level)) {
        // winner is more verbose than the site -> a lower (more verbose) site should still fire;
        // skip — this case isn't a clean negative. Only assert negative when winner==level.
      } else if (win && win.level === level) {
        checks++;
        if (siteFires(selectors, site(lo, tags))) {
          console.error(`MISMATCH ${cfg}: expected NO-FIRE ${lo}|${tagsetStr} (below gate), matcher said YES`);
          failures++;
        }
      }
    }
  }

  // 3. control tagsets never emitted -> matcher must not fire them
  for (const ctags of CONTROLS) {
    checks++;
    if (siteFires(selectors, site("info", ctags))) {
      console.error(`MISMATCH ${cfg}: expected NO-FIRE control info|${ctags.join("+")}, matcher said YES`);
      failures++;
    }
  }
  console.log(`ok  ${cfg}  (${emitted.size} emitted tagsets)`);
}

console.log(`\n${checks} checks, ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
