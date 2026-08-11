// SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
// SPDX-License-Identifier: GPL-2.0-only
package me.bechberger.jdklogs

/**
 * Scans a single OpenJDK C/C++ source file for `log_<level>(tags)("fmt", ...)` call sites.
 *
 * The tag list always sits on the macro line (verified across the whole hotspot tree), so tags are
 * parsed with a regex. The format string may span several physical lines via adjacent string-literal
 * concatenation, so after locating the macro we paren-balance forward from the argument-list `(` to
 * find the end of the call and collect every string literal in the first argument.
 */
object LogSiteScanner {

    private val MACRO = Regex("""\blog_(trace|debug|info|warning|error)\s*\(([^)]*)\)\s*\(""")

    /** Matches a C function/method definition header line: `... name(...) {` at brace depth 0. */
    private val FUNC_HEADER = Regex("""^[A-Za-z_].*\b[A-Za-z_~][A-Za-z0-9_:]*\s*\([^;]*\)\s*(const)?\s*\{?\s*$""")

    /** Preprocessor guards that fence off code compiled out of a release (product) JVM. */
    private val GUARD_OPEN_NONPROD = Regex("""^\s*#\s*ifdef\s+ASSERT\b|^\s*#\s*ifndef\s+PRODUCT\b|^\s*#\s*if\s+!\s*defined\s*\(\s*PRODUCT\s*\)""")
    private val GUARD_OPEN_ANY = Regex("""^\s*#\s*if""")
    private val GUARD_CLOSE = Regex("""^\s*#\s*endif\b""")

    fun scan(relPath: String, text: String): List<LogSite> {
        val lines = text.split("\n")
        // Precompute the 0-based char offset at the start of each line for line lookups.
        val lineStart = IntArray(lines.size)
        var acc = 0
        for (i in lines.indices) { lineStart[i] = acc; acc += lines[i].length + 1 }

        // Non-production regions: a log site inside `#ifdef ASSERT` / `#ifndef PRODUCT` (or a
        // `DEBUG_ONLY(...)` wrapper) never fires in a release JVM, so we skip it entirely — otherwise
        // the explorer would advertise log lines a user could never actually see. Track the guard
        // stack per line: a line is non-production if any enclosing #if guard opened a non-prod block.
        val nonProdLine = BooleanArray(lines.size)
        run {
            val stack = ArrayDeque<Boolean>() // true = this #if opened a non-production region
            var depth = 0                     // count of currently-open non-production regions
            for (i in lines.indices) {
                val ln = lines[i]
                if (GUARD_CLOSE.containsMatchIn(ln)) {
                    if (stack.isNotEmpty() && stack.removeLast()) depth--
                } else if (GUARD_OPEN_ANY.containsMatchIn(ln)) {
                    val np = GUARD_OPEN_NONPROD.containsMatchIn(ln)
                    stack.addLast(np)
                    if (np) depth++
                }
                nonProdLine[i] = depth > 0
            }
        }

        fun lineOf(offset: Int): Int {
            // binary search: largest i with lineStart[i] <= offset
            var lo = 0; var hi = lines.size - 1; var ans = 0
            while (lo <= hi) { val mid = (lo + hi) ushr 1; if (lineStart[mid] <= offset) { ans = mid; lo = mid + 1 } else hi = mid - 1 }
            return ans
        }

        val sites = mutableListOf<LogSite>()
        for (m in MACRO.findAll(text)) {
            val level = m.groupValues[1]
            val tags = m.groupValues[2].split(",").map { it.trim() }.filter { it.isNotEmpty() }
            if (tags.isEmpty()) continue
            val macroLine = lineOf(m.range.first)
            // Skip sites compiled out of a release JVM: inside an ASSERT/non-PRODUCT guard, or wrapped
            // in a DEBUG_ONLY(...) macro on the same line. They can't fire in production, so listing
            // them would mislead users choosing an -Xlog config.
            if (nonProdLine[macroLine]) continue
            if (lines[macroLine].contains("DEBUG_ONLY")) continue
            val argOpen = m.range.last // index of the '(' that opens the argument list
            val end = matchParen(text, argOpen) ?: continue
            val fmt = extractFormatString(text, argOpen + 1, end)
            val startLine = macroLine
            val endLine = lineOf(end)
            val func = enclosingFunction(lines, startLine)
            sites.add(
                LogSite(
                    level = level,
                    tags = tags,
                    file = relPath,
                    startLine = startLine + 1,
                    endLine = endLine + 1,
                    formatString = fmt,
                    funcSignature = func
                )
            )
        }
        return sites
    }

