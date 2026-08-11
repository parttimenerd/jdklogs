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

test("volume estimate renders with a per-tag split", async ({ page }) => {
  await setConfig(page, "gc*=info");
  await openSummary(page);
  await expect(page.locator(".vol-total")).toContainText("MB / hour");
  await expect(page.locator(".vol-row").first()).toContainText("/h");
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
  const details = page.locator("#tab-sites details.examples");
  await expect(details.first()).toBeVisible();
  // At least one block has captured example lines + a lines/hour estimate from the benchmark run.
  await expect(
    details.locator("summary.examples-head").filter({ hasText: /lines\/hour/ }).first()
  ).toBeVisible();
});

test("the Sites tab shows no JFR-event links (JFR info lives only in the coverage tab)", async ({ page }) => {
  await setConfig(page, "gc*=debug");
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
  // and it shows at least one verbatim log line it replaces
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
  // Each group lists the log lines it covers, linking to the GitHub source.
  await expect(detail.locator("a.evt-line").first()).toHaveAttribute("href", /github\.com\/openjdk\/jdk\/blob\//);

  // Switching to "partial" swaps the panel content (partials can carry a coverage note).
  await openBucket(page, "partial");
  await expect(detail).toBeVisible();
  await expect(detail.locator(".cov-bucket .evt-group a.evt-name").first()).toBeVisible();
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

test("JFR coverage tab offers a .jfc download whose contents are a valid configuration", async ({ page }) => {
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

test("Collapse all button folds and unfolds every file group", async ({ page }) => {
  await setConfig(page, "gc*=trace");
  const btn = page.locator(".collapse-all-btn");
  await expect(btn).toHaveText("Collapse all");
  const openCount = () =>
    page.evaluate(() => document.querySelectorAll(".file-group[open]").length);
  const total = () => page.evaluate(() => document.querySelectorAll(".file-group").length);
  expect(await openCount()).toBe(await total());

  await btn.click();
  await expect(btn).toHaveText("Expand all");
  expect(await openCount()).toBe(0);

  await btn.click();
  await expect(btn).toHaveText("Collapse all");
  expect(await openCount()).toBe(await total());
});

test("Copy button gives 'Copied!' feedback without changing the config", async ({ page }) => {
  await setConfig(page, "gc*=info");
  const btn = page.locator("#config-copy");
  await expect(btn).toHaveText("Copy");
  await btn.click();
  await expect(btn).toHaveText("Copied!");
  // the config text itself is untouched by copying
  await expect(page.locator("#config")).toHaveValue("gc*=info");
  // label reverts after the timeout
  await expect(btn).toHaveText("Copy");
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
