# JFR Event Proposals: Source-Level Evidence Dossier

**Status**: Working document — 14 active proposals, 2 removed/blocked  
**Audience**: OpenJDK developers; every claim is traceable to a source file, line, and log site  
**Last updated**: 2026-08-17

---

## How to Read This Document

### The log-level distinction and what it means for JFR

HotSpot log tags (`log_info`, `log_debug`, `log_trace`) reflect how operators trigger output via `-Xlog`. They do **not** govern whether data is available in the production JVM. A `log_debug` site in a product build still executes its code; the log message is simply gated behind a flag.

JFR events are not `-Xlog` messages. They use a separate `Enabled` flag controlled by `JVM.flightRecorder` or a JFC profile. It is therefore technically sound to propose a JFR event whose instrumentation point sits next to a `log_debug` call, as long as:

1. The code path executes in a production (non-`PRODUCT`-stripped) build.
2. The data variables that would populate the event fields are in scope at that site.
3. Any `#ifndef PRODUCT` guards that would strip the code are absent (or the guard must be removed as a prerequisite).

Events sourced from `log_debug` sites are marked **"downgraded"** in the summary table because upstream reviewers will notice and may ask why the data is not first promoted to `log_info`. This is a legitimate review concern, but it is a separate question from technical feasibility.

Events sourced from sites inside `#ifndef PRODUCT` guards are **blocked** — the data literally does not exist in production builds and cannot be JFR-instrumented without first moving the data-collection code out of the guard.

### Verdict definitions

| Verdict | Meaning |
|---|---|
| **Propose** | Info-level source, clean fields, good prior art, ready to file |
| **Propose with caveats** | Info-level source but needs upstream code change, or has nullable-field complexity |
| **Redesign first** | Technically feasible but the current field design will receive pushback; slim down before filing |
| **Blocked** | Prerequisites must be resolved before this can be proposed |
| **Remove** | Superseded by an existing or recently-merged event |

---

## Summary Table

| # | Event name | Verdict | Priority | Log level | Fires when |
|---|---|---|---|---|---|
| — | jdk.StringDeduplicationStatistics | **Remove** | — | — | Superseded by jdk.StringDeduplication (JDK 26) |
| — | jdk.ShenandoahCardStatistics | **Blocked** | — | `#ifndef PRODUCT` | Guard must be removed first |
| 1 | jdk.NativeHeapTrim | **Propose with caveats** | High | `log_info(trimnative)` | Each native heap trim operation |
| 2 | jdk.GCOverheadLimitExceeded | **Propose with caveats** | High | `log_info(gc)` | OOM throw: GC overhead limit exceeded |
| 3 | jdk.ShenandoahMMU | **Propose with caveats** | High | `log_info(gc,ergo)` (primary); `log_debug(gc)` (periodic) | End of Shenandoah GC phase; ~200ms periodic |
| 4 | jdk.ShenandoahCollectionDecision | **Redesign first** | High | `log_info(gc,ergo)` / `log_info(gc)` | Shenandoah GC cycle start |
| 5 | jdk.ShenandoahReclaimProgress | **Propose with caveats** | Medium | `log_info(gc,ergo)` | End of degenerated or full Shenandoah GC |
| 6 | jdk.ShenandoahTenuringThreshold | **Propose** | Medium | `log_info(gc,age)` | Each Shenandoah young collection planning phase |
| 7 | jdk.ZGCTenuringThreshold | **Propose** | Medium | `log_info(gc,reloc)` | Each ZGC young collection relocation-set selection |
| 8 | jdk.ZNMethodRegistration | **Propose with caveats** | Low | `log_info(gc,nmethod)` | End of each ZGC generation collection |
| 9 | jdk.G1ConcurrentRefinementSweep | **Propose with caveats** | Medium | `log_debug(gc,refine)` | Each G1 refinement sweep completion |
| 10 | jdk.G1ConcurrentRefinementPolicy | **Propose with caveats** | Medium | `log_debug(gc,refine)` | Each young GC pause end + periodic |
| 11 | jdk.G1CollectionSetCandidates | **Propose with caveats** | Medium | `log_debug(gc,ergo,cset)` | Each mixed GC CSet finalization |
| 12 | jdk.G1HeapResize | **Propose with caveats** | Medium | `log_debug(gc,ergo,heap)` | Each young GC pause end |
| 13 | jdk.ZDirectorRule | **Redesign first** | Medium | `log_debug(gc,director)` | Each ZGC director tick (~1s) |
| 14 | jdk.PSAdaptiveSizePolicy | **Propose with caveats** | Medium | `log_debug(gc,ergo)` | Each Parallel GC young collection |

---

## Removed and Blocked Events

### jdk.StringDeduplicationStatistics — REMOVE (Superseded)

**Status**: Remove from proposal list.