    /** Given the index of an opening '(', return the index of the matching ')', respecting
     *  string/char literals and comments. Null if unbalanced. */
    private fun matchParen(s: String, open: Int): Int? {
        var depth = 0
        var i = open
        while (i < s.length) {
            when (val c = s[i]) {
                '(' -> depth++
                ')' -> { depth--; if (depth == 0) return i }
                '"' -> i = skipString(s, i, '"')
                '\'' -> i = skipString(s, i, '\'')
                '/' -> if (i + 1 < s.length) {
                    if (s[i + 1] == '/') { while (i < s.length && s[i] != '\n') i++; continue }
                    if (s[i + 1] == '*') { i += 2; while (i + 1 < s.length && !(s[i] == '*' && s[i + 1] == '/')) i++; i++ }
                }
                else -> {}
            }
            i++
        }
        return null
    }

    /** Returns the index of the closing quote of a string/char literal starting at [start]. */
    private fun skipString(s: String, start: Int, quote: Char): Int {
        var i = start + 1
        while (i < s.length) {
            when (s[i]) {
                '\\' -> i++            // skip escaped char
                quote -> return i
            }
            i++
        }
        return s.length - 1
    }

    /** Collects and decodes all double-quoted string literals appearing before the first top-level
     *  comma in the argument list — i.e. the format string, which C concatenates from adjacents. */
    private fun extractFormatString(s: String, from: Int, to: Int): String {
        val sb = StringBuilder()
        var i = from
        var depth = 0
        while (i < to) {
            val c = s[i]
            when (c) {
                '(', '[', '{' -> depth++
                ')', ']', '}' -> depth--
                ',' -> if (depth == 0) break   // end of first argument
                '"' -> {
                    val close = skipString(s, i, '"')
                    sb.append(decodeLiteral(s.substring(i + 1, close)))
                    i = close
                }
                '\'' -> i = skipString(s, i, '\'')
                '/' -> if (i + 1 < s.length) {
                    if (s[i + 1] == '/') { while (i < to && s[i] != '\n') i++; continue }
                    if (s[i + 1] == '*') { i += 2; while (i + 1 < to && !(s[i] == '*' && s[i + 1] == '/')) i++; i++ }
                }
            }
            i++
        }
        return sb.toString()
    }

    private fun decodeLiteral(raw: String): String {
        val sb = StringBuilder()
        var i = 0
        while (i < raw.length) {
            val c = raw[i]
            if (c == '\\' && i + 1 < raw.length) {
                when (raw[i + 1]) {
                    'n' -> sb.append('\n'); 't' -> sb.append('\t'); 'r' -> sb.append('\r')
                    '"' -> sb.append('"'); '\\' -> sb.append('\\'); '\'' -> sb.append('\'')
                    else -> sb.append(raw[i + 1])
                }
                i += 2
            } else { sb.append(c); i++ }
        }
        return sb.toString()
    }

    /** Scans upward from [siteLine] for the nearest plausible enclosing function header. */
    private fun enclosingFunction(lines: List<String>, siteLine: Int): String? {
        var i = siteLine
        while (i >= 0) {
            val t = lines[i].trim()
            if (t.isNotEmpty() && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("#")
                && FUNC_HEADER.matches(lines[i])
                && !t.startsWith("if") && !t.startsWith("for") && !t.startsWith("while")
                && !t.startsWith("switch") && !t.startsWith("return") && !t.startsWith("}")
            ) {
                return lines[i].trim().removeSuffix("{").trim()
            }
            i--
        }
        return null
    }
}
