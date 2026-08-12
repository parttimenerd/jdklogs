// SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
// SPDX-License-Identifier: GPL-2.0-only
import assert from "node:assert/strict";
import { buildPresence, versionBadge } from "../src/versions.ts";

// mappingKey(file, func, logLine) is the identity. Two versions, one shared site + one 25-only site.
const head = {
  version: "head",
  sites: [
    { file: "a.cpp", funcSignature: "f()", formatString: "shared %d" },
    { file: "b.cpp", funcSignature: "g()", formatString: "old %d" },
  ],
} as any;
const v25 = {
  version: "25",
  sites: [
    { file: "a.cpp", funcSignature: "f()", formatString: "shared %d" },
    { file: "c.cpp", funcSignature: "h()", formatString: "new %d" },
  ],
} as any;

const present = ["head", "25"]; // head is newest, 25 is older LTS
const p = buildPresence([head, v25], present);

const sharedKey = "a.cpp | f() | shared %d";
const oldKey = "b.cpp | g() | old %d";
const newKey = "c.cpp | h() | new %d";

// shared → in all present versions → no badge (null)
assert.equal(versionBadge(p.get(sharedKey)!, present), null);
// old → in head only (absent from 25); head is newest, so it's "new in head" (added to master,
// not yet on the 25 line).
assert.equal(versionBadge(p.get(oldKey)!, present), "new in head");
// new → in 25 only (absent from head=newest) → "removed" (gone from master)
assert.equal(versionBadge(p.get(newKey)!, present), "removed");

console.log("versions.mts OK");
