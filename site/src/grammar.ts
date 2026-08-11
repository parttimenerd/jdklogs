// SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// Ohm grammar for a HotSpot -Xlog *selector list* (the "what=level" part, without output/decorators).
// Examples:  gc*=info   gc+heap=debug   all=trace   gc,heap   gc*=info,ergo*=trace
//
// Grammar shape:
//   Config   = a comma-separated list of one or more selectors
//   Selector = a tagset, optionally "=" level
//   TagSet   = "all"  |  tag ("+" tag)* "*"?     (the trailing "*" means "wildcard / superset")
//
// Ohm gives position-accurate failure messages ("expected …") which we surface inline.
export const grammarSource = String.raw`
JdkLog {
  Config    = Selector ("," Selector)*
  Selector  = TagSet ("=" level)?
  TagSet    = all                       -- allTag
            | tag ("+" tag)* "*"?        -- tags
  all       = "all" ~identChar
  level     = ("trace" | "debug" | "info" | "warning" | "error" | "off") ~identChar
  tag       = identChar+
  identChar = letter | digit | "_"
}
`;
