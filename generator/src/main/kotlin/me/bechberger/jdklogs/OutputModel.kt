// SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
// SPDX-License-Identifier: GPL-2.0-only
package me.bechberger.jdklogs

/** JSON DTOs for `data/<version>.json`, consumed directly by the frontend. */

data class SiteJson(
    val id: String,
    val level: String,
    val tags: List<String>,
    val file: String,
    val blockId: String,
    val funcSignature: String?,
    val formatString: String? = null,             // printf format for sample matching
    var samples: MutableMap<String, MutableList<String>> = mutableMapOf() // GC -> sample lines
)

/** A shared context block: many sites in the same source region reference one Block. */
data class Block(
    val file: String,
    val startLine: Int,
    val endLine: Int,
    val snippet: String,
    val firingLineOffsets: List<Int>
)

data class TagsetVolume(
    var bytes: Long = 0,
    var lines: Long = 0
)

data class VolumeStats(
    var benchWallSeconds: MutableMap<String, Double> = mutableMapOf(),   // GC -> wall seconds
    // "<level>,<tagset>" -> GC -> {bytes,lines}
    var perTagset: MutableMap<String, MutableMap<String, TagsetVolume>> = mutableMapOf()
)

data class VersionData(
    val version: String,
    val commitSha: String,
    val repo: String,               // e.g. openjdk/jdk, openjdk/jdk21u
    val generatedAt: String,
    val blocks: Map<String, Block>, // blockId -> shared context block; GitHub URL derived client-side
    val sites: List<SiteJson>,
    // GC -> relative path of the raw sample log (fetched lazily by the frontend, not inlined)
    var sampleLogFiles: MutableMap<String, String> = mutableMapOf(),
    var volumeStats: VolumeStats = VolumeStats()
)

data class TagInfo(val name: String, val description: String)

data class TagsData(
    val levels: List<String>,
    val tags: List<TagInfo>
)