**Reason**: `jdk.StringDeduplication` was merged in JDK 26 via [PR #28015](https://github.com/openjdk/jdk/pull/28015). That event covers the per-operation deduplication signal. The only remaining gap is cumulative totals (`totalDedupedBytes`, `totalNewUnknownBytes`) that a statistics-style event would have provided.

**Recommendation**: Rather than proposing a separate statistics event, file a follow-up to extend `jdk.StringDeduplication` with cumulative total fields. That is a smaller diff and will receive less friction.

**Source context**: `src/hotspot/share/gc/shared/stringdedup/stringDedupStat.cpp`, function `StringDedup::Stat::log_summary()`.

---

### jdk.ShenandoahCardStatistics — BLOCKED

**Status**: Blocked. Do not propose until the prerequisite is resolved.

**Reason**: `ShenandoahCardStats::log()` is wrapped in a `#ifndef PRODUCT` guard at [`shenandoahCardStats.cpp:31–42`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahCardStats.cpp#L31). This means the data-collection code is compiled out of production (`-DPRODUCT`) JVM builds. A JFR event reading fields from this function would require either:

1. Moving the data-collection (not just the logging) out of the `#ifndef PRODUCT` guard, or
2. Maintaining a separate production-safe accumulator.

Neither is trivial. Proposing the JFR event without resolving this first will result in immediate rejection.

**Prerequisite**: File a separate preparatory patch to move `ShenandoahCardStats` data collection to a production code path. Once that is merged, the JFR event can be proposed as a follow-up.

---

## Active Proposals

---

### 1. jdk.NativeHeapTrim

#### Verdict

**Propose with caveats.** The log level is `log_info` and the motivation is clear, but a minor code change is required at the `os::trim_native_heap()` call site to decouple data collection from the log-enabled flag. That change must land first or be bundled in the same PR.

#### The question it answers

"How much RSS did this trim operation recover, and how long did it take?"

Today, an operator can observe that `TrimNativeHeapInterval` is set, but has no JFR signal confirming that trims are executing or recovering any memory. The only visibility is via `-Xlog:trimnative=info`. There is no existing JFR event tracking deliberate native heap trimming or the RSS delta it produces.

`jdk.ResidentSetSize` (JDK 27 master) tracks instantaneous RSS. It is complementary: it answers "what is RSS right now," not "how much did a trim operation recover." The delta from a deliberate trim cannot be reconstructed from instantaneous RSS snapshots because other allocation activity happens concurrently.

#### Emission point

**Function**: `NativeHeapTrimmer::Trimmer::execute_trim_and_log()`  
**File**: [`trimNativeHeap.cpp:150,155`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/runtime/trimNativeHeap.cpp#L150)  
**Log tag**: `log_info(trimnative)` — info level, suitable for production use.

**Exact log messages** (from [`trimNativeHeap.cpp:150`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/runtime/trimNativeHeap.cpp#L150)):
```
// When RSS details are available:
log_info(trimnative)("Periodic Trim (%lu): %s->%s (%c%s) %.3fms", ...)
// When RSS details are unavailable (non-Linux or restricted):
log_info(trimnative)("Periodic Trim (%lu): complete (no details) %.3fms", ...)
```

**Call chain**:
```
NativeHeapTrimmer background thread
  → wakes up every TrimNativeHeapInterval ms (default 1000ms on container JVMs)
  → execute_trim_and_log()   [trimNativeHeap.cpp:150](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/runtime/trimNativeHeap.cpp#L150)
```

**Cadence**: Once per trim operation. Rate is controlled by `-XX:TrimNativeHeapInterval` (default 1000ms on container JVMs).

**Thread**: Dedicated `NativeHeapTrimmer` thread. Not a GC thread. Not the application thread.

#### Implementation constraint (prerequisite code change)

The RSS data `sc.before` and `sc.after` are collected from `/proc/self/status VmRSS` at [`trimNativeHeap.cpp:141`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/runtime/trimNativeHeap.cpp#L141) **only** when `const bool logging_enabled = lt.is_enabled()` is true. The `SizingCollection*` pointer is passed to `os::trim_native_heap()` only in the logging branch.

A JFR event implementation **must not** gate data collection on whether `-Xlog:trimnative=info` is active. The fix is to call `os::trim_native_heap()` with a non-null `SizingCollection*` unconditionally — or, equivalently, to check `(lt.is_enabled() || jfr_event_enabled)` before deciding whether to populate the struct. This is a small upstream code change but it is a real prerequisite.

#### Fields

| Field | Source | Nullable? |
|---|---|---|
| `startTime` | Standard JFR | No |
| `duration` | Standard JFR | No |
| `trimCount` | `uint64_t _num_trims_performed` — cumulative since JVM start; first event = 1 | No |
| `beforeBytes` | `sc.before` from `/proc/self/status VmRSS` | Yes — false on non-Linux or restricted containers |
| `afterBytes` | `sc.after` | Yes — same condition |
| `deltaBytes` | `afterBytes - beforeBytes` — SIGNED; negative value = memory returned to OS | Yes — same condition |
| `detailsAvailable` | `false` on non-Linux or restricted containers | No |

The sign convention on `deltaBytes` is important: a successful trim returns a negative delta (afterBytes < beforeBytes). This is counterintuitive but matches the "after minus before" arithmetic. If upstream prefers an unsigned `freedBytes = max(0, beforeBytes - afterBytes)`, that is an equivalent design choice.

#### What it is used for

Containerized JVMs running glibc suffer from a well-known RSS bloat problem: malloc arenas fragment over time, returning memory to the OS slowly or not at all. `TrimNativeHeapInterval` (default 1000ms in container environments) runs a background trim. Without a JFR event, operators cannot verify that:
1. Trims are executing at the configured interval.
2. Each trim is recovering any RSS (a trim that executes but recovers 0 bytes indicates all arenas are fully committed — there is nothing to return).
3. The trim delta is significant enough to justify the trim overhead.

**Tuning patterns**:
- `deltaBytes` near 0 on most trims → either the JVM is continuously using all its native memory (no arena bloat), or the platform does not support RSS recovery (check `detailsAvailable`).
- `deltaBytes` large (> 100MB) on first trim, then near 0 → normal: initial trim clears accumulated arena bloat; subsequent trims find little to release.
- Trim frequency can be tuned via `-XX:TrimNativeHeapInterval`; if `deltaBytes` is consistently 0, the interval can be increased to reduce overhead.

#### Why existing events don't cover this

- `jdk.ResidentSetSize`: tracks instantaneous RSS, not trim deltas. Cannot distinguish a trim recovery from normal allocation fluctuation.
- No other JFR event mentions `trimnative`, `NativeHeapTrimmer`, or `os::trim_native_heap`.

#### Upstream history

JDK-8365306 / [PR #26756](https://github.com/openjdk/jdk/pull/26756) — opened by Thomas Stuefe, closed December 2025 due to inactivity. The closure was preceded by a design disagreement with egahlin, who wanted per-platform normalized size events rather than a grouped ProcessSize umbrella event. The `NativeHeapTrim` event **specifically was not objected to** — only the broader `ProcessSize` umbrella was contentious. A narrow trim-only re-proposal avoids the contested scope.

#### Open questions / upstream concerns

1. Will upstream accept the `os::trim_native_heap()` call-site change to decouple from `logging_enabled`? This is the crux. The patch is small but touches a hot path.
2. Should `deltaBytes` be signed (negative = memory returned) or should the event expose `freedBytes` as an unsigned value with an `expanded` boolean? The signed design is more informative but unusual in JFR fields.
3. Should `trimCount` be cumulative or per-event (always 1)? Cumulative is more useful for detecting missed events in continuous recordings.

---

### 2. jdk.GCOverheadLimitExceeded

#### Verdict

**Propose with caveats.** Two GC implementations have different field shapes for free-space metrics. Either accept nullable fields (with documentation) or consider two separate events.

#### The question it answers

"What was the JVM's state immediately before throwing GCOverheadLimitExceeded OOM?"

Today, `jdk.OutOfMemoryError` (if it exists) fires at the Java level, after the OOM object has been constructed and is propagating up the call stack. There is no JFR signal at the GC decision point — the moment the GC subsystem decides the overhead limit has been breached. Operators learn about GCOverheadLimitExceeded only via logs or heap dumps, not via a structured JFR record containing the GC time percent and free-space state at the moment of the decision.

#### Emission point

Two sites, one per GC implementation:

**G1**: `G1CollectedHeap::satisfy_failed_allocation()`  
[`g1CollectedHeap.cpp:1110`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1CollectedHeap.cpp#L1110)  
Log: `log_info(gc)("GC Overhead Limit exceeded too often (%zu).", GCOverheadLimitThreshold)`

**Parallel GC**: `ParallelScavengeHeap::satisfy_failed_allocation()`  
[`parallelScavengeHeap.cpp:507`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/parallelScavengeHeap.cpp#L507)  
Log: `log_info(gc)("GC Overhead Limit exceeded too often (%zu).", GCOverheadLimitThreshold)` (identical string)

**Counter-update log** (debug-tier, NOT the event site):  
G1 [`g1CollectedHeap.cpp:1006`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1CollectedHeap.cpp#L1006): `log_debug(gc)("GC Overhead Limit: GC Time %f Free Space %f Counter %zu", ...)`  
Parallel [`parallelScavengeHeap.cpp:440`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/parallelScavengeHeap.cpp#L440): `log_debug(gc)("GC Overhead Limit: GC Time %f Free Space Young %f Old %f Counter %zu", ...)`

**Call chain (G1)**:
```
Allocating application thread
  → allocation fast-path failure
  → attempt_allocation_humongous() or expand_heap_and_attempt_allocation()
  → satisfy_failed_allocation()   [g1CollectedHeap.cpp:1110](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1CollectedHeap.cpp#L1110)
  → fires when gc_overhead_limit_exceeded() returns true
```

**Cadence**: Once per OOM throw. At most once per JVM lifetime unless `-XX:-ExitOnOutOfMemoryError` is set, in which case the JVM exits on the first occurrence.

**Thread**: Allocating application thread (not a GC thread).

**GCOverheadLimit feature**: Implemented in G1 via [JDK-8212084](https://bugs.openjdk.org/browse/JDK-8212084), [PR #27950](https://github.com/openjdk/jdk/pull/27950), merged JDK 26. Also present in Parallel GC.

**Counter-update vs. throw-point distinction**: `update_gc_overhead_counter()` ([`g1CollectedHeap.cpp:995`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1CollectedHeap.cpp#L995)) runs at each safepoint and logs the raw counter at `log_debug(gc)`. The JFR event belongs at the throw point — `satisfy_failed_allocation()` line 1109 — where `gc_overhead_limit_exceeded()` returns true and control flow is about to return null to the allocating thread. At that point, the final counter value, `long_term_gc_time_ratio`, and `free_space_percent` are all in scope.

#### Fields

| Field | Source | G1 | Parallel | Nullable? |
|---|---|---|---|---|
| `startTime` | Standard JFR | Yes | Yes | No |
| `gcId` | `GCId::peek() - 1` — last assigned GC id; `peek()` returns `_next_id` (the NEXT id to be assigned), so `peek()-1` gives the last completed GC id | Yes | Yes | Yes (undefined if no GC has run yet) |
| `collector` | String literal: `"G1"` or `"Parallel"` | Yes | Yes | No |
| `gcTimePercent` | G1: `_policy->analytics()->long_term_gc_time_ratio() * 100` ([`g1CollectedHeap.cpp:1002`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1CollectedHeap.cpp#L1002)); Parallel: `100 - _size_policy->mutator_time_percent() * 100` ([`parallelScavengeHeap.cpp:436`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/parallelScavengeHeap.cpp#L436)) | Yes | Yes | No |
| `freeSpacePercent` | G1: `percent_of(num_available_regions() * G1HeapRegion::GrainBytes, max_capacity())` ([`g1CollectedHeap.cpp:1003`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1CollectedHeap.cpp#L1003)) | Yes | No | Yes (null for Parallel) |
| `freeSpaceYoungPercent` | Parallel: `percent_of(_young_gen->free_in_bytes(), _young_gen->capacity_in_bytes())` ([`parallelScavengeHeap.cpp:437`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/parallelScavengeHeap.cpp#L437)) | No | Yes | Yes (null for G1) |
| `freeSpaceOldPercent` | Parallel: `percent_of(_old_gen->free_in_bytes(), _old_gen->capacity_in_bytes())` ([`parallelScavengeHeap.cpp:438`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/parallelScavengeHeap.cpp#L438)) | No | Yes | Yes (null for G1) |
| `consecutiveViolations` | `_gc_overhead_counter`; equals `GCOverheadLimitThreshold` (default 5) at throw time — counter incremented in `update_gc_overhead_counter()` at each safepoint, checked via `gc_overhead_limit_exceeded()` | Yes | Yes | No |

#### Why existing events don't cover this

- `jdk.OutOfMemoryError` (hypothetical): fires at the Java exception propagation level, not at the GC decision point. The GC state fields (`gcTimePercent`, `freeSpacePercent`) are not accessible from the Java level.
- `jdk.GCHeapSummary`, `jdk.G1HeapSummary`, `jdk.PSHeapSummary`: record heap sizes at GC events, not at the allocation failure → OOM decision moment.
- No existing JFR event captures the GC overhead limit violation counter or the decision to throw.

#### What it is used for

`GCOverheadLimitExceeded` OOM is one of the hardest production failures to diagnose post-hoc because the JVM typically exits immediately. Heap dumps capture the live set but not the GC overhead metrics at the moment of the decision. This event fires synchronously at the throw point, giving you a structured record of:

- Was the threshold correctly calibrated? `gcTimePercent` shows the actual GC time fraction at the moment of throw. If it equals exactly `GCTimeLimit` (default 98%), the threshold was met as expected. If it seems lower, check whether `consecutiveViolations` (always at `GCOverheadLimitThreshold`) was the binding constraint.
- What was the heap free-space ratio? Low `freeSpacePercent` confirms heap exhaustion; high `freeSpacePercent` with high `gcTimePercent` indicates GC is running but not reclaiming (live set too large, not heap exhaustion).
- **Tuning**: if `gcTimePercent` is high but `freeSpacePercent` is also reasonable, the heap may be correctly sized but the workload has a large live set that GC cannot shrink. Increase `-Xmx` or reduce the live set. If `freeSpacePercent` is also near 0, the application is genuinely out of memory.

#### Open questions / upstream concerns

1. G1 and Parallel have different free-space field shapes. The nullable pattern is acceptable in JFR but upstream may want two separate events (`jdk.G1GCOverheadLimitExceeded`, `jdk.ParallelGCOverheadLimitExceeded`) to avoid the impedance mismatch. The trade-off: separate events are cleaner but require more boilerplate.
2. `gcId` should use `GCId::peek() - 1` (last assigned GC id). `GCId::peek()` returns `_next_id` (the id to be assigned to the NEXT GC), so the last completed GC id is `peek() - 1`. If `peek() == 0` (no GC has run), the field should be `undefined`. Alternatively, use `GCId::current_or_undefined()` if the throw-point happens to be on a GC thread, but at `satisfy_failed_allocation()` the thread is the allocating application thread, so `current()` would assert — `peek()-1` is the correct mechanism.
3. `consecutiveViolations` is always equal to `GCOverheadLimitThreshold` at throw time (the counter must reach the threshold to throw). Is this field useful, or is it a constant disguised as a variable?
4. Both GC implementations call `update_gc_overhead_counter()` (G1) / `check_gc_overhead_limit()` (Parallel) from `satisfy_failed_allocation()` and then check the result before throwing. The event must fire **after** the counter update and **before** returning null — i.e., at the `if (gc_overhead_limit_exceeded())` block at line 1109 / line 506 respectively. The `long_term_gc_time_ratio` and free-space values computed in the same update call are still in-scope locals at that point.

---

### 3. jdk.ShenandoahMMU

#### Verdict

**Propose with caveats.** The end-of-cycle path (log_info) is clean and ready to propose. The periodic path (log_debug) should be dropped from the initial proposal or guarded behind a separate JFR flag. Do not bundle the debug-level periodic path with the info-level end-of-cycle path in the same upstream submission.

#### The question it answers

"What fraction of wall-clock time is the Shenandoah GC consuming vs. mutator threads?"

`jdk.G1MMU` exists but measures something different: G1 MMU is pause-time compliance within a fixed time-slice window (gcTime in ms vs. pauseTarget in ms). Shenandoah MMU measures GCU%/MU% fractions over the entire GC phase window — the time spent doing GC work as a fraction of elapsed wall-clock time. These are semantically distinct metrics and there is no overlap.

No existing JFR event covers Shenandoah's GCU%/MU% breakdown.

#### Emission points

**End-of-cycle (log_info — primary)**:  
`ShenandoahMmuTracker::update_utilization()`  
[`shenandoahMmuTracker.cpp:107`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahMmuTracker.cpp#L107)  
Log: `log_info(gc, ergo)("At end of %s: GCU: %.1f%%, MU: %.1f%% during period of %.3fs", ...)`  
Log tag: `log_info(gc,ergo)` — info level.

**Old marking increment (log_info)**:  
`ShenandoahMmuTracker::record_old_marking_increment()`  
[`shenandoahMmuTracker.cpp:134`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahMmuTracker.cpp#L134)  
Log: `log_info(gc, ergo)("At end of %s: GCU: %.1f%%, MU: %.1f%% for duration %.3fs (totals to be subsumed in next gc report)", ...)`  
Log tag: `log_info(gc,ergo)` — info level.

**Periodic sample (log_debug — secondary, NOT in initial proposal)**:  
`ShenandoahMmuTracker::report()`  
[`shenandoahMmuTracker.cpp:173`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahMmuTracker.cpp#L173)  
Log: `log_debug(gc)("Periodic Sample: GCU = %.3f%%, MU = %.3f%% during most recent %.1fs", ...)`  
Log tag: `log_debug(gc)` — debug level. This path should NOT be bundled with the initial proposal.

**Call chain (end-of-cycle)**:
```
Shenandoah generational control thread
  → end of collection phase
  → update_utilization()   [shenandoahMmuTracker.cpp:107](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahMmuTracker.cpp#L107)
```

**Call chain (periodic, debug-tier)**:
```
ShenandoahMmuTask::task()   [PeriodicTask at GCPauseIntervalMillis ~200ms]
  → report()   [shenandoahMmuTracker.cpp:173](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahMmuTracker.cpp#L173)
```

**Cadence**: Once per completed GC phase (end-of-cycle). Plus every ~200ms for the periodic path (excluded from initial proposal).

**Thread**: Generational control thread (end-of-cycle); dedicated timer thread (periodic).

#### Fields

| Field | Source | Nullable? | Tuning use |
|---|---|---|---|
| `startTime` | Standard JFR | No | Timestamp of GC phase completion |
| `gcId` | `_most_recent_gcid` — GC ID of the collection that updated the MMU tracker | No | Correlate with `jdk.GarbageCollection` |
| `phase` | `"Concurrent Young GC"`, `"Concurrent Global GC"`, `"Concurrent Bootstrap GC"`, `"Mixed Concurrent GC"`, `"Full GC"`, `"Degenerated Young GC"`, `"Degenerated Global GC"`, `"Degenerated Bootstrap Old GC"` — exact strings from `update_utilization()` callers in [`shenandoahMmuTracker.cpp`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahMmuTracker.cpp) and [`shenandoahDegeneratedGC.cpp:61`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahDegeneratedGC.cpp#L61) | Yes (null for periodic path if added later) | Compare GCU% across phases: Full GC and degenerated GC typically have higher GCU% than concurrent |
| `gcuPercent` | GC utilization 0–100 — fraction of elapsed wall-clock time spent doing GC work | No | **Primary metric**: high `gcuPercent` means GC is consuming a large fraction of CPU time. Compare against SLA: e.g., `gcuPercent > 20%` might violate a throughput target |
| `muPercent` | Mutator utilization 0–100 — `100 - gcuPercent` approximately | No | **Complementary**: the fraction of wall-clock time mutators ran; `muPercent = 100 - gcuPercent` when tracking is exact |
| `periodSeconds` | Measurement window duration in seconds — length of the phase or measurement window | No | Normalizes the GCU%: a 5% GCU over 100ms vs. 100ms is the same rate as 5% over 1s |
| `isPeriodicSample` | `true` when emitted from `report()` periodic path | No | Distinguishes end-of-cycle measurements (high accuracy) from periodic snapshots (interpolated); for initial proposal this is always `false` |

#### What it is used for

`jdk.G1MMU` measures whether G1 met its pause-time goal within a fixed window. Shenandoah MMU measures something fundamentally different: what fraction of wall-clock time was the JVM spending on GC across an entire GC phase? This answers SLA questions like "is my application spending > 10% of time in GC?" — questions that pause-time metrics alone cannot answer for concurrent collectors (where much of the GC work is not a pause at all).

**Key patterns**:
- `gcuPercent` trending upward across consecutive young GCs → GC CPU overhead is growing; likely means allocation rate is increasing faster than GC throughput. Check heap sizing.
- `gcuPercent` high for `phase="Concurrent Young GC"` but normal for global → young generation is undersized, running concurrent collections more frequently than the old generation needs.
- `gcuPercent > 30%` sustained → this is approaching the point where GC overhead is seriously impacting application throughput; consider increasing `-Xmx` or reducing live set.
- Comparing `gcuPercent` for `"Full GC"` vs `"Concurrent Young GC"` phases quantifies the relative cost of fallback vs. normal operation.

#### Why existing events don't cover this

- `jdk.G1MMU`: measures pause compliance in a fixed window (ms units, G1-specific). Structurally different from Shenandoah's GCU%/MU% fraction.
- `jdk.GarbageCollection`, `jdk.ShenandoahHeapRegionStateChange`: record GC outcomes and region states; do not capture time-fraction breakdown between GC and mutator.
- No Shenandoah-specific JFR event captures the MMU tracker data.

#### Open questions / upstream concerns

1. Should `isPeriodicSample=true` events be dropped entirely? The `report()` function is log_debug, and exposing debug-tier data in a production JFR event requires justification. The end-of-cycle path alone is the clean proposal.
2. Is `gcId` from `_most_recent_gcid` reliable at the end-of-cycle emission point? If the control thread updates `_most_recent_gcid` at the start of a cycle, the end-of-cycle value correctly identifies the completed cycle.
3. Should the event merge with `jdk.ShenandoahCollectionDecision`? No: they fire at opposite ends of the GC cycle (start vs. end) and carry non-overlapping fields.

---

### 4. jdk.ShenandoahCollectionDecision

#### Verdict

**Redesign first.** The event spans three or more code sites, including one field group from a different thread (regulator thread). Upstream reviewers will ask for a single emission point. The trigger-detail fields (6 extra nullable fields from `log_trigger`) are best separated into a `jdk.ShenandoahGCTrigger` event. Propose the two events separately.

#### The question it answers

"Why did Shenandoah start a GC cycle, which generation was targeted, and what triggered it?"

No existing JFR event captures Shenandoah's control-thread FSM decisions. `jdk.GCHeapSummary` and `jdk.ShenandoahHeapRegionStateChange` show sizes and region states after the fact; neither captures the heuristic reasoning.

#### Emission points

**Primary (log_info)**:  
`ShenandoahGenerationalControlThread::service_concurrent_normal_cycle()`  
[`shenandoahGenerationalControlThread.cpp:374`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahGenerationalControlThread.cpp#L374)  
Log: `log_info(gc, ergo)("Start GC cycle (%s)", request.generation->name())`

**Trigger fields (log_info)**:  
`ShenandoahHeuristics::log_trigger()`  
[`shenandoahHeuristics.cpp:248`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/heuristics/shenandoahHeuristics.cpp#L248)  
Resolves to `log_info(gc)` in production. Example trigger log messages:
```
log_info(gc)("Trigger (Young): Anticipated GC duration (%.2f ms) is above the time for average allocation rate ...")
log_info(gc)("Trigger (Young): Momentary spike consumption ... exceeds free headroom ...")
log_info(gc)("Trigger (Old): Old has overgrown, live at end of previous OLD marking: ...")
log_info(gc)("Trigger (Old): Old has become fragmented: ... density: %.1f%%")
log_info(gc)("Trigger (Old): Expansion failure, current size: ...")
```

**Old immediate garbage (log_info)**:  
`ShenandoahOldHeuristics::prepare_for_old_collections()`  
[`shenandoahOldHeuristics.cpp:569`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/heuristics/shenandoahOldHeuristics.cpp#L569)  
**Exact log messages** (lines 567–572):
```
log_info(gc, ergo)("Old-Gen Collectable Garbage: ... consolidated with free: ..., over %zu regions", ...)
log_info(gc, ergo)("Old-Gen Immediate Garbage: ... over %zu regions", ...)
log_info(gc, ergo)("Old regions selected for defragmentation: %zu", defrag_count)
log_info(gc, ergo)("Old regions not selected: %zu", total_uncollected_old_regions)
```
Log tag: `log_info(gc,ergo)`.

**Annotated log_debug entries (NOT primary anchors)**:  
`shenandoahRegulatorThread.cpp:75,78,82,88` — `log_debug(gc)` — "Heuristics request for young collection accepted" etc. These are informational and NOT part of the event emission.

**Call chain (primary)**:
```
Shenandoah generational control thread main loop
  → service_concurrent_normal_cycle()   [shenandoahGenerationalControlThread.cpp:374](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahGenerationalControlThread.cpp#L374)
  → fires at GC cycle start
Trigger fields from: regulator thread → heuristic should_start_gc() calls
                     → log_trigger() → [shenandoahHeuristics.cpp:248](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/heuristics/shenandoahHeuristics.cpp#L248)
```

**Cadence**: Once per GC cycle start.

**Thread**: Shenandoah generational control thread (primary); regulator thread (trigger fields).

#### Fields

**Base fields** (always present):

| Field | Source | Nullable? |
|---|---|---|
| `startTime` | Standard JFR | No |
| `decision` | `gc_mode_name(gc_mode())` from `ShenandoahGenerationalControlThread` at [`shenandoahGenerationalControlThread.cpp:765`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahGenerationalControlThread.cpp#L765): `"idle"`, `"normal"` (concurrent normal), `"degenerated"` (STW degenerated), `"full"` (STW full), `"old"` (servicing old), `"bootstrap"` (bootstrapping old) | No |
| `generation` | `"Young"` / `"Old"` / `"Global"` | No |
| `cause` | `shenandoah_concurrent_gc` / `metadata_GC_threshold` / `alloc_failure` / etc. | No |
| `available` | Available bytes at decision time | No |
| `softMaxCapacity` | Soft max capacity in bytes | No |

**Adaptive heuristic fields** (null for non-adaptive heuristics):

| Field | Source | Nullable? |
|---|---|---|
| `marginOfError` | `_margin_of_error_sd` from `ShenandoahAdaptiveHeuristics` | Yes |
| `triggerType` | `"rate_average"` / `"rate_momentary"` / `"rate_accelerated"` / `"fragmentation"` / `"growth"` / `"expansion_failure"` / `"min_free"` / `"learning"` / `"pending"` / `"other"` | Yes |
| `anticipatedGcDurationMs` | ms; rate triggers only | Yes |
| `baselineConsumptionBytes` | rate_average trigger only | Yes |
| `fragmentationDensityPct` | fragmentation trigger only | Yes |
| `fragmentedFreeBytes` | fragmentation trigger only | Yes |
| `liveAtPrevMarkBytes` | growth trigger only | Yes |
| `currentUsageBytes` | growth trigger only | Yes |

**Mixed GC fields** (null unless mixed GC):

| Field | Source | Nullable? |
|---|---|---|
| `immediateGarbage` | Immediate garbage bytes from `prepare_for_old_collections()` | Yes |
| `immediateRegions` | Immediate garbage region count | Yes |
| `mixedCandidates` | Old region mixed collection candidates | Yes |
| `mixedRegionsSelected` | Old regions selected | Yes |
| `oldEvacuationBudget` | Old gen evacuation budget in bytes | Yes |
| `defragRegions` | Defragmentation region count | Yes |

#### Why existing events don't cover this

- `jdk.ShenandoahHeapRegionStateChange`: fires after regions change state; does not capture the heuristic decision at the start of a cycle.
- `jdk.GCHeapSummary`: records heap sizes before/after GC; does not capture why GC was started.
- `jdk.GarbageCollection`: records GC outcomes; the `cause` field exists but does not capture the rich heuristic reasoning (trigger type, rates, fragmentation metrics).

#### What it is used for

Shenandoah's generational heuristics make nuanced decisions — not just "heap is full, start GC" but "allocation is accelerating at this rate for this anticipated duration, and given this margin of error." Without this event, every GC start looks identical in JFR: a `jdk.GarbageCollection` event with a cause string. You cannot tell whether GC started because of a smooth allocation rate, a momentary spike, old-gen fragmentation, or a growth trigger.

**Tuning patterns**:
- `triggerType=rate_accelerated` repeatedly → workload has frequent phase changes (many threads suddenly allocating). `anticipatedGcDurationMs` tells you how much buffer exists; if it's shrinking over time, the heap is under increasing pressure.
- `triggerType=fragmentation` with growing `fragmentationDensityPct` → old gen is becoming sparser; consider lowering `ShenandoahOldGarbageThreshold` to reclaim fragmented regions more eagerly.
- `triggerType=growth` with `currentUsageBytes` >> `liveAtPrevMarkBytes` → promotions from young gen are accumulating in old gen faster than old GCs are running. Either increase old GC frequency or increase old-gen size.
- `triggerType=expansion_failure` → old gen is at max size and cannot expand; imminent OOM unless `-Xmx` is increased or the live set shrinks.
- `decision="old"` or `decision="bootstrap"` frequently → old-gen collections are running; if old gen is accumulating faster than being reclaimed, promotions are outpacing collection.
- `decision="degenerated"` and then `decision="full"` on the next cycle → degenerated GC failed to make progress (check `jdk.ShenandoahReclaimProgress`), escalating to full compaction.
- `decision="normal"` with `generation="Old"` unexpectedly frequent → old gen heuristics are triggering collections often; check trigger type and old-gen usage trends.

#### Open questions / upstream concerns

1. **Multi-site emission**: This event spans `service_concurrent_normal_cycle()` (control thread), `log_trigger()` (regulator thread), and `prepare_for_old_collections()` (old heuristics). Upstream will ask for a single emission point. The standard approach is to accumulate fields into a struct that is populated across the call chain and emitted at the control thread site. This is implementable but requires design work.
2. **Trigger field separation**: The 6+ nullable adaptive trigger fields are a natural candidate for a separate `jdk.ShenandoahGCTrigger` event. Separating them makes each event simpler and avoids the sparse-field problem.
3. **`decision` from `gc_mode_name()`**: the `GCMode` enum has 7 values (`none`, `concurrent_normal`, `stw_degenerated`, `stw_full`, `bootstrapping_old`, `servicing_old`, `stopped`); `gc_mode_name()` at line 765 maps these to strings. The `concurrent_normal` mode covers both young, old, global, and mixed collections — the generation is identified separately via `request.generation->name()`. The `decision` field should use the raw `gc_mode_name()` value (simple and exact); a separate `generation` field captures young vs. old vs. global.

---

### 5. jdk.ShenandoahReclaimProgress

#### Verdict

**Propose with caveats.** Use the simplified 4-field version for the initial upstream submission. The 12-field full version with nullable dimensions will receive pushback. `badProgressCount` is the single most actionable field and must be present in any version.

#### The question it answers

"Did the last degenerated or full GC make sufficient progress to avoid escalation?"

`ShenandoahMetricsSnapshot::is_good_progress()` assesses four dimensions after a degenerated or full GC: free space, used space freed, internal fragmentation, and external fragmentation. If two consecutive degenerated GCs fail this check, the policy escalates to Full GC. There is no JFR event today that exposes this progress assessment or the escalation counter.

#### Emission point

**Function**: `ShenandoahMetricsSnapshot::is_good_progress()`  
[`shenandoahMetrics.cpp:47,58,69,81`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahMetrics.cpp#L47)  
Log tag: `log_info(gc,ergo)` — info level.

**Exact log messages** (all four from [`shenandoahMetrics.cpp:38-90`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahMetrics.cpp#L38)):
```
log_info(gc, ergo)("%s progress for free space: %s, need %s", ...)       // line 47
log_info(gc, ergo)("%s progress for used space: %s, need %s", ...)       // line 58
log_info(gc, ergo)("%s progress for internal fragmentation: %.1f%%, need %.1f%%", ...)  // line 69
log_info(gc, ergo)("%s progress for external fragmentation: %.1f%%, need %.1f%%", ...)  // line 81
```
Where `%s` = `"Good"` or `"Bad"`.

**Call chain**:
```
GC STW thread
  → ShenandoahDegenGC::op_final_roots()   [shenandoahDegeneratedGC.cpp:330](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahDegeneratedGC.cpp#L330)
    → is_good_progress()   [shenandoahMetrics.cpp:47](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahMetrics.cpp#L47)
  → ShenandoahFullGC::op_gc()   [shenandoahFullGC.cpp:119](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahFullGC.cpp#L119)
    → is_good_progress()   [shenandoahMetrics.cpp:47](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahMetrics.cpp#L47)
```

**Cadence**: Once per degenerated or full GC ONLY. Does NOT fire after normal concurrent cycles.

**Thread**: GC STW thread.

**Exact evaluation logic** (from [`shenandoahMetrics.cpp:38-90`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahMetrics.cpp#L38)):

```
1. free_space check:  if fails → return false immediately (hard gate)
2. used_space check:  if passes → return true (short-circuit success)
3. internal_frag check: if passes → return true
4. external_frag check: if passes → return true
5. if none of 2–4 passed → return false
```

Free space (`free_actual >= free_expected`) is a **hard prerequisite** — if it fails, no further dimensions are checked and the function immediately returns `false`. If free space passes, the function returns `true` on the first of used_space, internal_frag, or external_frag that passes. Only if all three subsequent dimensions also fail does the function return `false`.

This means:
- `goodProgress=false, failedDimension=free_space` → free was below critical threshold; used/frag not evaluated
- `goodProgress=false, failedDimension=external_frag` → free passed, but used_space, internal_frag, AND external_frag all failed
- `goodProgress=true` → free passed, and at least one of used_space/internal_frag/external_frag passed (the first to pass caused early return)

**Exact source variables at `shenandoahMetrics.cpp:38-90`**:
- `freeActual = _free_set->available()` — available bytes in mutator partition
- `freeExpected = (soft_max_capacity / 100) * ShenandoahCriticalFreeThreshold`
- `progressActual = _used_before - used_after` (bytes freed this GC)
- `progressExpected = ShenandoahHeapRegion::region_size_bytes()` (threshold = 1 region)
- `ifActual = _if_before - _free_set->internal_fragmentation()` (delta fragmentation)
- `efActual = _ef_before - _free_set->external_fragmentation()` (delta fragmentation)

The `badProgressCount` is `ShenandoahCollectorPolicy::_consecutive_degenerated_gcs_without_progress`, incremented in `record_degenerated(bool progress)` at [`shenandoahCollectorPolicy.cpp:108`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahCollectorPolicy.cpp#L108). The threshold `CONSECUTIVE_BAD_DEGEN_PROGRESS_THRESHOLD = 2` is a `constexpr` at [`shenandoahCollectorPolicy.hpp:69`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahCollectorPolicy.hpp#L69). When `_consecutive_degenerated_gcs_without_progress >= 2`, `should_run_full_gc()` returns true and the next degenerated GC escalates to Full GC.

#### Fields

**Simplified version (recommended for upstream)**:

| Field | Source | Nullable? | Tuning use |
|---|---|---|---|
| `startTime` | Standard JFR | No | Correlate with `jdk.GarbageCollection` gcId |
| `freePercent` | `free_actual * 100 / soft_max_capacity` — available bytes in mutator partition / soft max | No | Low → approaching critical threshold; `ShenandoahCriticalFreeThreshold` (default 1%) is the boundary |
| `goodProgress` | Boolean result of `is_good_progress()` | No | `false` → this degenerated GC did not improve heap state; watch `badProgressCount` |
| `failedDimension` | First dimension that failed: `"free_space"` / `"used_space"` / `"internal_frag"` / `"external_frag"` / `null` if passed | Yes | Identifies which resource is constrained: free_space = overall pressure, used_space = GC didn't free enough, frag = heap is fragmented |
| `badProgressCount` | `_consecutive_degenerated_gcs_without_progress` from `ShenandoahCollectorPolicy`; threshold = `CONSECUTIVE_BAD_DEGEN_PROGRESS_THRESHOLD` (= 2) | No | **Most actionable field**: value ≥ 2 means next non-successful degenerated GC will escalate to Full GC; value = 1 is a warning |

**Full version (12 fields — for reference, not for initial proposal)**:

| Field | Source | Nullable? |
|---|---|---|
| `startTime`, `freePassed`, `goodProgress` | Always present | No |
| `freeActual`, `freeNeeded` | Always present | No |
| `usedFreed`, `usedNeededToFree`, `usedPassed` | Null if free check failed first | Yes |
| `internalFragDeltaPct`, `internalFragThresholdPct`, `internalFragPassed` | Null if earlier dimension failed | Yes |
| `externalFragDeltaPct`, `externalFragThresholdPct`, `externalFragPassed` | Null if earlier dimension failed | Yes |

#### What it is used for

A degenerated GC is Shenandoah's first-tier fallback: when a concurrent GC fails to keep up, the JVM falls back to a stop-the-world degenerated GC. If that too fails to make progress (e.g., heap is full and fragmented), the JVM escalates to Full GC (compacting, much longer pause). This event tells you **whether each fallback GC was productive**, and gives you an early warning of the escalation chain: `badProgressCount=1` means one consecutive failure, `badProgressCount=2` means the next failure triggers Full GC.

**Tuning actions per `failedDimension`**:
- `free_space`: heap is under sustained pressure — increase `-Xmx`, reduce live set, or lower `ShenandoahCriticalFreeThreshold`
- `used_space`: GC is running but not freeing enough — increase GC frequency (`ShenandoahMinFreeThreshold`) or reduce object tenure rates
- `internal_frag` / `external_frag`: fragmentation is not improving despite GC — consider reducing `ShenandoahGarbageThreshold` to collect more aggressive fragmented regions

#### Why existing events don't cover this

- `jdk.ShenandoahCollectionDecision` (proposed): fires at the START of a cycle; `ReclaimProgress` fires at the END of a degenerated/full GC. They are not mergeable.
- `jdk.GarbageCollection`: records GC completion; does not expose the progress assessment or the escalation counter.
- No existing JFR event exposes `_consecutive_degenerated_gcs_without_progress`.

#### Open questions / upstream concerns

1. The 12-field version with cascading nullability will receive pushback. The simplified 5-field version is the right starting point.
2. `badProgressCount` at value 2 means "Full GC will be triggered next" — this is the most actionable field. If only one field could be included, it would be this one.
3. Should the event also fire after a successful `is_good_progress()` call (when `goodProgress=true`)? Yes — the event is equally useful for confirming that a degenerated GC was sufficient.
4. Note the asymmetry in evaluation logic: free space is a hard gate (failure returns `false` immediately, no further checks). Used space, internal fragmentation, and external fragmentation are short-circuit successes (first to pass returns `true`). `goodProgress=false` means either free space failed, or free space passed but ALL THREE of used_space/internal_frag/external_frag also failed. The `failedDimension` field when `goodProgress=true` is always null — the function returned `true` before evaluating remaining dimensions after the first success.

---

### 6. jdk.ShenandoahTenuringThreshold

#### Verdict

**Propose.** Info-level source, clean 5-field design, no nullable fields, no multi-site emission complexity. Ready to file.

#### The question it answers

"What tenuring threshold did Shenandoah compute this cycle, and what are the min/max bounds in effect?"

Shenandoah generational uses a mortality-rate-based algorithm ([JEP 521](https://openjdk.org/jeps/521), production-ready JDK 25) to compute the tenuring threshold each young collection: it analyzes survival ratios across age cohorts, computes a weighted reciprocal, and clamps to `[ShenandoahGenerationalMinTenuringAge, ShenandoahGenerationalMaxTenuringAge]`. No existing JFR event exposes this per-cycle computed value.

#### Emission point

**Function**: `ShenandoahAgeCensus::update_tenuring_threshold()`  
[`shenandoahAgeCensus.cpp:258`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahAgeCensus.cpp#L258)  
Log: `log_info(gc, age)("New tenuring threshold %zu (min %zu, max %zu)", new_threshold, min, max)`  
Log tag: `log_info(gc,age)` — info level.

**Call chain**:
```
Shenandoah control thread (collection preparation phase)
  → ShenandoahGeneration::prepare_regions_and_collection_set()   [shenandoahGeneration.cpp:286](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahGeneration.cpp#L286)
    → ShenandoahAgeCensus::update_census()   [shenandoahAgeCensus.cpp:147](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahAgeCensus.cpp#L147)
      → update_tenuring_threshold()   [shenandoahAgeCensus.cpp:167→258](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahAgeCensus.cpp#L258)
```

Timing: after concurrent marking, before CSet finalization.

**Cadence**: Once per young collection.

**Thread**: Shenandoah control thread (within collection preparation phase, before evacuation).

**Algorithm**: `compute_tenuring_threshold()` uses mortality rate analysis — reciprocal of survival ratio across age cohorts, weighted by max-cohort-ratio; clamped to `[ShenandoahGenerationalMinTenuringAge, ShenandoahGenerationalMaxTenuringAge]`.

#### Fields

| Field | Source | Nullable? | Tuning use |
|---|---|---|---|
| `startTime` | Standard JFR | No | Correlate with `jdk.GarbageCollection` gcId |
| `gcId` | Correlates with jdk.GarbageCollection | No | Link tenuring threshold to the specific young collection |
| `tenuringThreshold` | New threshold (age in GC cycles) — from `compute_tenuring_threshold()` | No | Low value (e.g., 1–3) → objects promote quickly, putting pressure on old gen; high value (≥ `maxTenuringAge`) → objects linger in young gen, increasing young-gen pressure. Watch for threshold oscillation between extremes |
| `minTenuringAge` | `ShenandoahGenerationalMinTenuringAge` flag value | No | Context: threshold is always ≥ this. If `tenuringThreshold == minTenuringAge`, the algorithm wanted to promote more aggressively but was clamped |
| `maxTenuringAge` | `ShenandoahGenerationalMaxTenuringAge` flag value | No | Context: threshold is always ≤ this. If `tenuringThreshold == maxTenuringAge`, the algorithm found low mortality and would keep objects in young even longer |

Fields excluded from the proposal (present at `log_debug` sites): mortality rate per-cohort, dark matter fraction. These are too detailed and at the wrong log level.

#### What it is used for

Tenuring threshold controls when objects "graduate" from young to old generation. A mis-tuned threshold causes either:
- **Too-early promotion** (low threshold): young objects that are actually short-lived get promoted to old gen, growing the old gen unnecessarily and eventually triggering old-gen collections.
- **Too-late promotion** (high threshold): long-lived objects stay in young gen longer, surviving multiple young collections and consuming young-gen space.

Shenandoah computes this dynamically from mortality rates, so the threshold adapts to object lifetimes. Watching `tenuringThreshold` over time lets you verify the algorithm is stabilizing (steady state) vs. oscillating (possibly a bursty workload with varying object lifetimes). Consistently hitting `maxTenuringAge` suggests the app has very long-lived objects in young gen — consider raising `ShenandoahGenerationalMaxTenuringAge`.

#### Why existing events don't cover this
- `jdk.GarbageCollection`: records GC completion; no tenuring threshold field.
- No existing JFR event covers Shenandoah-specific tenuring threshold computation.

#### Open questions / upstream concerns

1. Should algorithm input fields (mortality rate, dark matter fraction) be included? Currently excluded because they are exposed only at `log_debug` level. Could be added in a follow-up that promotes those fields to `log_info`.
2. Is `gcId` the right correlation key, or should this event correlate by timestamp with `jdk.ShenandoahCollectionDecision`?

---

### 7. jdk.ZGCTenuringThreshold

#### Verdict

**Propose.** Info-level source, clean 4-field design, no nullable fields, single emission point. Ready to file. Do not merge with `jdk.ShenandoahTenuringThreshold` — different algorithm, different lifecycle position, different GC.

#### The question it answers

"What tenuring threshold did ZGC select this young collection — was it user-pinned, forced, or dynamically computed?"

`jdk.ZGCConfiguration` records the static `-XX:ZTenuringThreshold` flag value set at JVM startup. It does not record the per-cycle dynamic selection, which can differ from the static flag depending on the selection path. There is no existing JFR event for this.

#### Emission point

**Function**: `ZGenerationYoung::select_tenuring_threshold()`  
[`zGeneration.cpp:716`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zGeneration.cpp#L716)  
Log: `log_info(gc, reloc)("Using tenuring threshold: %d (%s)", _tenuring_threshold, reason)`  
Log tag: `log_info(gc,reloc)` — info level.

**Call chain**:
```
ZGC concurrent thread (relocation set selection)
  → ZGeneration::select_relocation_set()   [zGeneration.cpp:205](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zGeneration.cpp#L205)
    → (line 250) → select_tenuring_threshold()   [zGeneration.cpp:716](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zGeneration.cpp#L716)
```

Timing: after `selector.select()` produces liveness data, before `_relocation_set.install()`.

**Cadence**: Once per young ZGC collection.

**Thread**: ZGC concurrent thread.

#### Three selection paths

1. **"Promote All"**: `promote_all` flag is set; `_tenuring_threshold = 0`; all objects promoted to old gen.
2. **"ZTenuringThreshold"**: user-pinned via `-XX:ZTenuringThreshold=N`; static value, no computation.
3. **"Computed"**: dynamic — `young_life_decay_factor × young_log_residency`, clamped to `[1, min(last_populated_age+1, MaxTenuringThreshold)]`.

#### Fields

| Field | Source | Nullable? | Tuning use |
|---|---|---|---|
| `startTime` | Standard JFR | No | Correlate with `jdk.ZYoungGarbageCollection` gcId |
| `gcId` | Correlates with jdk.GarbageCollection | No | Link threshold to specific young collection |
| `tenuringThreshold` | Selected threshold — age in GC cycles before object is promoted | No | Same interpretation as Shenandoah: low = aggressive promotion, high = retention in young gen |
| `reason` | `"Promote All"` / `"ZTenuringThreshold"` / `"Computed"` | No | **Key discriminator**: `"Promote All"` means memory pressure forced all objects to old gen; `"ZTenuringThreshold"` means admin overrode with `-XX:ZTenuringThreshold=N`; `"Computed"` means the dynamic algorithm ran normally. If you frequently see `"Promote All"`, increase `-Xmx` or the young-gen size |

#### What it is used for

- **Baseline the computed threshold**: what is the typical threshold for your workload? Compare across deployments or load patterns.
- **Detect mode shifts**: `reason="Promote All"` is an emergency signal — ZGC decided to flush the young gen entirely because allocation pressure exceeded its model. This causes a spike in old-gen promotions.
- **Validate flag overrides**: if `-XX:ZTenuringThreshold` is set but `reason` shows `"Computed"`, the flag value was out of range; if `reason="ZTenuringThreshold"` on every collection, the flag is locking the threshold and the dynamic algorithm is not running.

#### Why existing events don't cover this

- `jdk.ZGCConfiguration`: records the static `-XX:ZTenuringThreshold` flag; not the per-cycle dynamic selection (which differs for `"Promote All"` and `"Computed"` paths).
- `jdk.ZYoungGarbageCollection`: records young collection completion; no tenuring threshold field.
- No existing JFR event covers ZGC's per-cycle tenuring threshold selection.

#### Why not merged with jdk.ShenandoahTenuringThreshold

Different algorithms (mortality rate analysis vs. life decay factor), different lifecycle positions (collection preparation phase vs. relocation-set selection), different GC subsystems with different field semantics. The structural mismatch outweighs the cosmetic similarity of both being "tenuring threshold" events. Merging would require either a common abstraction that fits neither well, or a confusing union of fields from both GC implementations.

#### Open questions / upstream concerns

1. Should `reason="Computed"` be supplemented with the 3 intermediate values (`lifeDecayFactor`, `youngLogResidency`, `allocatedGarbageRatio`)? Currently excluded because they are at `log_debug` level. Could be added in a follow-up.
2. Is `gcId` reliably set when `select_tenuring_threshold()` fires? The call is inside `select_relocation_set()`, which is a concurrent phase — the GC ID should be set at the start of the young collection.

---

### 8. jdk.ZNMethodRegistration

#### Verdict

**Propose with caveats.** Info-level source, single emission point. However, production motivation is weak. Before filing upstream, validate that nmethod table overhead is a real production concern (e.g., collect evidence from GraalVM or other large-codebase JVM deployments where nmethod counts are high).

#### The question it answers

"How many nmethods does ZGC have registered, and how many stale slots are accumulating between table rebuilds?"

Stale (`_nunregistered`) slots in the ZGC nmethod table indicate zombie entries that have been unregistered but not yet purged by a table rebuild. A high ratio of stale to registered nmethods can indicate that the table rebuild cadence is insufficient.

#### Emission point

**Function**: `ZStatNMethods::print()`  
[`zStat.cpp:1621`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zStat.cpp#L1621)  
Log: `log_info(gc, nmethod)("NMethods: %zu registered, %zu unregistered", ZNMethodTable::registered_nmethods(), ZNMethodTable::unregistered_nmethods())`  
Log tag: `log_info(gc,nmethod)` — info level.

**Call chain**:
```
ZGC concurrent thread (inside ZStatPhaseGeneration::register_end)
  → ZStatPhaseGeneration::register_end()   [zStat.cpp:711](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zStat.cpp#L711)
    → ZStatNMethods::print()   [zStat.cpp:730](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zStat.cpp#L730)
```

Fires at end of every ZGC generation collection (both young and old).

**Cadence**: Once per ZGC generation collection.

**Thread**: ZGC concurrent thread (inside `ZStatPhaseGeneration::register_end`).

#### Fields

| Field | Source | Nullable? |
|---|---|---|
| `startTime` | Standard JFR | No |
| `registeredNMethods` | `_nregistered` — current live count from `ZNMethodTable` | No |
| `staleNMethodSlots` | `_nunregistered` — zombie entries pending table rebuild; NOT cumulative | No |

**DROPPED field**: `tableRebuilt` — no per-cycle boolean exists in `ZStatNMethods::print()`. Adding this field would require new instrumentation in `ZNMethodTable` to record whether a rebuild occurred in the current cycle. That is a prerequisite change, not part of the base event.

#### Why existing events don't cover this

- No existing JFR event exposes nmethod registration counts for any GC.
- `jdk.CodeCacheStatistics`: covers the code cache globally; does not expose per-GC nmethod table state.

#### What it is used for

ZGC must scan all registered nmethods during each GC cycle to find object references in compiled code. A large or stale nmethod table adds scanning overhead to every collection. The `staleNMethodSlots` counter tracks zombie entries — nmethods that have been unregistered (deoptimized or evicted) but whose table slots have not yet been reclaimed by a rebuild.

A steadily growing `staleNMethodSlots / registeredNMethods` ratio suggests the table rebuild cadence is not keeping up with nmethod eviction rate. This is primarily a concern in environments with:
- Dynamic class loading/unloading (OSGi, JEE, microservices with hot class reloading)
- Large polyglot workloads using GraalVM where nmethod count is very high
- Short-lived lambda-heavy applications generating many single-use compiled methods

**Tuning actions**:
- If `staleNMethodSlots` grows unbounded between rebuilds, check JIT compilation activity via `jdk.Compilation` and whether JVM TI agents or the code cache are evicting compiled methods at high rate.
- High `registeredNMethods` (> 100K) in combination with long ZGC nmethod scanning phases → investigate code cache size and JIT tier thresholds.

#### Open questions / upstream concerns

1. **Weak production motivation**: Is nmethod table overhead a real problem that operators encounter? The event has low priority precisely because there is no documented evidence of nmethod table overhead causing production issues. Filing without motivation evidence may result in the patch being deprioritized.
2. Should the event fire for both young and old collections, or only old (where nmethod scanning is more expensive)?
3. The dropped `tableRebuilt` field: if upstream wants it, a prerequisite patch to `ZNMethodTable` is needed.

---

### 9. jdk.G1ConcurrentRefinementSweep

#### Verdict

**Propose with caveats.** The code is in the product build (not `#ifndef PRODUCT` guarded); the data is available. The `log_debug` source is a valid concern for upstream reviewers, but the argument is straightforward: refinement sweep metrics are essential for understanding [JEP 522](https://openjdk.org/jeps/522) (JDK 25 write barrier redesign) behavior in production, and they have never been accessible without enabling debug logging. JFR changes the access model, not the data.

#### The question it answers

"How fast is G1's concurrent card refinement running, and what is the pending-card backlog?"

G1's concurrent refinement thread processes dirty card queue entries between GC pauses. The throughput and backlog of this process directly affect pause time predictability. Under the JDK 25 write barrier redesign ([JEP 522](https://openjdk.org/jeps/522)), refinement behavior changed significantly. Without JFR coverage, operators must enable `-Xlog:gc+refine=debug` to observe refinement dynamics — an option rarely available in production.

#### Emission points

**Normal sweep completion**:  
`G1ConcurrentRefineSweepState::complete_refinement()`  
[`g1ConcurrentRefine.cpp:377`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1ConcurrentRefine.cpp#L377)

**Sweep interrupted at safepoint**:  
`G1ConcurrentRefineSweepState::handle_ongoing_refinement_at_safepoint()`  
[`g1ConcurrentRefine.cpp:340`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1ConcurrentRefine.cpp#L340)

Both call `print_refinement_stats()` at [`g1ConcurrentRefine.cpp:301`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1ConcurrentRefine.cpp#L301). **Exact log message**:
```
log_debug(gc, refine)("Refinement took %.2fms (pre-sweep %.2fms card refine %.2fms) "
    "(scanned %zu clean %zu (%.2f%%) not_clean %zu (%.2f%%) not_parsable %zu "
    "refers_to_cset %zu (%.2f%%) still_refers_to_cset %zu (%.2f%%) no_cross_region %zu pending %zu)",
    ...);
```
Log tag: `log_debug(gc,refine)` at both sites.

**Call chain**:
```
G1ConcurrentRefineThread control loop
  → sweep state machine
  → complete_refinement()   [g1ConcurrentRefine.cpp:377](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1ConcurrentRefine.cpp#L377)   (normal)
  → handle_ongoing_refinement_at_safepoint()   [g1ConcurrentRefine.cpp:340](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1ConcurrentRefine.cpp#L340)   (interrupted)
```

**Cadence**: Once per refinement sweep. Can fire multiple times between GC pauses (each sweep is one pass through the dirty-card queue).

**Thread**: G1 concurrent refinement thread (NOT the GC pause thread).

**NOT mergeable with G1ConcurrentRefinementPolicy**: different cadences (concurrent thread sweeps vs. per-GC-pause policy updates) and different threads.

#### Fields

| Field | Source | Nullable? | Tuning use |
|---|---|---|---|
| `startTime` | Standard JFR | No | Timing and frequency of sweeps between GC pauses |
| `duration` | Standard JFR | No | Total sweep wall time |
| `preSweepMs` | Time before actual card refinement begins (snapshot, bookkeeping) | No | High `preSweepMs` relative to `cardRefineMs` = overhead dominated by setup; suspect lock contention or large remembered set |
| `cardRefineMs` | `TimeHelper::counter_to_millis(stats->refine_duration())` — actual card refinement work | No | **Primary throughput metric** |
| `cardsScanned` | `stats->cards_scanned()` — total dirty cards examined | No | Volume indicator; divide by `cardRefineMs` for throughput in cards/ms |
| `cardsClean` | `stats->cards_clean()` — cards already clean when scanned (no work needed) | No | High ratio of clean/scanned means cards are being re-queued unnecessarily; can indicate write barrier overhead without actual dirtying |
| `cardsNotClean` | `stats->cards_not_clean()` — cards that required processing | No | The actual work done; `cardsNotClean / cardsScanned` = effective work ratio |
| `cardsNotParsable` | `stats->cards_not_parsable()` — cards in mid-transition regions (skip) | Consider dropping | Low production diagnostic value; regions in mid-transition are rare |
| `cardsNoCrossRegion` | `stats->cards_no_cross_region()` — cards filtered because reference is within same region | No | **Heap locality indicator**: high `cardsNoCrossRegion / cardsNotClean` = objects frequently reference their spatial neighbors — good locality reduces remembered-set pressure |
| `cardsRefersToCset` | `stats->cards_refer_to_cset()` — cards pointing to CSet at scan time | Consider dropping | Intermediate value; `cardsStillRefersToCset` is the actionable metric |
| `cardsStillRefersToCset` | `stats->cards_already_refer_to_cset()` — cards still pointing to CSet after refinement | No | Non-zero = cards that could not be processed because regions were already in CSet; high value may increase pause work |
| `cardsPending` | `stats->cards_pending()` — backlog remaining after sweep | No | **Backlog indicator**: growing `cardsPending` across sweeps means refinement is not keeping up with the write rate |

#### What it is used for

G1 concurrent refinement processes dirty card queue (DCQ) entries between GC pauses. If refinement cannot keep up, the backlog grows and must be processed during the next GC pause — extending pause time. After the [JEP 522](https://openjdk.org/jeps/522) write barrier redesign (JDK 25), the card-dirtying model changed; this event provides the first structured way to monitor refinement throughput in production without enabling debug logging.

**Key diagnosis**:
- `cardsPending` growing over time → refinement thread count is insufficient; increase `G1ConcurrentRefinementThreads` or check GC CPU overhead.
- `cardsClean / cardsScanned` > 50% → many cards are being scanned redundantly; may indicate write barrier generating redundant marks.
- `cardRefineMs` high relative to inter-GC interval → refinement consuming significant CPU; balance against application threads.
- `cardsStillRefersToCset` non-zero frequently → consider adjusting CSet selection to reduce the number of regions in CSet that have pending references.

#### Why existing events don't cover this

- `jdk.G1AdaptiveIHOP`, `jdk.G1BasicIHOP`: cover old-gen occupancy for marking trigger; nothing about refinement.
- `jdk.EvacuationInformation`: records evacuation outcome at pause time; not refinement throughput between pauses.
- No existing JFR event exposes G1 concurrent refinement sweep metrics.

#### Open questions / upstream concerns

1. **Debug-level source**: the primary question upstream will ask. The counter-argument: the `print_refinement_stats()` function is in the product build, the data IS available, and JFR is a production observability tool. The log-level is about `-Xlog` verbosity, not data availability.
2. Should `cardsNotParsable` and `cardsRefersToCset` be dropped to simplify the field set?
3. [JEP 522](https://openjdk.org/jeps/522) context: does upstream want a note in the JEP or JFR RFE linking this event to the JEP 522 observability gap?

---

### 10. jdk.G1ConcurrentRefinementPolicy

#### Verdict

**Propose with caveats.** Same debug-level caveat as `jdk.G1ConcurrentRefinementSweep`. Consider proposing both refinement events in the same RFE/PR since they are complementary.

#### The question it answers

"How many refinement threads does G1 want, and is the pending-card target being met?"

`G1ConcurrentRefinementSweep` captures per-sweep throughput; `G1ConcurrentRefinementPolicy` captures the adaptive policy that decides how many threads to run and whether the system is keeping up with the dirtied-card rate. Together they provide complete visibility into G1 concurrent refinement.

#### Emission points

**Per-GC-pause (log_debug)**:  
`G1Policy::record_young_collection_end()`  
[`g1Policy.cpp:803`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1Policy.cpp#L803)  
**Exact log message** (at [`g1Policy.cpp:1022`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1Policy.cpp#L1022)):
```
log_debug(gc, ergo, refine)("GC refinement: goal: %zu / %1.2fms, actual: %zu / %1.2fms, %s",
    cr->pending_cards_target(),
    pending_cards_time_goal_ms,
    pending_cards,
    pending_cards_time_ms,
    (exceeded_goal ? " (exceeded goal)" : ""));
```
Log tag: `log_debug(gc,ergo,refine)`. Fields available: `pendingCardsTarget`, `goalMs`, `pendingCards`, `pendingCardsTimeMs`, `exceededGoal`. Note: `threadsWanted` is **not** available at this site — only the periodic path has thread-count information.

**Periodic (log_debug)**:  
`G1ConcurrentRefine::adjust_threads_wanted()`  
[`g1ConcurrentRefine.cpp:598`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1ConcurrentRefine.cpp#L598)  
Called from `adjust_num_threads_periodically()`.  
**Exact log message** (from [`g1ConcurrentRefine.cpp:618`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1ConcurrentRefine.cpp#L618)):
```
log_debug(gc, refine)("Concurrent refinement: wanted %u, pending cards: %zu (pending-from-gc %zu), "
    "predicted: %zu, goal %zu, time-until-next-gc: %1.2fms pred-refine-rate %1.2fc/ms log-rate %1.2fc/ms",
    new_wanted, num_cards, pending_cards_from_gc,
    predicted_cards, _pending_cards_target, time_until_gc_ms,
    predict_concurrent_refine_rate_ms, predict_dirtied_cards_rate_ms);
```
Log tag: `log_debug(gc,refine)`.

**Call chain (GC-pause path)**:
```
GC pause thread
  → G1YoungCollector::post_evacuate_collection_set()
    → G1Policy::record_young_collection_end()   [g1Policy.cpp:803](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1Policy.cpp#L803)
```

**Call chain (periodic path)**:
```
G1 concurrent refinement control thread
  → G1ConcurrentRefine::adjust_num_threads_periodically()
    → adjust_threads_wanted()   [g1ConcurrentRefine.cpp:598](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1ConcurrentRefine.cpp#L598)
```

**Cadence**: Once per young GC pause (pause path) plus periodically between pauses (periodic path).

**Thread**: GC pause thread (first path); concurrent refinement control thread (second path).

#### Fields

| Field | Source | Nullable? | Tuning use |
|---|---|---|---|
| `startTime` | Standard JFR | No | Correlate with GC pause or periodic adjustment |
| `threadsWanted` | `new_wanted` from `adjust_threads_wanted()` — [`g1ConcurrentRefine.cpp:610`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1ConcurrentRefine.cpp#L610); **not available on GC-pause path** — null when emitted from `record_young_collection_end()` | Yes (null on GC-pause path) | **Primary output**: how many refinement threads the policy wants. If repeatedly at max → refinement is undersized |
| `pendingCards` | GC-pause: `pending_cards` from `record_young_collection_end()`; periodic: `policy->current_pending_cards()` from `adjust_threads_wanted()` | No | Current backlog; if growing between policy ticks, refinement is falling behind |
| `pendingCardsFromGC` | `pending_cards_from_gc()` — cards dirtied by GC itself (internal remembered-set updates); periodic path only | Yes (null on GC-pause path) | Distinguishes GC-generated card traffic from mutator write traffic; high `pendingCardsFromGC` relative to `pendingCards` = GC is contributing significantly to its own backlog |
| `pendingCardsTarget` | `_pending_cards_target` — policy's goal for pending card count | No | **Key tuning lever**: if `pendingCards` consistently exceeds `pendingCardsTarget`, the target may need to increase or thread count is constrained |
| `predictedPendingCards` | `_threads_needed.predicted_cards_at_next_gc()` — predicted pending at next GC; periodic path only | Consider dropping | Model estimate; useful for detecting if the policy predicts it will fall behind before next pause |
| `predictedRefineRate` | `analytics->predict_concurrent_refine_rate_ms()` — predicted cards/ms refinement throughput; periodic path only | Yes (null on GC-pause path) | The capacity side of the balance: throughput × time-until-gc ≈ expected cards refined |
| `dirtiedCardRate` | `analytics->predict_dirtied_cards_rate_ms()` — predicted cards/ms write rate from mutators; periodic path only | Yes (null on GC-pause path) | **Demand side**: if `dirtiedCardRate > predictedRefineRate × threadsWanted`, the policy will fall behind |
| `goalMs` | GC-pause: `pending_cards_time_goal_ms` (`_mmu_tracker->max_gc_time() × G1RSetUpdatingPauseTimePercent/100`); periodic: policy's refinement time window goal | No | Refinement is expected to clear backlog within this window |
| `pendingCardsTimeMs` | GC-pause: actual time to process pending cards in the last GC pause; periodic path: not available | Yes (null on periodic path) | Compares against `goalMs` — the GC-pause dimension of whether card processing met its goal |
| `timeUntilNextGC` | `_threads_needed.predicted_time_until_next_gc_ms()`; periodic path only | Yes (null on GC-pause path) | Time available for refinement before next GC pause; `timeUntilNextGC × predictedRefineRate × threadsWanted` ≈ expected clearance |
| `exceededGoal` | Boolean: sweep exceeded goal window; derivable as `pendingCards > pendingCardsTarget` or `pendingCardsTimeMs > goalMs` | No | `true` repeatedly → refinement cannot complete in time, increasing pause-time risk |

#### What it is used for

Complements `jdk.G1ConcurrentRefinementSweep`: where Sweep shows per-sweep throughput, Policy shows the adaptive thread-count decision. Together they answer: "Is G1 adjusting the right number of refinement threads, and is the pending-card target realistic for this workload?"

**Key patterns**:
- `threadsWanted` at maximum and `pendingCards > pendingCardsTarget` → more refinement capacity needed; consider `-XX:G1ConcRefinementThreads`.
- `dirtiedCardRate >> predictedRefineRate × threadsWanted` → write rate exceeds refinement capacity; expect pause-time spikes from residual card processing.
- `exceededGoal=true` frequently → refinement time window is too tight; check `-XX:G1RSetUpdatingPauseTimePercent` (controls what fraction of pause budget is allocated to processing pending cards, default 10%).

#### Why existing events don't cover this

- Same analysis as `jdk.G1ConcurrentRefinementSweep` — no existing JFR event covers G1 concurrent refinement policy or thread count adaptation.

#### Open questions / upstream concerns

1. Same debug-level question as `jdk.G1ConcurrentRefinementSweep`.
2. Should `predictedPendingCards` be dropped? It is a model estimate that may confuse rather than inform.
3. **Two emission points with different field shapes**: the GC-pause path (`record_young_collection_end()`) does not provide `threadsWanted`, `pendingCardsFromGC`, `predictedRefineRate`, or `dirtiedCardRate` — those are only available from the periodic `adjust_threads_wanted()` path. The simplest approach: emit the event only from the periodic path (where all fields are available), and accept that the GC-pause-aligned data is not captured. Alternatively, emit from the GC-pause path for `exceededGoal` and `pendingCardsTimeMs`, and from the periodic path for the rest, marking GC-path-only fields nullable when emitted periodically.

---

### 11. jdk.G1CollectionSetCandidates

#### Verdict

**Propose with caveats.** The debug-level source is the primary concern. The `stopReason` field requires synthesis from multiple stop-condition log lines, which upstream may push back on. Consider a simpler version without `stopReason` (or with `stopReason` as a string enum synthesized at a single call site).

#### The question it answers

"Why did G1 start or stop mixed GCs, and how many regions were available vs. selected?"

Mixed GC behavior is currently observable only via `-Xlog:gc+ergo+cset=debug`. The selection decision — how many regions were available, how many were selected, and whether the time budget or a region limit caused early termination — is invisible in JFR.

#### Emission points

**Marking candidates**:  
`G1CollectionSet::select_candidates_from_marking()`  
[`g1CollectionSet.cpp:414`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1CollectionSet.cpp#L414)

**Start log** ([`g1CollectionSet.cpp:435`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1CollectionSet.cpp#L435)):
```
log_debug(gc, ergo, cset)("Start adding marking candidates to collection set. "
    "Min %u regions, max %u regions, available %u regions (%u groups), ...");
```

**Finish log** ([`g1CollectionSet.cpp:521`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1CollectionSet.cpp#L521)):
```
log_debug(gc, ergo, cset)("Finish adding marking candidates to collection set. "
    "Initial: %u regions (%u groups), optional: %u regions (%u groups), "
    "predicted initial time: %1.2fms, predicted optional time: %1.2fms, time remaining: %1.2fms");
```

**Retained candidates**:  
`G1CollectionSet::select_candidates_from_retained()`  
[`g1CollectionSet.cpp:531`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1CollectionSet.cpp#L531)

**Start log** ([`g1CollectionSet.cpp:552`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1CollectionSet.cpp#L552)):
```
log_debug(gc, ergo, cset)("Start adding retained candidates to collection set. "
    "Min %u regions, available %u regions (%u groups), "
    "time remaining %1.2fms, optional remaining %1.2fms");
```

Log tag: `log_debug(gc,ergo,cset)` at all sites.

**Call chain**:
```
GC pause thread (during CSet finalization, before evacuation)
  → G1CollectionSet::finalize_initial_collection_set()   [g1CollectionSet.cpp:715](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1CollectionSet.cpp#L715)
    → G1CollectionSet::finalize_old_part()   [g1CollectionSet.cpp:377](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1CollectionSet.cpp#L377)
      → select_candidates_from_marking()   [g1CollectionSet.cpp:414](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1CollectionSet.cpp#L414)
      → select_candidates_from_retained()   [g1CollectionSet.cpp:531](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1CollectionSet.cpp#L531)
```

**Cadence**: Twice per mixed GC pause (once for Marking, once for Retained). Zero times during non-mixed pauses.

**Thread**: GC pause thread.

#### Fields

| Field | Source | Nullable? | Tuning use |
|---|---|---|---|
| `startTime` | Standard JFR | No | Correlate with mixed GC pause (`jdk.GarbageCollection`) |
| `candidateType` | `"Marking"` or `"Retained"` — two passes per mixed GC; marking candidates come from completed marking, retained from previous mixed GCs where optional regions were not evacuated | No | **Marking**: primary old-gen reclaim path. **Retained**: secondary path for optional regions deferred from prior pauses |
| `minRegions` | `min_old_cset_length` / `min_retained_old_cset_length` — minimum regions that will be added regardless of time budget | No | If `selectedRegions < minRegions`, time budget was exceeded but regions were added anyway (see `overBudgetRegions`) |
| `maxRegions` | `max_old_cset_length` — maximum regions the policy will add | No | If `availableRegions > maxRegions`, selection stopped at `maxRegions` despite having more candidates; tune `-XX:G1OldCSetRegionThresholdPercent` |
| `availableRegions` | Candidate regions count at selection start | No | How many old-gen regions the GC could potentially reclaim |
| `availableGroups` | Candidate groups (card-set groups) available | Consider dropping | Groups are an internal optimization structure; region count is more actionable |
| `selectedRegions` | Initial (`num_inital_regions`) + normal regions actually selected | No | Compare to `availableRegions`: low ratio means time budget or `maxRegions` was the binding constraint |
| `optionalRegions` | Optional regions selected (deferred to optional evacuation step) | No | Non-zero = time budget allowed for additional regions beyond the initial selection; these are attempted if time permits during evacuation |
| `overBudgetRegions` | Regions added despite `time_remaining_ms == 0` — forced because below `minRegions` | No | Non-zero = pause risk: GC is adding regions whose predicted time exceeds remaining budget to meet the minimum |
| `predictedInitialTimeMs` | Sum of predicted evacuation times for initial regions | No | Expected pause contribution from old-gen regions; compare to `jdk.GarbageCollection` duration |
| `predictedOptionalTimeMs` | Predicted time for optional regions | Consider dropping | Optional regions are only attempted if time allows; this is a planning estimate |
| `timeRemainingMs` | Remaining pause time budget at end of selection | No | `timeRemainingMs > 0` and candidates remaining → selection was bounded by `maxRegions` or exhaustion, not time |
| `stopReason` | Synthesis from `print_finish_message()` calls in [`g1CollectionSet.cpp`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1CollectionSet.cpp): `"Maximum number of regions reached"` / `"Region amount reached min"` / `"Predicted time too high"` / `"Marking candidates exhausted"` / `"Retained candidates exhausted"` | No | **Why selection stopped**: `"Predicted time too high"` = time-limited, not region-limited; `"Maximum number of regions reached"` = `maxRegions` cap hit; `"exhausted"` = all candidates consumed |

**DROPPED field**: `continueMixed` — from `G1Policy::decide_on_concurrent_start_pause()`, a different call site; cannot be safely attached to this event without reading state from a separate code location. If needed, file as a separate event or add to an existing `jdk.G1HeapSummary` extension.

#### What it is used for

Mixed GC is G1's mechanism for reclaiming old-gen space. If mixed GC is not selecting enough regions per pause, old-gen occupancy grows until Full GC is triggered. This event answers: "Is G1 selecting as many old-gen regions as it could, and what is stopping it from selecting more?"

**Key patterns**:
- `stopReason="Predicted time too high"` consistently → mixed GC is time-limited; increase `-XX:MaxGCPauseMillis` or reduce old-gen region garbage density.
- `stopReason="Maximum number of regions reached"` consistently with `availableRegions >> selectedRegions` → `G1OldCSetRegionThresholdPercent` is the bottleneck; consider increasing it.
- `overBudgetRegions > 0` frequently → the GC is forced to add over-budget regions to meet its minimum; pause times will exceed predictions. This often indicates old-gen backlog is accumulating — consider more frequent mixed GC via `G1MixedGCCountTarget`.
- `Retained` type appearing → some regions were deferred from prior mixed pauses as optional. If `optionalRegions` from Marking is always 0 but Retained events appear, the GC may be struggling to clear its backlog in one pass.

#### Why existing events don't cover this

- `jdk.EvacuationInformation`: records outcome (regions evacuated, bytes copied); not the selection decision.
- `jdk.G1AdaptiveIHOP` / `jdk.G1BasicIHOP`: cover old-gen occupancy threshold for marking trigger; not collection-set selection.
- `jdk.G1HeapSummary`: records heap sizes at GC boundaries; not mixed-GC region selection reasoning.

#### Open questions / upstream concerns

1. **Debug-level source**: same justification as for `jdk.G1ConcurrentRefinementSweep`.
2. **`stopReason` synthesis**: this field must be synthesized from multiple stop-condition checks in the selection loop. This requires logic at the emission site. Upstream may ask for a simpler enumeration or for the field to be omitted.
3. **Two emission points per mixed GC**: the event fires twice per mixed pause (Marking then Retained). Upstream may prefer a single event per pause with both passes represented. The two-event design allows independent analysis of each pass.
4. Should `availableGroups` and `predictedOptionalTimeMs` be dropped for simplicity?

---

### 12. jdk.G1HeapResize

#### Verdict

**Propose with caveats.** Debug-level source. Shrink-path-only nullable fields. Consider gating emission on `resizeBytes != 0` to avoid emitting events when nothing changed.

#### The question it answers

"Why did G1 expand or shrink its heap, and what CPU-usage metrics drove the decision?"

The size delta is computable from `jdk.G1HeapSummary` events before and after a GC pause. The drivers — short-term and long-term GC CPU usage percentages, thresholds, and the scale factor used for shrink calculations — are not available anywhere in JFR today.

#### Emission point

**Function**: `G1HeapSizingPolicy::young_collection_resize_amount()`  
[`g1HeapSizingPolicy.cpp:216`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1HeapSizingPolicy.cpp#L216)  
Three `log_resize()` calls at lines 302, 319, 337.  
Also: `young_collection_shrink_amount()` at [`g1HeapSizingPolicy.cpp:172`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1HeapSizingPolicy.cpp#L172).

**Exact log message** via `log_resize()` ([`g1HeapSizingPolicy.cpp:82`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1HeapSizingPolicy.cpp#L82)):
```
log_debug(gc, ergo, heap)("Heap resize: "
    "short term GC CPU usage %1.2f%% long term GC CPU usage %1.2f%% "
    "lower threshold %1.2f%% upper threshold %1.2f%% GC CPU usage target %1.2f%% "
    "at limit %s resize by %zuB expand %s",
    short_term_cpu_usage * 100.0, long_term_cpu_usage * 100.0,
    lower_threshold * 100.0, upper_threshold * 100.0,
    cpu_usage_target * 100.0, BOOL_TO_STR(at_limit),
    resize_bytes, BOOL_TO_STR(expand));
```
Log tag: `log_debug(gc,ergo,heap)` — `log_resize()` is debug level.

**Call chain**:
```
GC pause thread
  → G1CollectedHeap::resize_heap_after_young_collection()   [g1CollectedHeap.cpp:986](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1CollectedHeap.cpp#L986)
    → young_collection_resize_amount()   [g1HeapSizingPolicy.cpp:216](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1HeapSizingPolicy.cpp#L216)
```

Fires at end of every young GC pause.

**Cadence**: Once per young GC pause. NOTE: fires even when `resizeBytes == 0` (no resize occurred). Consider gating JFR emission on `resizeBytes != 0`.

**Thread**: GC pause thread.

#### Fields

| Field | Source | Nullable? | Tuning use |
|---|---|---|---|
| `startTime` | Standard JFR | No | Correlate with `jdk.GarbageCollection` |
| `shortTermGcCpuUsagePct` | `_analytics->short_term_gc_time_ratio() * 100` — primary driver for deviation counter; increments counter when above `upperThresholdPct`, decrements when below `lowerThresholdPct` | No | Compares against `upperThresholdPct` / `lowerThresholdPct` to determine resize direction; must exceed `G1CPUUsageExpandThreshold` (default 4) counts in a row to trigger expansion |
| `longTermGcCpuUsagePct` | `_analytics->long_term_gc_time_ratio() * 100` — checked every `long_term_count_limit()` pauses | No | Slow trend; expansion triggers when this exceeds `upperThresholdPct` at the long-term check interval |
| `deviationCounter` | `_gc_cpu_usage_deviation_counter` — positive → consecutive above-upper-threshold samples; negative → consecutive below-lower-threshold; reset to 0 after each resize | No | Threshold for expansion: counter > `G1CPUUsageExpandThreshold` (default 4); threshold for shrink: counter < -`G1CPUUsageShrinkThreshold` (default -8). Counter = 0 means heap is in tolerance band |
| `lowerThresholdPct` | `gc_cpu_usage_target * (1 - G1CPUUsageDeviationPercent/100)` where `gc_cpu_usage_target = 1/(1+GCTimeRatio)` (scaled by heap fill ratio) | No | Below this → shrink candidate |
| `upperThresholdPct` | `gc_cpu_usage_target * (1 + G1CPUUsageDeviationPercent/100)` | No | Above this → expand candidate |
| `gcCpuUsageTargetPct` | `1.0 / (1.0 + GCTimeRatio)` × heap-scale factor; steady-state desired GC CPU fraction | No | The target the policy is aiming for. Derivable from `GCTimeRatio` but heap-scaling makes it non-trivial |
| `expand` | `true`=expand, `false`=shrink | Yes (null if `resizeBytes=0`) | Direction of resize |
| `resizeBytes` | `young_collection_resize_amount()` return value; 0 = no resize triggered this pause | No | Size of resize in bytes; 0 on most pauses |
| `atLimit` | Boolean: heap already at min/max capacity, so resize was requested but not possible | No | `true` + `expand=true` means heap needs to grow but `-Xmx` is the ceiling — increase max heap |
| `scaleFactorPct` | From `young_collection_shrink_amount()` sigmoid scaling — accounts for how far GC CPU usage deviated | Yes (null on expansion path) | Higher scale factor → more aggressive shrink. Sigmoid-based: a 100% deviation doubles the scale |
| `freeRegions` | Free region count at shrink evaluation time | Yes (null on expansion path) | Used to compute safe shrink amount: shrink is bounded by available free regions |
| `regionsNeededForAlloc` | Regions needed for allocation headroom at shrink time | Yes (null on expansion path) | Safety floor: shrink never takes more than `freeRegions - regionsNeededForAlloc` |

#### What it is used for

G1 adjusts the committed heap between pauses based on GC CPU usage vs. a target derived from `GCTimeRatio`. The existing `jdk.G1HeapSummary` shows you the result (heap size before and after) but not **why** the resize happened or whether the policy's threshold was met. This event answers:

- Is G1 expanding/shrinking the heap in response to GC load, or is it at the limit?
- Is the `GCTimeRatio` flag configured to match your workload? If `shortTermGcCpuUsagePct` consistently exceeds `upperThresholdPct` but `atLimit=true`, the heap is constrained — raise `-Xmx`. If it consistently stays below `lowerThresholdPct`, the heap is oversized.
- Is the sigmoid scaling (`scaleFactorPct`) producing aggressive shrinks that cause repeated expand/shrink oscillation?

**Key diagnosis**: `resizeBytes=0` on every pause means `deviationCounter` has not crossed `G1CPUUsageExpandThreshold` (4) or `-G1CPUUsageShrinkThreshold` (-8). If `shortTermGcCpuUsagePct` oscillates around `upperThresholdPct` but `deviationCounter` never reaches 4, the thresholds are too high. If `deviationCounter` reaches the threshold but `resizeBytes=0`, then `atLimit=true` — the heap cannot expand further.

#### Why existing events don't cover this

- `jdk.G1AdaptiveIHOP`: covers old-gen occupancy threshold for marking, not heap capacity resize.
- `jdk.G1HeapSummary`: records heap sizes at GC; not the CPU-usage metrics that drove the resize decision.
- `jdk.GCHeapSummary`: same — sizes, not drivers.

#### Open questions / upstream concerns

1. **Debug-level source**: same argument as for refinement events.
2. **Shrink-path-only nullable fields**: `scaleFactorPct`, `freeRegions`, `regionsNeededForAlloc` are null on the expansion path. Upstream may want these separated into an expansion event and a shrink event.
3. **Fires on no-resize**: should the event be gated on `resizeBytes != 0`? An event that fires every young GC (even when nothing changed) adds noise. Gate on non-zero unless the "no resize and why not" information is itself valuable.
4. Should `gcCpuUsageTargetPct` be omitted since it is derivable from `GCTimeRatio` (available from `jdk.GCConfiguration`)?

---

### 13. jdk.ZDirectorRule

#### Verdict

**Redesign first.** The 22-field sparse design will receive immediate pushback. The per-tick summary with 6 fields is the right approach for the initial proposal. File the redesigned event, not the current design.

#### The question it answers

"Why did ZGC trigger (or not trigger) a collection this tick?"

`jdk.ZYoungGarbageCollection` and `jdk.ZOldGarbageCollection` fire after GC is chosen and record outcomes. Director decisions — especially ticks where no GC is triggered — produce no event at all today. An operator cannot distinguish "ZGC decided not to collect" from "ZGC was never evaluated" without debug logging.

#### Emission points

All rule functions in [`zDirector.cpp`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zDirector.cpp):
- [`rule_minor_timer`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zDirector.cpp#L84): `log_debug(gc, director)("Rule Minor: Timer, Interval: %.3fs, TimeUntilGC: %.3fs", ...)`
- [`rule_minor_allocation_rate_dynamic`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zDirector.cpp#L147): `log_debug(gc, director)("Rule Minor: Allocation Rate (Dynamic GC Workers), MaxAllocRate: %.1fMB/s (+/-%.1f%%), Free: %zuMB, ..., TimeUntilOOM: %.3fs, TimeUntilGC: %.3fs, ...", ...)`
- [`rule_minor_allocation_rate_static`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zDirector.cpp#L248): `log_debug(gc, director)("Rule Minor: Allocation Rate (Static GC Workers), MaxAllocRate: %.1fMB/s, Free: %zuMB, GCDuration: %.3fs, TimeUntilGC: %.3fs", ...)`
- [`rule_minor_high_usage`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zDirector.cpp#L365): `log_debug(gc, director)("Rule Minor: High Usage, Free: %zuMB(%.1f%%)", ...)`
- [`rule_major_timer`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zDirector.cpp#L385): `log_debug(gc, director)("Rule Major: Timer, Interval: %.3fs, TimeUntilGC: %.3fs", ...)`
- [`rule_major_warmup`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zDirector.cpp#L401): `log_debug(gc, director)("Rule Major: Warmup %.0f%%, Used: %zuMB, UsedThreshold: %zuMB", ...)`
- [`rule_major_proactive`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zDirector.cpp#L550): `log_debug(gc, director)("Rule Major: Proactive, AcceptableGCInterval: %.3fs, TimeSinceLastGC: %.3fs, TimeUntilGC: %.3fs", ...)`
- [`rule_major_allocation_rate`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zDirector.cpp#L470): `log_debug(gc, director)("Rule Major: Allocation Rate, ExtraYoungGCTime: %.3fs, OldGCTime: %.3fs, Lookahead: %u, ...", ...)`

**Call chain**:
```
ZGC director thread
  → director tick loop → start_gc()   [zDirector.cpp:820](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zDirector.cpp#L820)
    → make_major_gc_decision()   [zDirector.cpp:631](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zDirector.cpp#L631)
      → individual major rule functions
    → make_minor_gc_decision()   [zDirector.cpp:607](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zDirector.cpp#L607)
      → individual minor rule functions
```

**Early-exit**: `start_gc()` ([`zDirector.cpp:820`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zDirector.cpp#L820)) evaluates major first, then minor only if major did not trigger. If a major rule fires, minor rules are never evaluated. Within each direction, `make_minor/major_gc_decision` returns on the first triggered rule. So per tick: at most ONE rule fires total (either one major, or one minor — never both).

Log tag: `log_debug(gc,director)` — ALL rule log sites in `zDirector.cpp`. There is no `log_info` in the entire file.

**Cadence**: Every director tick (~1s default).

**Thread**: ZGC director thread.

#### Design concern with the current 22-field design

The proposed event has 22 fields. Each rule populates only 3–5 of them; most fields are null for most firings. This creates a pathologically sparse event that is hard to query and will receive upstream pushback.

#### Recommended redesign: per-tick summary event

Emit one event per director tick with ~6 fields. The `start_gc()` function at [`zDirector.cpp:820`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zDirector.cpp#L820) calls both `make_major_gc_decision()` (line 822) and `make_minor_gc_decision()` (line 828) and receives their `GCCause::Cause` return values — both results are available at a single point, making it a clean single-emission-point for the summary.

| Field | Source | Nullable? | Tuning use |
|---|---|---|---|
| `startTime` | Standard JFR | No | Tick frequency check |
| `triggeredMinorRule` | `GCCause::Cause` name from `make_minor_gc_decision()` return — null if `_no_gc` or if major triggered (major preempts minor evaluation entirely) | Yes | Which pressure caused the minor GC: `"_z_timer"` (periodic), `"_z_allocation_rate"` (memory pressure), `"_z_high_usage"` (heap nearly full) |
| `triggeredMajorRule` | `GCCause::Cause` name from `make_major_gc_decision()` return — null if `_no_gc`; evaluated first; if non-null, minor was never evaluated | Yes | `"_z_warmup"` (early startup), `"_z_proactive"` (idle cleanup), `"_z_allocation_rate"` (escalated from minor pressure), `"_z_timer"` |
| `timeUntilMinorOOM` | From alloc-rate rule (`rule_minor_allocation_rate_dynamic`): `time_until_oom` computed from allocation rate model | Yes | Seconds until OOM at current allocation rate; null if alloc-rate rule was not evaluated. Low value = imminent allocation failure |
| `minorFreeBytes` | Available young-gen bytes from alloc-rate/high-usage rules | Yes | Remaining headroom; compare against `ZAllocationSpikeTolerance` |
| `majorFreePercent` | Old-gen free fraction from high-usage/warmup rules | Yes | Overall heap headroom for old gen |

#### What it is used for

ZGC runs a director thread that evaluates rules every `~1/DecisionHz` seconds (default 1s) and decides whether to start a young or old collection. Unlike G1's reactive model, ZGC is proactively managed: it starts GC **before** allocation stalls by predicting time-until-OOM. Without this event, you have no visibility into ticks where the director evaluated rules but decided not to collect — leaving you unable to distinguish "no pressure" from "pressure but another GC was already running" from "timer not due yet."

**Key diagnostic patterns**:
- `triggeredMinorRule="_z_allocation_rate"` with decreasing `timeUntilMinorOOM` → increasing allocation pressure; if `timeUntilMinorOOM < typical_gc_duration`, allocation stalls are imminent.
- `triggeredMajorRule="_z_allocation_rate"` → allocation rate exceeded the young-gen capacity threshold; ZGC triggered a major collection directly (minor was not evaluated). This should be rare — frequent occurrence means the young gen is too small relative to allocation rate.
- All ticks showing both rules null (no GC triggered) → ZGC is idle; heap usage is low relative to capacity. Expected during low-load periods.
- `triggeredMajorRule="_z_warmup"` in steady state → warmup period was miscalibrated or the JVM restarted; this rule should only fire during initial heap fill.

#### Current 22-field design (full reference — not for upstream proposal as-is)

`rule`, `generation`, `interval`, `maxAllocRate`, `allocRateVariancePct`, `freeBytes`, `freePercent`, `timeUntilGC`, `timeUntilOOM`, `gcDuration`, `gcCPUTime`, `gcWorkers`, `usedBytes`, `usedThreshold`, `proactiveEnabled`, `acceptableGCInterval`, `timeSinceLastGC`, `usedUntilEnabled`, `timeUntilEnabled`, `extraYoungGCTime`, `oldGCTime`, `lookahead`, `extraYoungGCTimeForLookahead`.

#### Why existing events don't cover this

- `jdk.ZYoungGarbageCollection`: fires after GC is chosen; does not capture ticks where no GC triggered.
- `jdk.ZOldGarbageCollection`: same — outcome event, not trigger-decision event.
- `jdk.GarbageCollection` (base): same.
- No existing JFR event exposes ZGC director rule evaluation or non-triggering ticks.

#### Open questions / upstream concerns

1. **All-debug source**: `zDirector.cpp` has zero `log_info` sites. This is the hardest case to justify to upstream. The argument must be: "the director tick data is production-relevant, the current absence of any JFR signal for no-trigger ticks is an observability gap, and JFR's access model is independent of the log level."
2. Should the event fire on ticks where no GC is triggered (both `triggeredMinorRule` and `triggeredMajorRule` null)? If yes, the event fires every second even during idle periods. Consider filtering to ticks where at least one rule fired.
3. The per-tick summary design must be validated: does the information from individual rule functions flow up to a single place in `start_gc()` where all fields are available? The `start_gc()` function receives a `ZDirectorStats stats` argument — the individual rule functions also receive it. `timeUntilMinorOOM` and `minorFreeBytes` are local variables within `rule_minor_allocation_rate_dynamic()` and `rule_minor_high_usage()` respectively. They do NOT bubble up to `start_gc()`. A struct accumulation pattern is required: each rule would populate a `ZDirectorRuleResult` struct, which `make_minor_gc_decision()` / `make_major_gc_decision()` would return alongside the `GCCause::Cause` value. This is a non-trivial design change but is the correct approach.
4. Correction to "both rules null" filtering (question 2): note that `triggeredMajorRule` non-null means minor was **never evaluated** — so a "major triggered" event genuinely has both `triggeredMinorRule=null` (not evaluated) and `triggeredMajorRule=<cause>`. A consumer must not interpret `triggeredMinorRule=null` as "minor evaluated, nothing triggered" — only as "either minor evaluated and did not trigger, or minor was not evaluated because major triggered first." This distinction should be documented in the event schema description.

---

### 14. jdk.PSAdaptiveSizePolicy

#### Verdict

**Propose with caveats.** Debug-level source. Three source functions must be coordinated within one `PSScavenge::invoke()` call, which is implementable but adds complexity. The fields from `compute_old_gen_shrink_bytes()` and `compute_desired_sizes()` must be read and stored at their respective call sites and then emitted together.

#### The question it answers

"Why did Parallel GC resize eden, survivor, or old-gen this cycle?"

`jdk.PSHeapSummary` and `jdk.GCHeapSummary` carry the resulting sizes. They do not carry the throughput and pause goals, the promotion model estimates, or the old-gen shrink calculation inputs that drove the sizing decision. This information is entirely invisible in JFR today.

#### Emission points

**Primary (per young collection)**:  
`PSAdaptiveSizePolicy::print_stats()`  
[`psAdaptiveSizePolicy.cpp:63`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/psAdaptiveSizePolicy.cpp#L63)

**Exact log message**:
```
log_debug(gc, ergo)("Adaptive: throughput: %.3f, pause: %.1f ms, "
    "gc-distance: %.3f (%.3f) s, "
    "promoted: %.1f %s (%.1f %s), promotion-rate: %.1f M/s (%.1f M/s), overflowing: %s",
    mutator_time_percent(), minor_gc_time_estimate() * 1000.0,
    _gc_distance_seconds_seq.davg(), _gc_distance_seconds_seq.last(),
    ..., is_survivor_overflowing ? "true" : "false");
```

**Old gen shrink fields**:  
`PSAdaptiveSizePolicy::compute_old_gen_shrink_bytes()`  
[`psAdaptiveSizePolicy.cpp:165`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/psAdaptiveSizePolicy.cpp#L165)

**Exact log message** ([`psAdaptiveSizePolicy.cpp:182`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/psAdaptiveSizePolicy.cpp#L182)):
```
log_debug(gc, ergo)("Adaptive: old-gen free bytes: %.0f M, min-free-bytes: %.1f M, shrink-bytes: %zu K",
    old_gen_free_bytes / M, min_free_bytes / M, shrink_bytes / K);
```

**Eden/survivor desired sizes**:  
`PSYoungGen::compute_desired_sizes()`  
[`psYoungGen.cpp:367`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/psYoungGen.cpp#L367)

Log tag: `log_debug(gc,ergo)` — ALL sites are debug level.

**Call chain**:
```
GC pause thread (within PSScavenge::invoke)
  → PSScavenge::invoke()   [psScavenge.cpp:305](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/psScavenge.cpp#L305)
    → size_policy->print_stats(_survivor_overflow)   [psScavenge.cpp:431](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/psScavenge.cpp#L431)
    → (also within same invoke()) compute_old_gen_shrink_bytes()
    → (also within same invoke()) PSYoungGen::compute_desired_sizes()
```

**Cadence**: Once per young GC collection.

**Thread**: GC pause thread (within `PSScavenge::invoke`).

#### Fields

| Field | Source | Nullable? | Tuning use |
|---|---|---|---|
| `startTime` | Standard JFR | No | Correlate with `jdk.GarbageCollection` |
| `throughput` | `mutator_time_percent()` — `(total_time - gc_time) / total_time`, windowed average | No | **Primary goal metric**: below `1 - 1/(1+GCTimeRatio)` → algorithm will try to enlarge eden. Compare against `throughputGoal` implicit in `GCTimeRatio` |
| `minorPauseMs` | `minor_gc_time_estimate() * 1000` — smoothed minor GC time, minor only, does NOT include major | No | **Pause goal input**: if this exceeds `pauseGoalMs` → algorithm enters pause-reduction branch and shrinks eden |
| `pauseGoalMs` | `_gc_pause_goal_sec * 1000` from `MaxGCPauseMillis` (default 20ms) | No | The target pause time; `minorPauseMs > pauseGoalMs` drives eden shrink |
| `gcDistanceSec` | `_gc_distance_seconds_seq.davg()` — smoothed average inter-GC interval | No | **Frequency indicator**: short distance = high GC frequency. `gcDistanceSec / minorPauseMs` ≈ throughput fraction |
| `gcDistanceSecLast` | `_gc_distance_seconds_seq.last()` — raw last sample | No | Compare against `gcDistanceSec` to detect recent frequency change |
| `promotedBytesEstimate` | `_avg_promoted->padded_average()` — padded (conservative) smoothed promotion estimate | No | **Old-gen pressure predictor**: high value means objects are flowing to old gen; if sustained, old-gen collections become frequent |
| `promotedBytesLast` | `_promoted_bytes.last()` — actual bytes promoted last cycle | No | Compare against `promotedBytesEstimate`: a spike relative to estimate means a burst of promotions; smoothed value will lag |
| `survivorOverflow` | Boolean: survivor space was full, forcing premature promotion to old gen | No | `true` → objects that are still young were forced into old gen. Indicates survivor too small; increase `SurvivorRatio` or reduce `MaxTenuringThreshold` |
| `desiredEden` | Captured at `PSYoungGen::compute_desired_sizes()` — policy's desired eden size this cycle | No | Tracks policy evolution; compare to actual eden size from `jdk.PSHeapSummary` to see if heap size is constraining the policy |
| `desiredSurvivor` | Captured at `PSYoungGen::compute_desired_sizes()` | No | Same — desired survivor size |
| `throughputEdenIncrease` | Eden increase amount when taking the throughput-increase branch | Yes (null on pause-reduction branch) | Non-null means throughput was below goal and the policy is growing eden |
| `oldGenFree` | From `compute_old_gen_shrink_bytes()` — current old gen free bytes | No | How much headroom exists in old gen |
| `minFreeBytes` | 10× `_promotion_rate_bytes_per_sec` × minor GC time — lookahead floor for old gen | No | Old gen will not be shrunk below `minFreeBytes`; if `oldGenFree < minFreeBytes`, no shrink occurs |
| `shrinkBytes` | Old gen shrink amount; 0 if no shrink | No | Non-zero → policy is actively shrinking old gen; risk of promotion failure if promotion rate spikes |

**DROPPED fields**:
- `throughputGoal`: equals `1 - 1/(1+GCTimeRatio)` — derivable from `jdk.GCConfiguration.gcTimeRatio` without needing a new field.
- `promotionRateEstimate`, `promotionRateLast`: derivable as `promotedBytes / gcDistance` from existing fields.

#### What it is used for

Parallel GC's adaptive size policy implements a feedback control loop that resizes eden, survivor, and old gen each young collection to meet two competing goals: throughput (mutator time fraction) and pause time (`MaxGCPauseMillis`). Without this event, `jdk.PSHeapSummary` shows you the resulting sizes but not the reasoning — you cannot tell whether the policy is throughput-limited or pause-limited, or why the old gen is expanding.

**Diagnosis patterns**:
- `survivorOverflow=true` repeatedly → survivor is too small; objects are bypassing it and aging into old gen prematurely. Increase `-XX:SurvivorRatio` or `-XX:MaxTenuringThreshold`.
- `promotedBytesEstimate` growing monotonically → old-gen promotions are increasing; expect more frequent major GCs.
- `minorPauseMs > pauseGoalMs` and `desiredEden < currentEden` → policy is actively shrinking eden to reduce pause time; if throughput also degrades, `MaxGCPauseMillis` is set too low.
- `gcDistanceSec` very short (< 0.5s) → GC running more than twice per second; heap may be too small for workload.
- `shrinkBytes > 0` frequently → policy is repeatedly shrinking old gen; watch for `promotedBytesEstimate` spikes that could overflow the shrunk space.

#### Why existing events don't cover this

- `jdk.PSHeapSummary`: records resulting sizes (eden/survivor/old-gen capacities); not the sizing inputs.
- `jdk.GCHeapSummary`: same — resulting sizes only.
- `jdk.TenuringDistribution` (Parallel): records per-age-bucket counts; not the promotion rate model or the adaptive sizing decision.
- No existing JFR event covers `PSAdaptiveSizePolicy` decisions.

#### Open questions / upstream concerns

1. **Debug-level source**: all three emission points are `log_debug(gc,ergo)`. Same justification applies: the data is in the product build, and JFR provides production access without requiring debug log activation.
2. **Three-source coordination**: `desiredEden` and `desiredSurvivor` are from `PSYoungGen::compute_desired_sizes()`, which is a different call from `print_stats()`. The implementation must capture those values (e.g., store in a local struct) and emit them together. This is implementable within `PSScavenge::invoke()` but adds coordination complexity.
3. Should `throughputEdenIncrease` be dropped to eliminate the one nullable field? If the throughput-vs-pause-goal branching information is important, an alternative is to add a `sizingBranch` string field (`"throughput"` / `"pause"` / `"no_change"`) and drop the nullable branch-specific field.
4. Is `gcDistanceSec` vs `gcDistanceSecLast` both needed, or is the smoothed average sufficient?

---

## Appendix: Source File Reference

All source links use `https://github.com/openjdk/jdk/blob/master/` as base. Line numbers are approximate for functions that span ranges; exact lines are given where a specific log statement or code point is the anchor.

| Event | Primary source file |
|---|---|
| jdk.NativeHeapTrim | [`src/hotspot/share/runtime/trimNativeHeap.cpp`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/runtime/trimNativeHeap.cpp) |
| jdk.GCOverheadLimitExceeded | [`src/hotspot/share/gc/g1/g1CollectedHeap.cpp`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1CollectedHeap.cpp), [`src/hotspot/share/gc/parallel/parallelScavengeHeap.cpp`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/parallelScavengeHeap.cpp) |
| jdk.ShenandoahMMU | [`src/hotspot/share/gc/shenandoah/shenandoahMmuTracker.cpp`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahMmuTracker.cpp) |
| jdk.ShenandoahCollectionDecision | [`src/hotspot/share/gc/shenandoah/shenandoahGenerationalControlThread.cpp`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahGenerationalControlThread.cpp), [`src/hotspot/share/gc/shenandoah/heuristics/shenandoahHeuristics.cpp`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/heuristics/shenandoahHeuristics.cpp) |
| jdk.ShenandoahReclaimProgress | [`src/hotspot/share/gc/shenandoah/shenandoahMetrics.cpp`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahMetrics.cpp) |
| jdk.ShenandoahTenuringThreshold | [`src/hotspot/share/gc/shenandoah/shenandoahAgeCensus.cpp`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahAgeCensus.cpp) |
| jdk.ZGCTenuringThreshold | [`src/hotspot/share/gc/z/zGeneration.cpp`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zGeneration.cpp) |
| jdk.ZNMethodRegistration | [`src/hotspot/share/gc/z/zStat.cpp`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zStat.cpp) |
| jdk.G1ConcurrentRefinementSweep | [`src/hotspot/share/gc/g1/g1ConcurrentRefine.cpp`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1ConcurrentRefine.cpp) |
| jdk.G1ConcurrentRefinementPolicy | [`src/hotspot/share/gc/g1/g1Policy.cpp`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1Policy.cpp), [`src/hotspot/share/gc/g1/g1ConcurrentRefine.cpp`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1ConcurrentRefine.cpp) |
| jdk.G1CollectionSetCandidates | [`src/hotspot/share/gc/g1/g1CollectionSet.cpp`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1CollectionSet.cpp) |
| jdk.G1HeapResize | [`src/hotspot/share/gc/g1/g1HeapSizingPolicy.cpp`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1HeapSizingPolicy.cpp) |
| jdk.ZDirectorRule | [`src/hotspot/share/gc/z/zDirector.cpp`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zDirector.cpp) |
| jdk.PSAdaptiveSizePolicy | [`src/hotspot/share/gc/parallel/psAdaptiveSizePolicy.cpp`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/psAdaptiveSizePolicy.cpp), [`src/hotspot/share/gc/parallel/psYoungGen.cpp`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/psYoungGen.cpp) |
| jdk.StringDeduplicationStatistics (removed) | [`src/hotspot/share/gc/shared/stringdedup/stringDedupStat.cpp`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shared/stringdedup/stringDedupStat.cpp) |
| jdk.ShenandoahCardStatistics (blocked) | [`src/hotspot/share/gc/shenandoah/shenandoahCardStats.cpp`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahCardStats.cpp) |
