// SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// Unit test for the .jfc builder. Asserts buildJfc emits a version-2.0 configuration with one
// enabled <event> per (deduped, sorted) event, and that event names are XML-escaped.
//
// Run with:  node --import tsx site/test/jfc.mts

import { buildJfc } from "../src/jfc.ts";

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (!cond) { console.error("FAIL: " + msg); failures++; }
  else console.log("ok  " + msg);
}

const one = buildJfc(["jdk.GCPhasePause"]);
check(one.includes('<configuration version="2.0"'), "emits configuration version 2.0");
check(one.includes('<event name="jdk.GCPhasePause">'), "emits the event element");
check(one.includes('<setting name="enabled">true</setting>'), "enables the event");
check(one.trim().endsWith("</configuration>"), "closes the configuration");

// dedupe + sort
const many = buildJfc(["jdk.ZPageAllocation", "jdk.GCPhasePause", "jdk.GCPhasePause"]);
const first = many.indexOf('name="jdk.GCPhasePause"');
const second = many.indexOf('name="jdk.ZPageAllocation"');
check(first >= 0 && second >= 0 && first < second, "events are sorted (GCPhasePause before ZPageAllocation)");
check((many.match(/name="jdk\.GCPhasePause"/g) ?? []).length === 1, "duplicate event appears once");

// XML escaping in label/name
const esc = buildJfc(['jdk.Weird&<Name>'], { label: 'a & b "c"' });
check(esc.includes("jdk.Weird&amp;&lt;Name&gt;"), "event name is XML-escaped");
check(esc.includes('label="a &amp; b &quot;c&quot;"'), "label is XML-escaped");

// empty
const empty = buildJfc([]);
check(empty.includes("<configuration") && empty.includes("</configuration>") && !empty.includes("<event"), "empty event list yields a valid empty configuration");

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall jfc checks passed");
