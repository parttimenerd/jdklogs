# jdklogs

**What log lines does a HotSpot `-Xlog` configuration actually print — and where in the OpenJDK
source do they come from?**

Type a log configuration (e.g. `gc*=info,heap*=debug`), pick a JDK version, and jdklogs shows you
every `log_*` statement in the OpenJDK source that would fire under that config — with surrounding
source context, the enclosing function, syntax highlighting, a direct link to the exact line on
GitHub, and real sample output captured from a benchmark run.

Live at **https://parttimenerd.github.io/jdklogs/**.

![jdklogs showing the firing log sites for `gc=info` on G1, with syntax-highlighted OpenJDK source context and GitHub permalinks](docs/images/screenshot.png)

## Features

- **Config search bar** with autocomplete over all log tags and levels, and precise error messages
  (parsed with an [Ohm.js](https://ohmjs.org/) grammar).
- **Selector helper wizard** — toggle tags on/off and set levels without knowing the syntax; the
  text config and the wizard stay in sync. Every tag has a short description.
- **Version selector** — master (head), 21, 25, and each feature release above the latest LTS.
- **Firing sites** — grouped by file, nearby log lines merged into one context block, enclosing
  function shown, active log lines highlighted, GitHub permalink (with commit hash) per block.
- **Real samples** — captured from a small [renaissance](https://renaissance.dev/) benchmark under
  G1/ZGC/Parallel with restricted heap. Hover a source line for sample emissions; view the full
  sample log (searchable) in its own tab.
- **Summary** — counts per (level, tagset) and per file, a "this config won't fire anything" /
  "this selector is shadowed" warning, and a best-effort **"≈ X MB/hour" volume estimate** split by
  tag.

## How it works

A build-time generator (`generator/`, Kotlin) scans the OpenJDK source for `log_*(tags)("fmt", …)`
call sites, extracts context blocks (approach adapted from
[SAP/jfrevents](https://github.com/SAP/jfrevents)'s source-context attacher), captures real sample
output from a benchmark, and emits one JSON file per JDK version into `data/`. The static frontend
(`site/`) loads that JSON and filters it live in the browser. A monthly GitHub Actions workflow
regenerates the data and redeploys to GitHub Pages.

## License and attribution

jdklogs is licensed under the **GNU General Public License, version 2 only** (`LICENSE`).

**This project contains excerpts of OpenJDK source code** — in the generated `data/` files and in
the code snippets rendered on the site. That source code is Copyright of Oracle and/or its
affiliates and other OpenJDK contributors, and is subject to the OpenJDK license (GPLv2). It is
reproduced here under the same license. See https://github.com/openjdk/jdk for the upstream source.
