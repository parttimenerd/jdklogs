// SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
// SPDX-License-Identifier: GPL-2.0-only
package me.bechberger.jdklogs

/** Parses the canonical log tag names out of `src/hotspot/share/logging/logTag.hpp`. */
object TagListParser {
    private val TAG = Regex("""\bLOG_TAG\((\w+)\)""")

    fun parse(logTagHppText: String): List<String> =
        TAG.findAll(logTagHppText).map { it.groupValues[1] }
            .filter { it != "_NO_TAG" }
            .distinct().sorted().toList()

    /** The five HotSpot log levels, low → high. */
    val levels = listOf("trace", "debug", "info", "warning", "error")
}
