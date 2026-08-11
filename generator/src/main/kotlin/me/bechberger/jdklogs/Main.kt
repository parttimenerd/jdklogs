// SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
// SPDX-License-Identifier: GPL-2.0-only
package me.bechberger.jdklogs

import com.fasterxml.jackson.databind.SerializationFeature
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.time.Instant
import kotlin.io.path.extension
import kotlin.io.path.nameWithoutExtension
import kotlin.streams.toList

/**
 * Orchestrates a single-version scan:
 *   generate <jdk-src-dir> <version> <repo> <commitSha> <out-data-dir>
 *   tags     <jdk-src-dir> <out-data-dir>       (writes tags.json)
 *
 * Walks src/hotspot, scans every C/C++ file for log_* sites, groups them into context blocks,
 * bakes a GitHub permalink per block, and writes data/<version>.json.
 */
private const val CONTEXT_LINES = 12

/** Max lines copied into the per-GC sample-log sibling the frontend's "Sample log" tab fetches. An
 *  `all=trace` capture can be gigabytes; the tab only needs a representative head. */
private const val SAMPLE_LOG_LINES = 50_000

private val SRC_EXT = setOf("cpp", "hpp", "c", "h")

fun main(args: Array<String>) {
    if (args.isEmpty()) { printUsage(); return }
    when (args[0]) {
        "generate" -> generate(args)
        "tags" -> tags(args)
        "samples" -> samples(args)
        else -> printUsage()
    }
}

private fun printUsage() {
    System.err.println(
        """
        Usage:
          generate <jdk-src-dir> <version> <repo> <commitSha> <out-data-dir>
          tags     <jdk-src-dir> <out-data-dir>
          samples  <version.json> <capture-dir> [maxPerSite=5]
        """.trimIndent()
    )
}

private fun generate(args: Array<String>) {
    require(args.size == 6) { "generate needs: <jdk-src-dir> <version> <repo> <commitSha> <out-data-dir>" }
    val srcDir = Paths.get(args[1])
    val version = args[2]
    val repo = args[3]
    val sha = args[4]
    val outDir = Paths.get(args[5])
    Files.createDirectories(outDir)

    val hotspot = srcDir.resolve("src/hotspot")
    require(Files.isDirectory(hotspot)) { "no src/hotspot under $srcDir" }

    val files = Files.walk(hotspot)
        .filter { it.extension in SRC_EXT && Files.isRegularFile(it) }
        .toList()

    val allSites = mutableListOf<SiteJson>()
    val blocks = LinkedHashMap<String, Block>()
    var siteCounter = 0
    files.parallelStream().flatMap { file ->
        val rel = srcDir.relativize(file).toString().replace('\\', '/')
        val text = try { Files.readString(file) } catch (e: Exception) { return@flatMap emptyList<ContextBlock>().stream() }
        if ("log_" !in text) return@flatMap emptyList<ContextBlock>().stream()
        val sites = LogSiteScanner.scan(rel, text)
        if (sites.isEmpty()) return@flatMap emptyList<ContextBlock>().stream()
        ContextBlocks.build(rel, text, sites, CONTEXT_LINES).stream()
    }.toList().sortedWith(compareBy({ it.file }, { it.startLine })).forEach { b ->
        // Each block is emitted once into the shared pool; its sites reference it by id. The GitHub
        // permalink is derived client-side from (repo, commitSha, file, startLine, endLine).
        val blockId = "${b.file}|${b.startLine}-${b.endLine}"
        blocks.getOrPut(blockId) {
            Block(b.file, b.startLine, b.endLine, b.snippet, b.firingLineOffsets)
        }
        for (s in b.sites) {
            allSites.add(
                SiteJson(
                    id = "s${siteCounter++}",
                    level = s.level,
                    tags = s.tags,
                    file = b.file,
                    blockId = blockId,
                    funcSignature = s.funcSignature,
                    formatString = s.formatString
                )
            )
        }
    }

    val data = VersionData(
        version = version,
        commitSha = sha,
        repo = repo,
        generatedAt = Instant.now().toString(),
        blocks = blocks,
        sites = allSites
    )
    val mapper = jacksonObjectMapper().enable(SerializationFeature.INDENT_OUTPUT)
    val out = outDir.resolve("$version.json")
    Files.writeString(out, mapper.writeValueAsString(data))
    System.err.println("wrote ${allSites.size} sites to $out")
}

