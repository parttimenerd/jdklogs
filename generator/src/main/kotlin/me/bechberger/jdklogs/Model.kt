// SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
// SPDX-License-Identifier: GPL-2.0-only
package me.bechberger.jdklogs

/** A single `log_<level>(tags)("fmt", ...)` call site found in the OpenJDK source. */
data class LogSite(
    val level: String,            // trace | debug | info | warning | error
    val tags: List<String>,       // e.g. ["gc", "ergo", "heap"]
    val file: String,             // repo-relative path, e.g. src/hotspot/share/gc/g1/g1Policy.cpp
    val startLine: Int,           // 1-based line of the log_ macro
    val endLine: Int,             // 1-based line where the call's closing ) sits
    val formatString: String,     // concatenated adjacent string literals (decoded)
    val funcSignature: String?    // enclosing function signature line, if found
) {
    /** Canonical "level,tag+tag" key used for grouping and version-presence diffing. */
    val tagsetKey: String get() = tags.joinToString("+")
    val key: String get() = "$file|$funcSignature|$level|$tagsetKey|$formatString"
}

/** A merged, renderable block of source lines covering one or more nearby log sites in a file. */
data class ContextBlock(
    val file: String,
    val startLine: Int,           // 1-based, inclusive
    val endLine: Int,             // 1-based, inclusive
    val snippet: String,          // the source text for [startLine, endLine]
    val firingLineOffsets: List<Int>, // 0-based offsets within snippet that are log_ macro lines
    val sites: List<LogSite>      // the sites contained in this block
)
