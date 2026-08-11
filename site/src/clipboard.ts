// SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
// SPDX-License-Identifier: GPL-2.0-only

/**
 * Copy `text` to the clipboard and give the triggering button transient "Copied!" feedback (the
 * label reverts after ~1.2s). Silently no-ops if the Clipboard API is unavailable (e.g. insecure
 * context) — the button just doesn't flip. Shared by the config, share-link, and per-snippet copy.
 */
export function copyToClipboard(text: string, btn: HTMLElement): void {
  const done = () => {
    // Guard against re-entry: capture the resting label only once, so a rapid double-click can't
    // freeze the button on "Copied!".
    if (!btn.classList.contains("copied")) btn.dataset.label = btn.textContent ?? "";
    btn.textContent = "Copied!";
    btn.classList.add("copied");
    window.setTimeout(() => {
      btn.textContent = btn.dataset.label ?? "";
      btn.classList.remove("copied");
    }, 1200);
  };
  const clip = navigator.clipboard;
  if (clip?.writeText) {
    // Fire the write, but show the "Copied!" feedback optimistically: some contexts (headless
    // browsers, denied permission) reject the promise even though the copy visibly succeeds for the
    // user, and swallowing that into a silent no-op left the button frozen.
    clip.writeText(text).catch(() => {});
    done();
  }
}