private fun tags(args: Array<String>) {
    require(args.size == 3) { "tags needs: <jdk-src-dir> <out-data-dir>" }
    val srcDir = Paths.get(args[1])
    val outDir = Paths.get(args[2])
    Files.createDirectories(outDir)
    val hpp = srcDir.resolve("src/hotspot/share/logging/logTag.hpp")
    val tagNames = TagListParser.parse(Files.readString(hpp))
    val tagInfos = tagNames.map { TagInfo(it, TagDescriptions.describe(it)) }
    val data = TagsData(TagListParser.levels, tagInfos)
    val mapper = jacksonObjectMapper().enable(SerializationFeature.INDENT_OUTPUT)
    Files.writeString(outDir.resolve("tags.json"), mapper.writeValueAsString(data))
    System.err.println("wrote ${tagInfos.size} tags to ${outDir.resolve("tags.json")}")
}

/**
 * Attaches captured benchmark samples to an existing `<version>.json`.
 *
 * Reads every `<gc>.log` (+ optional `<gc>.meta` carrying `wallSeconds=`) from the capture dir,
 * matches each line back to its source site (SampleMatcher), stores per-site samples + the raw log
 * + per-(level,tagset) volume, and rewrites the JSON in place.
 */
private fun samples(args: Array<String>) {
    require(args.size in 3..4) { "samples needs: <version.json> <capture-dir> [maxPerSite]" }
    val jsonPath = Paths.get(args[1])
    val captureDir = Paths.get(args[2])
    val maxPerSite = args.getOrNull(3)?.toInt() ?: 5

    val mapper = jacksonObjectMapper().enable(SerializationFeature.INDENT_OUTPUT)
    val data: VersionData = mapper.readValue(Files.readString(jsonPath))
    val outDir = jsonPath.toAbsolutePath().parent

    val logs = Files.list(captureDir).use { s ->
        s.filter { it.extension == "log" }.toList().sortedBy { it.fileName.toString() }
    }
    if (logs.isEmpty()) { System.err.println("no *.log in $captureDir"); return }

    for (log in logs) {
        val gc = log.nameWithoutExtension
        val meta = captureDir.resolve("$gc.meta")
        if (Files.exists(meta)) {
            Regex("""wallSeconds=([0-9.]+)""").find(Files.readString(meta))?.let {
                data.volumeStats.benchWallSeconds[gc] = it.groupValues[1].toDouble()
            }
        }

        // Stream the log line-by-line: an `all=trace` capture can be many gigabytes, far too large to
        // hold in memory. The matcher consumes the sequence in a single pass, filling per-site samples
        // and per-(level,tagset) volume. Simultaneously capture the first SAMPLE_LOG_LINES for the
        // frontend's "Sample log" tab (a bounded sibling file the browser fetches).
        val logName = "${data.version}.$gc.log"
        var total = 0L
        Files.newBufferedReader(log).use { reader ->
            Files.newBufferedWriter(outDir.resolve(logName)).use { writer ->
                val lines = reader.lineSequence().onEach { line ->
                    total++
                    if (total <= SAMPLE_LOG_LINES) { writer.write(line); writer.write("\n") }
                }
                SampleMatcher.match(data.sites, gc, lines, maxPerSite, data.volumeStats)
            }
        }
        data.sampleLogFiles[gc] = logName
        val matched = data.sites.count { it.samples[gc]?.isNotEmpty() == true }
        System.err.println("  $gc: $total lines, matched $matched sites")
    }

    Files.writeString(jsonPath, mapper.writeValueAsString(data))
    System.err.println("updated $jsonPath with samples from ${logs.size} GC log(s)")
}
