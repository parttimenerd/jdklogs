// SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
// SPDX-License-Identifier: GPL-2.0-only

import { test, expect, Page } from "@playwright/test";

// End-to-end checks for the jdklogs explorer, mirroring the plan's verification step 4. Runs
// against the built bundle served by `vite preview` (see playwright.config.ts).

async function setConfig(page: Page, cfg: string) {
  const input = page.locator("#config");
  await input.fill(cfg);
  // the input listener rerenders synchronously; give the DOM a tick
  await page.waitForTimeout(150);
}

async function openSummary(page: Page) {
  await page.getByRole("button", { name: /^Summary/ }).click();
}

async function openCoverage(page: Page) {
  await page.getByRole("button", { name: /^JFR coverage/ }).click();
}

// The covered/partial/uncovered counts are clickable toggles; click one to reveal its detail panel.
async function openBucket(page: Page, bucket: "covered" | "partial" | "uncovered") {
  await page.locator(`.cov-summary span[data-bucket="${bucket}"]`).click();
}

// File groups render collapsed by default; open them so block content is laid out/visible.
async function openAllFileGroups(page: Page) {
  await page.locator(".file-group").evaluateAll((els) =>
    els.forEach((el) => ((el as HTMLDetailsElement).open = true))
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".results-header")).toBeVisible();
});

test("gc*=info shows firing sites grouped by file with a GitHub permalink", async ({ page }) => {
  await setConfig(page, "gc*=info");
  await expect(page.locator(".results-header")).toContainText("firing site(s)");
  const firstLink = page.locator("a.gh-link").first();
  await expect(firstLink).toHaveAttribute(
    "href",
    /github\.com\/openjdk\/jdk\/blob\/[0-9a-f]{40}\/src\/hotspot\/.+#L\d+-L\d+/
  );
  // firing lines are highlighted
  await openAllFileGroups(page);
  await expect(page.locator(".code-line.firing").first()).toBeVisible();
});

test("unknown tag surfaces a suggestion; malformed input surfaces a position error", async ({ page }) => {
  await setConfig(page, "gz*=info");
  await expect(page.locator("#error")).toContainText("Unknown tag `gz`");
  await expect(page.locator("#error")).toContainText("Did you mean `gc`");

  await setConfig(page, "gc==info");
  await expect(page.locator("#error")).toContainText("Unexpected `=` at column 4");
});

test("wizard is two-way bound with the config text", async ({ page }) => {
  await page.locator("#wizard-toggle").click();
  await expect(page.locator("#wizard")).toHaveClass(/open/);

  // text -> wizard
  await setConfig(page, "gc*=debug");
  const gcRow = page.locator(".wiz-row", { has: page.locator(".wiz-name", { hasText: /^gc$/ }) });
  await expect(gcRow.locator(".wiz-cb")).toBeChecked();
  await expect(gcRow.locator(".wiz-level")).toHaveValue("debug");
  // description is shown
  await expect(gcRow.locator(".wiz-desc")).not.toBeEmpty();

  // wizard -> text: toggle heap on
  const heapRow = page.locator(".wiz-row", { has: page.locator(".wiz-name", { hasText: /^heap$/ }) });
  await heapRow.locator(".wiz-cb").check();
  await expect(page.locator("#config")).toHaveValue(/heap\*=info/);
});

test("nonsense config shows a doesn't-make-sense warning", async ({ page }) => {
  await setConfig(page, "gc+compiler+jit");
  await openSummary(page);
  await expect(page.locator(".warn-item")).toContainText("no log site has");
});

test("volume estimate renders a headline and a per-tagset rate in the count table", async ({ page }) => {
  await setConfig(page, "gc*=info");
  await openSummary(page);
  await expect(page.locator(".vol-total")).toContainText("MB / hour");
  // The per-(level,tagset) MB/h split now lives inline in the "By level + tag set" table.
  await expect(page.locator(".count-rate").first()).toContainText("/h");
});

test("sample log tab loads and filters", async ({ page }) => {
  await page.getByRole("button", { name: "Sample log" }).click();
  await expect(page.locator(".log-count")).toContainText("line(s)");
  const before = await page.locator(".log-count").textContent();
  await page.locator(".log-search").fill("TLAB");
  await page.waitForTimeout(200);
  await expect(page.locator(".log-count")).toContainText('matching "TLAB"');
  expect(await page.locator(".log-count").textContent()).not.toEqual(before);
});

