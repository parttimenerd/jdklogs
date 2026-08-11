// SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
// SPDX-License-Identifier: GPL-2.0-only
package me.bechberger.jdklogs

/**
 * Matches captured HotSpot log lines back to the source `log_*` sites that emitted them, and
 * measures per-(level,tagset) output volume.
 *
 * A captured line (decorators `time,uptime,tags`) looks like:
 *   `[2026-08-11T12:00:00.123+0000][0.456s][info][gc] Pause Young ... 3.4ms`
 * We split off the decorator brackets to get `(level, tagset, message)`. Each site's format string
 * is compiled once into a regex (printf conversions → wildcards, literal text anchored). For a line
 * we consider only sites sharing the exact same level + tagset, and pick the site whose format
 * matches with the longest literal prefix — the most specific match.
 */
object SampleMatcher {

    /** A compiled site: its identity plus a regex derived from its format string. */
    private data class Compiled(val site: SiteJson, val regex: Regex, val literalLen: Int)

    /** printf conversion specifier, incl. length modifiers (z, l, ll, h, j, t) and width/precision. */
    private val CONV = Regex("""%[-+ #0]*[0-9*]*(?:\.[0-9*]+)?(?:hh|ll|[hljztqL])?[diouxXeEfFgGaAcspn%]""")
    /** Leading decorator brackets `[..][..][level][tagset] `; HotSpot right-pads level and tagset
     *  columns with spaces, so trim inside each bracket. We only need the last two brackets. */
    private val LINE = Regex("""^(?:\[[^\]]*\])*\[\s*([a-z]+)\s*\]\[\s*([a-z0-9,+]+)\s*\]\s?(.*)$""")

    /**
     * @param sites all sites for the version (mutated: fills each site's `samples[gc]`)
     * @param gc the collector label for this capture (G1/ZGC/Parallel)
     * @param logLines the captured log for this gc, streamed line-by-line (an `all=trace` run can be
     *   many gigabytes, so we never hold the whole file in memory)
     * @param maxPerSite cap on samples stored per site
     * @param volume accumulator to fill: perTagset["<level>,<tagset>"][gc] += {bytes,lines}
     */
    fun match(
        sites: List<SiteJson>,
        gc: String,
        logLines: Sequence<String>,
        maxPerSite: Int,
        volume: VolumeStats
    ) {
        // Index compiled sites by "level|sortedTagset" for O(1) candidate lookup.
        val byKey = HashMap<String, MutableList<Compiled>>()
        for (s in sites) {
            val fmt = s.formatString ?: continue
            if (fmt.isEmpty()) continue
            val key = siteKey(s.level, s.tags)
            byKey.getOrPut(key) { mutableListOf() }.add(Compiled(s, compileFormat(fmt), literalLength(fmt)))
        }

        for (rawLine in logLines) {
            if (rawLine.isEmpty()) continue
            val m = LINE.find(rawLine) ?: continue
            val level = m.groupValues[1]
            val tagset = m.groupValues[2]
            val message = m.groupValues[3]
            val tags = tagset.split(",", "+").filter { it.isNotEmpty() }
            val key = siteKey(level, tags)

            // volume accounting (count the raw line incl. newline)
            val vkey = "$level,${tags.sorted().joinToString("+")}"
            val tv = volume.perTagset.getOrPut(vkey) { mutableMapOf() }.getOrPut(gc) { TagsetVolume() }
            tv.bytes += rawLine.length + 1
            tv.lines += 1

            val candidates = byKey[key] ?: continue
            // longest-literal match wins (most specific format)
            var best: Compiled? = null
            for (c in candidates) {
                if (c.regex.matches(message)) {
                    if (best == null || c.literalLen > best.literalLen) best = c
                }
            }
            best?.let { c ->
                val bucket = c.site.samples.getOrPut(gc) { mutableListOf() }
                if (bucket.size < maxPerSite && message !in bucket) bucket.add(message)
            }
        }
    }

    private fun siteKey(level: String, tags: List<String>): String =
        level + "|" + tags.sorted().joinToString(",")

    /** Compile a printf format string into a whole-line regex. */
    private fun compileFormat(fmt: String): Regex {
        val sb = StringBuilder("^")
        var i = 0
        while (i < fmt.length) {
            val conv = CONV.matchAt(fmt, i)
            if (conv != null) {
                sb.append(if (conv.value == "%%") "%" else ".*?")
                i = conv.range.last + 1
            } else {
                sb.append(Regex.escape(fmt[i].toString()))
                i++
            }
        }
        sb.append("$")
        // Newlines inside a format become multiple log lines; match leniently with DOT_MATCHES_ALL.
        return Regex(sb.toString(), setOf(RegexOption.DOT_MATCHES_ALL))
    }

    /** Number of literal (non-conversion) characters — a proxy for match specificity. */
    private fun literalLength(fmt: String): Int =
        fmt.replace(CONV, "").length
}
