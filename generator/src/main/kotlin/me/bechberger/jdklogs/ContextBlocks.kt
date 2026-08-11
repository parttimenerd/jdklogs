// SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
// SPDX-License-Identifier: GPL-2.0-only
package me.bechberger.jdklogs

/**
 * Groups the log sites of one file into renderable context blocks.
 *
 * Adapted from SAP/jfrevents `SourceCodeContextAdder`: for each site take a window of context lines
 * around it, merge windows that overlap or sit adjacent into one block, trim boilerplate lines
 * (`#include`, lone braces, `#endif`, blanks) from the block edges, and always fold in the enclosing
 * function-header line so the reader sees where the log lives.
 */
object ContextBlocks {

    private val EDGE_NOISE = Regex("""(|import .*;|#include .*|};?|#endif|#if.*|[A-Za-z_]+_END|return .*)""")

    /**
     * @param contextLines lines of context to grab above and below each site (each side ≈ half)
     */
    fun build(file: String, fileText: String, sites: List<LogSite>, contextLines: Int = 12): List<ContextBlock> {
        if (sites.isEmpty()) return emptyList()
        val lines = fileText.split("\n")
        val sorted = sites.sortedBy { it.startLine }

        // For each site: candidate [start,end] window (0-based, inclusive), plus its firing lines.
        data class Win(var start: Int, var end: Int, val sites: MutableList<LogSite>)

        val wins = mutableListOf<Win>()
        for (s in sorted) {
            val siteStart0 = s.startLine - 1
            val siteEnd0 = s.endLine - 1
            var start = maxOf(0, siteStart0 - contextLines / 2)
            var end = minOf(lines.size - 1, siteEnd0 + contextLines / 2)
            // Pull in the enclosing function header if it lies just above the window.
            val funcLine = s.funcSignature?.let { findFuncLine(lines, siteStart0, it) }
            if (funcLine != null && funcLine < start && start - funcLine <= contextLines) start = funcLine

            val prev = wins.lastOrNull()
            if (prev != null && start <= prev.end + 2) {   // overlap or near-adjacent → merge
                prev.end = maxOf(prev.end, end)
                prev.sites.add(s)
            } else {
                wins.add(Win(start, end, mutableListOf(s)))
            }
        }

        return wins.map { w ->
            var start = w.start
            var end = w.end
            // trim noisy edges but never past a firing line
            val firstFire = w.sites.minOf { it.startLine - 1 }
            val lastFire = w.sites.maxOf { it.endLine - 1 }
            while (start < firstFire && EDGE_NOISE.matches(lines[start].trim())) start++
            while (end > lastFire && lines[end].trim().isEmpty()) end--

            val snippet = lines.subList(start, end + 1).joinToString("\n")
            val firing = w.sites.map { (it.startLine - 1) - start }.filter { it in 0..(end - start) }.sorted()
            ContextBlock(file, start + 1, end + 1, snippet, firing, w.sites.toList())
        }
    }

    private fun findFuncLine(lines: List<String>, from: Int, signature: String): Int? {
        var i = from
        while (i >= 0) { if (lines[i].trim().removeSuffix("{").trim() == signature) return i; i-- }
        return null
    }
}