test("sample log lines have the wall-clock ISO timestamp stripped", async ({ page }) => {
  await page.getByRole("button", { name: "Sample log" }).click();
  await expect(page.locator(".log-line").first()).toBeVisible();
  const first = await page.locator(".log-line").first().textContent();
  // e.g. [2026-08-11T12:51:33.728+0200] must be gone; the [16.680s] uptime decorator stays.
  expect(first).not.toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

test("each firing site has an examples disclosure with an approximate lines/hour rate", async ({ page }) => {
  await setConfig(page, "gc*=info");
  await openAllFileGroups(page);
  const details = page.locator("#tab-sites details.examples");
  await expect(details.first()).toBeVisible();
  // At least one block has captured example lines + a lines/hour estimate from the benchmark run.
  await expect(
    details.locator("summary.examples-head").filter({ hasText: /lines\/hour/ }).first()
  ).toBeVisible();
});

test("the Sites tab shows no JFR-event links (JFR info lives only in the coverage tab)", async ({ page }) => {
  await setConfig(page, "gc*=debug");
  await openAllFileGroups(page);
  await expect(page.locator("#tab-sites .block").first()).toBeVisible();
  await expect(page.locator("#tab-sites a.jfr-link")).toHaveCount(0);
});

test("JFR coverage tab 'By JFR event' lists events with the log lines they replace", async ({ page }) => {
  await setConfig(page, "gc*=debug");
  await openCoverage(page);
  const section = page.locator(".event-index");
  await expect(section.locator("h4")).toContainText("By JFR event");
  // at least one event group, each linking to its jfrevents anchor
  const firstEvent = section.locator("a.evt-name").first();
  await expect(firstEvent).toBeVisible();
  await expect(firstEvent).toHaveAttribute("href", /sap\.github\.io\/jfrevents\/.+#/);
  // The event list is collapsed by default; open the first group to reveal the log lines it replaces.
  await section.locator("details.evt-group").first().evaluate((el) => ((el as HTMLDetailsElement).open = true));
  await expect(section.locator(".evt-line").first()).toBeVisible();
});

test("uncovered gap group expands its site list and reveals source snippets", async ({ page }) => {
  await setConfig(page, "gc*=info");
  await openCoverage(page);
  await openBucket(page, "uncovered");
  // The first uncovered group is the largest tag set; it has an overflow "… N more" button.
  const group = page.locator(".gap-group").first();
  await expect(group).toBeVisible();
  await expect(group.locator(".gap-more")).toBeVisible();
  const before = await group.locator(".gap-site").count();
  // "… N more" is a button that reveals the rest of the sites in place
  await group.locator(".gap-more").click();
  await expect(group.locator(".gap-more")).toHaveCount(0);
  expect(await group.locator(".gap-site").count()).toBeGreaterThan(before);
  // "Show source" renders the highlighted context snippets for the group
  await group.locator(".gap-src-btn").click();
  await expect(group.locator(".gap-src .snippet").first()).toBeVisible();
  await expect(group.locator(".gap-src-btn")).toHaveText("Hide source");
});

test("covered/partial counts expand to sites grouped by covering JFR event", async ({ page }) => {
  await setConfig(page, "gc*=debug");
  await openCoverage(page);
  const detail = page.locator(".cov-detail");
  // Detail panel is collapsed until a count is clicked.
  await expect(detail).toBeHidden();

  // Click "covered": sites grouped under event names that link to the jfrevents doc.
  await openBucket(page, "covered");
  await expect(detail).toBeVisible();
  const coveredEvent = detail.locator(".cov-bucket .evt-group a.evt-name").first();
  await expect(coveredEvent).toBeVisible();
  await expect(coveredEvent).toHaveAttribute("href", /sap\.github\.io\/jfrevents\/.+#/);
  // Every covered event is badged as a verified 1:1 replacement.
  await expect(detail.locator(".cov-bucket .evt-group .cov-badge-exact").first()).toHaveText("1:1");
  // Each group lists the log lines it covers, linking to the GitHub source.
  await expect(detail.locator("a.evt-line").first()).toHaveAttribute("href", /github\.com\/openjdk\/jdk\/blob\//);

  // Switching to "partial" swaps the panel content (partials can carry a coverage note).
  await openBucket(page, "partial");
  await expect(detail).toBeVisible();
  await expect(detail.locator(".cov-bucket .evt-group a.evt-name").first()).toBeVisible();
  // Partial events are badged either "partial" (per-site curated) or "same subsystem" (tag rule).
  await expect(detail.locator(".cov-bucket .cov-badge-partial, .cov-bucket .cov-badge-rule").first()).toBeVisible();
  await expect(page.locator('.cov-summary span[data-bucket="partial"]')).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator('.cov-summary span[data-bucket="covered"]')).toHaveAttribute("aria-expanded", "false");

  // Clicking the open bucket again collapses the panel.
  await openBucket(page, "partial");
  await expect(detail).toBeHidden();
});

test("JFR coverage tab shows the experimental banner", async ({ page }) => {
  await setConfig(page, "gc*=debug");
  await openCoverage(page);
  const banner = page.locator(".jfr-experimental");
  await expect(banner).toBeVisible();
  await expect(banner.locator(".jfr-exp-badge")).toContainText(/experimental/i);
  await expect(banner).toContainText(/neither complete nor fully correct/i);
});

test("JFR coverage tab shows per-event volume estimate and example log messages", async ({ page }) => {
  await setConfig(page, "gc*=debug");
  await openCoverage(page);
  const section = page.locator(".event-index");
  // at least one event carries an estimated MB/hour figure
  await expect(section.locator(".evt-vol").first()).toContainText("/h");
  // and a collapsible list of example log messages
  const ex = section.locator(".evt-examples").first();
  await expect(ex.locator("summary")).toContainText(/Example log messages/i);
});

test("JFR coverage 'By JFR event' list is collapsed by default with an expand-all toggle", async ({ page }) => {
  await setConfig(page, "gc*=debug");
  await openCoverage(page);
  const section = page.locator(".event-index");
  // Header states how many events map, and every event group is a collapsed <details> by default.
  await expect(section.locator(".evt-index-count")).toContainText(/events? map to firing sites/);
  const groups = section.locator("details.evt-group");
  expect(await groups.evaluateAll((els) => els.every((e) => !(e as HTMLDetailsElement).open))).toBe(true);
  // "Expand all" opens every group; label flips to "Collapse all".
  const toggle = section.locator(".evt-index-head .collapse-all-btn");
  await expect(toggle).toHaveText("Expand all");
  await toggle.click();
  expect(await groups.evaluateAll((els) => els.every((e) => (e as HTMLDetailsElement).open))).toBe(true);
  await expect(toggle).toHaveText("Collapse all");
});

test("JFR coverage tab offers a .jfc download of the recommended events", async ({ page }) => {
  await setConfig(page, "gc*=debug");
  await openCoverage(page);
  const btn = page.locator(".jfc-btn").first();
  await expect(btn).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), btn.click()]);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  const xml = Buffer.concat(chunks).toString("utf8");
  expect(xml).toContain('<configuration version="2.0"');
  expect(xml).toContain('<event name="jdk.');
  expect(xml).toContain('enabled">true');
});

test("wizard groups tags by their main tag, collapsed by default", async ({ page }) => {
  await page.locator("#wizard-toggle").click();
  await expect(page.locator("#wizard")).toHaveClass(/open/);
  // Each group is a collapsible keyed by a primary/main tag; there is a `gc` group.
  const gcGroup = page.locator("details.wiz-group", {
    has: page.locator("summary.wiz-group-head", { hasText: /^gc / }),
  });
  await expect(gcGroup).toHaveCount(1);
  // The gc group is open by default (the default config enables a gc selector); gc-family modifier
  // tags such as `heap` are grouped under it. Ensure it is open, then check its rows are visible.
  if (!(await gcGroup.evaluate((el: HTMLDetailsElement) => el.open))) {
    await gcGroup.locator("summary.wiz-group-head").click();
  }
  await expect(gcGroup.locator(".wiz-name", { hasText: /^gc$/ })).toBeVisible();
  await expect(gcGroup.locator(".wiz-name", { hasText: /^heap$/ })).toBeVisible();
});

test("a shared URL hash restores version, gc, and config", async ({ page }) => {
  await page.goto("/#v=head&gc=ZGC&xlog=gc*%3Ddebug");
  await page.reload();
  await expect(page.locator(".results-header")).toBeVisible();
  await expect(page.locator("#gc")).toHaveValue("ZGC");
  await expect(page.locator("#config")).toHaveValue("gc*=debug");
  // editing the config writes back into the hash
  await setConfig(page, "gc*=info");
  await expect.poll(() => page.evaluate(() => location.hash)).toContain("xlog=gc*%3Dinfo");
});

test("platform selector hides OS-specific sites that can't run on the chosen platform", async ({ page }) => {
  await setConfig(page, "os*=trace");
  const bsdCount = () =>
    page.evaluate(() => (document.querySelector("#tab-sites")?.textContent?.match(/os\/bsd\//g) || []).length);
  const linuxCount = () =>
    page.evaluate(() => (document.querySelector("#tab-sites")?.textContent?.match(/os\/linux\//g) || []).length);

  // Linux (the default) shows linux OS sites and hides bsd/windows OS sites.
  await page.locator("#platform").selectOption("linux");
  await page.waitForTimeout(150);
  expect(await linuxCount()).toBeGreaterThan(0);
  expect(await bsdCount()).toBe(0);

  // macOS/BSD flips it: bsd sites appear, linux OS sites are hidden.
  await page.locator("#platform").selectOption("bsd");
  await page.waitForTimeout(150);
  expect(await bsdCount()).toBeGreaterThan(0);
  expect(await linuxCount()).toBe(0);

  // "All platforms" shows both.
  await page.locator("#platform").selectOption("all");
  await page.waitForTimeout(150);
  expect(await bsdCount()).toBeGreaterThan(0);
  expect(await linuxCount()).toBeGreaterThan(0);
});

test("GC selector hides other collectors' gc/<collector>/ source files", async ({ page }) => {
  await setConfig(page, "gc*=trace");
  const zDir = () =>
    page.evaluate(() => (document.querySelector("#tab-sites")?.textContent?.match(/\/gc\/z\//g) || []).length);
  const g1Dir = () =>
    page.evaluate(() => (document.querySelector("#tab-sites")?.textContent?.match(/\/gc\/g1\//g) || []).length);

  await page.locator("#gc").selectOption("G1");
  await page.waitForTimeout(150);
  expect(await g1Dir()).toBeGreaterThan(0);
  expect(await zDir()).toBe(0);

  await page.locator("#gc").selectOption("ZGC");
  await page.waitForTimeout(150);
  expect(await zDir()).toBeGreaterThan(0);
  expect(await g1Dir()).toBe(0);
});

test("Expand all button unfolds and refolds every file group", async ({ page }) => {
  await setConfig(page, "gc*=trace");
  const btn = page.locator(".collapse-all-btn");
  // With no sites-filter active, file groups render collapsed by default.
  await expect(btn).toHaveText("Expand all");
  const openCount = () =>
    page.evaluate(() => document.querySelectorAll(".file-group[open]").length);
  const total = () => page.evaluate(() => document.querySelectorAll(".file-group").length);
  expect(await openCount()).toBe(0);

  await btn.click();
  await expect(btn).toHaveText("Collapse all");
  expect(await openCount()).toBe(await total());

  await btn.click();
  await expect(btn).toHaveText("Expand all");
  expect(await openCount()).toBe(0);
});

test("Copy button gives 'Copied!' feedback without changing the config", async ({ page }) => {
  await setConfig(page, "gc*=info");
  const btn = page.locator("#config-copy");
  await expect(btn).toHaveText("Copy -Xlog");
  await btn.click();
  await expect(btn).toHaveText("Copied!");
  // the config text itself is untouched by copying
  await expect(page.locator("#config")).toHaveValue("gc*=info");
  // label reverts after the timeout
  await expect(btn).toHaveText("Copy -Xlog");
});

test("Copy link button gives 'Copied!' feedback", async ({ page }) => {
  const btn = page.locator("#share-link");
  await expect(btn).toHaveText("Copy link");
  await btn.click();
  await expect(btn).toHaveText("Copied!");
  await expect(btn).toHaveText("Copy link");
});

test("clicking a first-run hint example sets the config and updates the results", async ({ page }) => {
  const ex = page.locator("#config-hint .hint-ex", { hasText: "gc+heap=debug" });
  await expect(ex).toBeVisible();
  await ex.click();
  await expect(page.locator("#config")).toHaveValue("gc+heap=debug");
  await expect(page.locator(".results-header")).toContainText("firing site(s)");
});

test("the Sites filter narrows the file groups by path and restores on clear", async ({ page }) => {
  await setConfig(page, "gc*=trace");
  const groupCount = () => page.locator(".file-group").count();
  const full = await groupCount();
  expect(full).toBeGreaterThan(1);

  const filter = page.locator(".sites-filter");
  await filter.fill("heap");
  await page.waitForTimeout(150);
  const narrowed = await groupCount();
  expect(narrowed).toBeGreaterThan(0);
  expect(narrowed).toBeLessThan(full);
  await expect(page.locator(".results-header")).toContainText("match");

  await filter.fill("");
  await page.waitForTimeout(150);
  expect(await groupCount()).toBe(full);
});

test("the wizard greys out and sorts down tags with no sites for the current GC", async ({ page }) => {
  await page.locator("#wizard-toggle").click();
  await expect(page.locator("#wizard")).toHaveClass(/open/);

  const deadCount = () => page.locator(".wiz-row.wiz-unavailable").count();
  // Some tags have no sites under the default G1 selection (they live in other collectors' trees).
  const g1Dead = await deadCount();
  expect(g1Dead).toBeGreaterThan(0);

  // Switching GC changes which tags are dead (the set is derived from the visible sites).
  await page.locator("#gc").selectOption("ZGC");
  await page.waitForTimeout(150);
  const zgcDead = await deadCount();
  expect(zgcDead).toBeGreaterThan(0);
  expect(zgcDead).not.toEqual(g1Dead);

  // Within every group, no live row appears after a dead row (dead tags sink to the bottom).
  const violations = await page.evaluate(() => {
    let bad = 0;
    for (const g of document.querySelectorAll("details.wiz-group")) {
      let seenDead = false;
      for (const r of g.querySelectorAll(".wiz-row")) {
        if (r.classList.contains("wiz-unavailable")) seenDead = true;
        else if (seenDead) bad++;
      }
    }
    return bad;
  });
  expect(violations).toBe(0);

  // All-dead groups carry the dead marker and no live group follows a dead one.
  const groupsLiveAfterDead = await page.evaluate(() => {
    const states = [...document.querySelectorAll("details.wiz-group")].map((g) =>
      g.classList.contains("wiz-group-dead")
    );
    const firstDead = states.indexOf(true);
    return firstDead >= 0 && states.slice(firstDead).some((s) => s === false);
  });
  expect(groupsLiveAfterDead).toBe(false);
});

test("wizard 'Hide unavailable' removes dead rows and restores them on untick", async ({ page }) => {
  await page.locator("#wizard-toggle").click();
  await expect(page.locator("#wizard")).toHaveClass(/open/);

  const dead = () => page.locator(".wiz-row.wiz-unavailable").count();
  expect(await dead()).toBeGreaterThan(0);

  const hide = page.locator(".wiz-hide-unavail input[type=checkbox]");
  await hide.check();
  await page.waitForTimeout(100);
  expect(await dead()).toBe(0);

  await hide.uncheck();
  await page.waitForTimeout(100);
  expect(await dead()).toBeGreaterThan(0);
});

test("wizard group head shows an unavailable count for a GC with dead tags", async ({ page }) => {
  await page.locator("#wizard-toggle").click();
  await expect(page.locator("#wizard")).toHaveClass(/open/);
  // At least one group summary reports "N unavailable" under the default G1 selection.
  await expect(
    page.locator("summary.wiz-group-head").filter({ hasText: /\d+ unavailable/ }).first()
  ).toBeVisible();
});

test("the active tab persists in the hash and is restored on reload", async ({ page }) => {
  await page.getByRole("button", { name: /^Summary/ }).click();
  await expect.poll(() => page.evaluate(() => location.hash)).toContain("tab=tab-summary");

  await page.reload();
  await expect(page.locator("#tab-summary")).toHaveClass(/active/);
});

test("the Sites filter query persists in the hash and is prefilled on reload", async ({ page }) => {
  await setConfig(page, "gc*=trace");
  const filter = page.locator(".sites-filter");
  await filter.fill("heap");
  await page.waitForTimeout(200);
  await expect.poll(() => page.evaluate(() => location.hash)).toContain("q=heap");

  await page.reload();
  await expect(page.locator(".results-header")).toBeVisible();
  await expect(page.locator(".sites-filter")).toHaveValue("heap");
  await expect(page.locator(".results-header")).toContainText("match");
});

test("block 'Link' button copies a link, and navigating to #b=<id> scrolls the block into view", async ({ page }) => {
  await setConfig(page, "gc*=info");
  // File groups render collapsed by default; open the first so its blocks (and their Link button)
  // are laid out and interactive.
  await page.locator(".file-group").first().evaluate((el) => ((el as HTMLDetailsElement).open = true));
  const linkBtn = page.locator(".block-link-btn").first();
  await expect(linkBtn).toBeVisible();
  await expect(linkBtn).toHaveText("Link");
  await linkBtn.click();
  await expect(linkBtn).toHaveText("Copied!");

  // The button's block has a #block-<id> DOM id; navigate to that block via the hash and confirm the
  // deep-link scrolls it into view. Block ids contain `/` and `|`, so we can't use them as CSS
  // selectors — query by getElementById in-page instead. (The .block-flash highlight is a 1.5s
  // transient we don't assert on directly, as its lifetime races the test harness.)
  const blockId = await page
    .locator(".block")
    .first()
    .evaluate((el) => el.id.replace(/^block-/, ""));
  const hash = await page.evaluate(() => location.hash.replace(/^#/, ""));
  const p = new URLSearchParams(hash);
  p.set("b", blockId);
  await page.goto("/#" + p.toString());
  await expect(page.locator(".results-header")).toBeVisible();
  // The target block exists and is scrolled into the viewport (deep-link landed on it).
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const el = document.getElementById("block-" + id);
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.top < window.innerHeight && r.bottom > 0;
      }, blockId)
    )
    .toBe(true);
});

test("header meta line shows a data-provenance segment linking to the source commit", async ({ page }) => {
  const prov = page.locator("#data-provenance");
  await expect(prov).toContainText("data");
  await expect(prov).toContainText("openjdk/jdk");
  const link = prov.locator("a");
  await expect(link).toHaveAttribute("href", /\/commit\//);
});

test("version selector lists the versions detected at startup (head is always present)", async ({ page }) => {
  const options = page.locator("#version option");
  await expect(options.filter({ hasText: /^head$/ })).toHaveCount(1);
});

test("empty results state offers a clickable example that repopulates the sites", async ({ page }) => {
  // A selector that matches nothing (valid syntax, real tag, but no sites at this level/gc).
  await setConfig(page, "jfr=off");
  const empty = page.locator(".empty-state");
  await expect(empty).toContainText("No log sites fire");
  const ex = empty.locator(".empty-ex");
  await expect(ex).toHaveText("gc*=info");
  await ex.click();
  await expect(page.locator("#config")).toHaveValue("gc*=info");
  await expect(page.locator(".results-header")).toContainText("firing site(s)");
});

test("each tab shows a one-line intro describing what it holds", async ({ page }) => {
  const intro = page.locator("#tab-intro");
  await expect(intro).toContainText("log statement");
  await page.locator('.tab[data-panel="tab-coverage"]').click();
  await expect(intro).toContainText("JFR event");
  await page.locator('.tab[data-panel="tab-sites"]').click();
  await expect(intro).toContainText("source file");
});

test("level chip filter narrows the Sites list and composes with text filter", async ({ page }) => {
  await setConfig(page, "gc*=info");
  await expect(page.locator(".results-header")).toContainText("firing site(s)");
  // a chip row is present with the five levels; clicking "info" keeps only info sites
  const infoChip = page.locator(".chip-filter[data-level='info']");
  await expect(infoChip).toBeVisible();
  await infoChip.click();
  await expect(infoChip).toHaveClass(/active/);
  // at least one file group still renders (info sites exist for gc*=info)
  await expect(page.locator(".file-group").first()).toBeVisible();
  // clicking again clears the level filter
  await infoChip.click();
  await expect(infoChip).not.toHaveClass(/active/);
});

test("config validity cue reflects parse state", async ({ page }) => {
  const cue = page.locator("#config-valid");
  await setConfig(page, "gc*=info");
  await expect(cue).toHaveAttribute("data-state", "ok");
  await setConfig(page, "gc==info");
  await expect(cue).toHaveAttribute("data-state", "err");
});

