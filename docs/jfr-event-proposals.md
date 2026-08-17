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

**Call chain**:
```
NativeHeapTrimmer background thread
  → wakes up every TrimNativeHeapInterval ms (default 1000ms on container JVMs)
  → execute_trim_and_log()   [trimNativeHeap.cpp:150]
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
Log: `log_info(gc)("GC Overhead Limit exceeded too often (%zu).")`

**Parallel GC**: `ParallelScavengeHeap::satisfy_failed_allocation()`  
[`parallelScavengeHeap.cpp:507`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/parallelScavengeHeap.cpp#L507)  
Log: same string, same log tag.

**Call chain (G1)**:
```
Allocating application thread
  → allocation fast-path failure
  → attempt_allocation_humongous() or expand_heap_and_attempt_allocation()
  → satisfy_failed_allocation()   [g1CollectedHeap.cpp:1110]
  → fires when gc_overhead_limit_exceeded() returns true
```

**Cadence**: Once per OOM throw. At most once per JVM lifetime unless `-XX:-ExitOnOutOfMemoryError` is set, in which case the JVM exits on the first occurrence.

**Thread**: Allocating application thread (not a GC thread).

**GCOverheadLimit feature**: Implemented in G1 via JDK-8212084, [PR #27950](https://github.com/openjdk/jdk/pull/27950), merged JDK 26. Also present in Parallel GC.

#### Fields

| Field | Source | G1 | Parallel | Nullable? |
|---|---|---|---|---|
| `startTime` | Standard JFR | Yes | Yes | No |
| `gcId` | `GCId::peek()` — last completed GC id, approximate | Yes | Yes | No |
| `collector` | String literal: `"G1"` or `"Parallel"` | Yes | Yes | No |
| `gcTimePercent` | G1: `long_term_gc_time_ratio*100`; Parallel: `100-mutator_time_percent` | Yes | Yes | No |
| `freeSpacePercent` | G1: free regions as percent of total | Yes | No | Yes (null for Parallel) |
| `freeSpaceYoungPercent` | Parallel only | No | Yes | Yes (null for G1) |
| `freeSpaceOldPercent` | Parallel only | No | Yes | Yes (null for G1) |
| `consecutiveViolations` | `_gc_overhead_counter`; always equals `GCOverheadLimitThreshold` (default 5) at throw time | Yes | Yes | No |

#### Why existing events don't cover this

- `jdk.OutOfMemoryError` (hypothetical): fires at the Java exception propagation level, not at the GC decision point. The GC state fields (`gcTimePercent`, `freeSpacePercent`) are not accessible from the Java level.
- `jdk.GCHeapSummary`, `jdk.G1HeapSummary`, `jdk.PSHeapSummary`: record heap sizes at GC events, not at the allocation failure → OOM decision moment.
- No existing JFR event captures the GC overhead limit violation counter or the decision to throw.

#### Open questions / upstream concerns

1. G1 and Parallel have different free-space field shapes. The nullable pattern is acceptable in JFR but upstream may want two separate events (`jdk.G1GCOverheadLimitExceeded`, `jdk.ParallelGCOverheadLimitExceeded`) to avoid the impedance mismatch. The trade-off: separate events are cleaner but require more boilerplate.
2. `gcId` uses `GCId::peek()` which returns the last completed GC id, not the current allocation cycle. Is "approximate" acceptable in the field description, or should this be omitted?
3. `consecutiveViolations` is always equal to `GCOverheadLimitThreshold` at throw time (the counter must reach the threshold to throw). Is this field useful, or is it a constant disguised as a variable?

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
Log tag: `log_info(gc,ergo)` — info level.

**Old marking increment (log_info)**:  
`ShenandoahMmuTracker::record_old_marking_increment()`  
[`shenandoahMmuTracker.cpp:134`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahMmuTracker.cpp#L134)  
Log tag: `log_info(gc,ergo)` — info level.

**Periodic sample (log_debug — secondary, NOT in initial proposal)**:  
`ShenandoahMmuTracker::report()`  
[`shenandoahMmuTracker.cpp:173`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahMmuTracker.cpp#L173)  
Log tag: `log_debug(gc)` — debug level. This path should NOT be bundled with the initial proposal.

**Call chain (end-of-cycle)**:
```
Shenandoah generational control thread
  → end of collection phase
  → update_utilization()   [shenandoahMmuTracker.cpp:107]
```

**Call chain (periodic, debug-tier)**:
```
ShenandoahMmuTask::task()   [PeriodicTask at GCPauseIntervalMillis ~200ms]
  → report()   [shenandoahMmuTracker.cpp:173]
```

**Cadence**: Once per completed GC phase (end-of-cycle). Plus every ~200ms for the periodic path (excluded from initial proposal).

**Thread**: Generational control thread (end-of-cycle); dedicated timer thread (periodic).

#### Fields

| Field | Source | Nullable? |
|---|---|---|
| `startTime` | Standard JFR | No |
| `gcId` | `_most_recent_gcid` | No |
| `phase` | `"Concurrent Young GC"`, `"Concurrent Global GC"`, `"Concurrent Bootstrap GC"`, `"Mixed Concurrent GC"`, `"Full GC"`, `"Degenerated GC"` | Yes (null for periodic path if included later) |
| `gcuPercent` | GC utilization 0–100 | No |
| `muPercent` | Mutator utilization 0–100 | No |
| `periodSeconds` | Measurement window duration | No |
| `isPeriodicSample` | `true` when emitted from periodic reporter | No |

For the initial proposal, `isPeriodicSample` is always `false` and `phase` is never null. These fields anticipate the periodic path being added in a follow-up.

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
Log: `log_info(gc,ergo)("Start GC cycle (%s)")`

**Trigger fields (log_info)**:  
`ShenandoahHeuristics::log_trigger()`  
[`shenandoahHeuristics.cpp:248`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/heuristics/shenandoahHeuristics.cpp#L248)  
Resolves to `log_info(gc)` in production.

**Old immediate garbage (log_info)**:  
`ShenandoahOldHeuristics::prepare_for_old_collections()`  
[`shenandoahOldHeuristics.cpp:569`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahOldHeuristics.cpp#L569)  
Log tag: `log_info(gc,ergo)`.

**Annotated log_debug entries (NOT primary anchors)**:  
`shenandoahRegulatorThread.cpp:75,78,82,88` — `log_debug(gc)` — "Heuristics request for young collection accepted" etc. These are informational and NOT part of the event emission.

**Call chain (primary)**:
```
Shenandoah generational control thread main loop
  → service_concurrent_normal_cycle()   [shenandoahGenerationalControlThread.cpp:374]
  → fires at GC cycle start
Trigger fields from: regulator thread → heuristic should_start_gc() calls
                     → log_trigger() → [shenandoahHeuristics.cpp:248]
```

**Cadence**: Once per GC cycle start.

**Thread**: Shenandoah generational control thread (primary); regulator thread (trigger fields).

#### Fields

**Base fields** (always present):

| Field | Source | Nullable? |
|---|---|---|
| `startTime` | Standard JFR | No |
| `decision` | Synthesized from GCMode enum: `"young"`, `"old"`, `"global"`, `"mixed"`, `"degenerated"`, `"full"`, `"interrupt_old_for_young"`, `"none"` | No |
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

#### Open questions / upstream concerns

1. **Multi-site emission**: This event spans `service_concurrent_normal_cycle()` (control thread), `log_trigger()` (regulator thread), and `prepare_for_old_collections()` (old heuristics). Upstream will ask for a single emission point. The standard approach is to accumulate fields into a struct that is populated across the call chain and emitted at the control thread site. This is implementable but requires design work.
2. **Trigger field separation**: The 6+ nullable adaptive trigger fields are a natural candidate for a separate `jdk.ShenandoahGCTrigger` event. Separating them makes each event simpler and avoids the sparse-field problem.
3. **`decision` synthesis**: The `decision` string is not a single enum value from one place — it is synthesized from the GCMode enum at `shenandoahGenerationalControlThread.hpp`. The synthesis logic must be specified precisely in the patch.

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

**Call chain**:
```
GC STW thread
  → ShenandoahDegenGC::op_final_roots()   [shenandoahDegeneratedGC.cpp:330]
    → is_good_progress()   [shenandoahMetrics.cpp:47]
  → ShenandoahFullGC::op_gc()   [shenandoahFullGC.cpp:119]
    → is_good_progress()   [shenandoahMetrics.cpp:47]
```

**Cadence**: Once per degenerated or full GC ONLY. Does NOT fire after normal concurrent cycles.

**Thread**: GC STW thread.

**Early-exit semantics**: The function returns on the FIRST dimension that passes. If free space is sufficient, the function returns early without evaluating used-space, internal-frag, or external-frag. This means not all four dimensions are always evaluated.

#### Fields

**Simplified version (recommended for upstream)**:

| Field | Source | Nullable? |
|---|---|---|
| `startTime` | Standard JFR | No |
| `freePercent` | `freeActual/capacity` | No |
| `goodProgress` | Boolean result of `is_good_progress()` | No |
| `failedDimension` | `"free_space"` / `"used_space"` / `"internal_frag"` / `"external_frag"` / `null` if passed | Yes |
| `badProgressCount` | `_consecutive_degenerated_gcs_without_progress` from `ShenandoahCollectorPolicy`; reaching `CONSECUTIVE_BAD_DEGEN_PROGRESS_THRESHOLD` (= 2) triggers Full GC escalation | No |

**Full version (12 fields — for reference, not for initial proposal)**:

| Field | Source | Nullable? |
|---|---|---|
| `startTime`, `freePassed`, `goodProgress` | Always present | No |
| `freeActual`, `freeNeeded` | Always present | No |
| `usedFreed`, `usedNeededToFree`, `usedPassed` | Null if free check failed first | Yes |
| `internalFragDeltaPct`, `internalFragThresholdPct`, `internalFragPassed` | Null if earlier dimension failed | Yes |
| `externalFragDeltaPct`, `externalFragThresholdPct`, `externalFragPassed` | Null if earlier dimension failed | Yes |

#### Why existing events don't cover this

- `jdk.ShenandoahCollectionDecision` (proposed): fires at the START of a cycle; `ReclaimProgress` fires at the END of a degenerated/full GC. They are not mergeable.
- `jdk.GarbageCollection`: records GC completion; does not expose the progress assessment or the escalation counter.
- No existing JFR event exposes `_consecutive_degenerated_gcs_without_progress`.

#### Open questions / upstream concerns

1. The 12-field version with cascading nullability will receive pushback. The simplified 4-field version is the right starting point.
2. `badProgressCount` at value 2 means "Full GC will be triggered next" — this is the most actionable field. If only one field could be included, it would be this one.
3. Should the event also fire after a successful `is_good_progress()` call (when `goodProgress=true`)? Yes — the event is equally useful for confirming that a degenerated GC was sufficient.

---

### 6. jdk.ShenandoahTenuringThreshold

#### Verdict

**Propose.** Info-level source, clean 5-field design, no nullable fields, no multi-site emission complexity. Ready to file.

#### The question it answers

"What tenuring threshold did Shenandoah compute this cycle, and what are the min/max bounds in effect?"

Shenandoah generational uses a mortality-rate-based algorithm to compute the tenuring threshold each young collection: it analyzes survival ratios across age cohorts, computes a weighted reciprocal, and clamps to `[ShenandoahGenerationalMinTenuringAge, ShenandoahGenerationalMaxTenuringAge]`. No existing JFR event exposes this per-cycle computed value.

#### Emission point

**Function**: `ShenandoahAgeCensus::update_tenuring_threshold()`  
[`shenandoahAgeCensus.cpp:258`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahAgeCensus.cpp#L258)  
Log tag: `log_info(gc,age)` — info level.

**Call chain**:
```
Shenandoah control thread (collection preparation phase)
  → ShenandoahGeneration::prepare_regions_and_collection_set()   [shenandoahGeneration.cpp:286]
    → ShenandoahAgeCensus::update_census()   [shenandoahAgeCensus.cpp:147]
      → update_tenuring_threshold()   [shenandoahAgeCensus.cpp:167→258]
```

Timing: after concurrent marking, before CSet finalization.

**Cadence**: Once per young collection.

**Thread**: Shenandoah control thread (within collection preparation phase, before evacuation).

**Algorithm**: `compute_tenuring_threshold()` uses mortality rate analysis — reciprocal of survival ratio across age cohorts, weighted by max-cohort-ratio; clamped to `[ShenandoahGenerationalMinTenuringAge, ShenandoahGenerationalMaxTenuringAge]`.

#### Fields

| Field | Source | Nullable? |
|---|---|---|
| `startTime` | Standard JFR | No |
| `gcId` | Correlates with jdk.GarbageCollection | No |
| `tenuringThreshold` | New threshold (age in GC cycles) | No |
| `minTenuringAge` | `ShenandoahGenerationalMinTenuringAge` flag value | No |
| `maxTenuringAge` | `ShenandoahGenerationalMaxTenuringAge` flag value | No |

Fields excluded from the proposal (present at `log_debug` sites): mortality rate per-cohort, dark matter fraction. These are too detailed and at the wrong log level.

#### Why existing events don't cover this

- `jdk.TenuringDistribution`: covers G1/Parallel per-age-bucket sizes; not applicable to ZGC or Shenandoah; does not expose the computed threshold value itself.
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
Log tag: `log_info(gc,reloc)` — info level.

**Call chain**:
```
ZGC concurrent thread (relocation set selection)
  → ZGeneration::select_relocation_set()   [zGeneration.cpp:205]
    → (line 250) → select_tenuring_threshold()   [zGeneration.cpp:716]
```

Timing: after `selector.select()` produces liveness data, before `_relocation_set.install()`.

**Cadence**: Once per young ZGC collection.

**Thread**: ZGC concurrent thread.

#### Three selection paths

1. **"Promote All"**: `promote_all` flag is set; `_tenuring_threshold = 0`; all objects promoted to old gen.
2. **"ZTenuringThreshold"**: user-pinned via `-XX:ZTenuringThreshold=N`; static value, no computation.
3. **"Computed"**: dynamic — `young_life_decay_factor × young_log_residency`, clamped to `[1, min(last_populated_age+1, MaxTenuringThreshold)]`.

#### Fields

| Field | Source | Nullable? |
|---|---|---|
| `startTime` | Standard JFR | No |
| `gcId` | Correlates with jdk.GarbageCollection | No |
| `tenuringThreshold` | Selected threshold | No |
| `reason` | `"Promote All"` / `"ZTenuringThreshold"` / `"Computed"` | No |

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
Log tag: `log_info(gc,nmethod)` — info level.

**Call chain**:
```
ZGC concurrent thread (inside ZStatPhaseGeneration::register_end)
  → ZStatPhaseGeneration::register_end()   [zStat.cpp:711]
    → ZStatNMethods::print()   [zStat.cpp:730]
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

#### Open questions / upstream concerns

1. **Weak production motivation**: Is nmethod table overhead a real problem that operators encounter? The event has low priority precisely because there is no documented evidence of nmethod table overhead causing production issues. Filing without motivation evidence may result in the patch being deprioritized.
2. Should the event fire for both young and old collections, or only old (where nmethod scanning is more expensive)?
3. The dropped `tableRebuilt` field: if upstream wants it, a prerequisite patch to `ZNMethodTable` is needed.

---

### 9. jdk.G1ConcurrentRefinementSweep

#### Verdict

**Propose with caveats.** The code is in the product build (not `#ifndef PRODUCT` guarded); the data is available. The `log_debug` source is a valid concern for upstream reviewers, but the argument is straightforward: refinement sweep metrics are essential for understanding JEP 522 (JDK 25 write barrier redesign) behavior in production, and they have never been accessible without enabling debug logging. JFR changes the access model, not the data.

#### The question it answers

"How fast is G1's concurrent card refinement running, and what is the pending-card backlog?"

G1's concurrent refinement thread processes dirty card queue entries between GC pauses. The throughput and backlog of this process directly affect pause time predictability. Under the JDK 25 write barrier redesign (JEP 522), refinement behavior changed significantly. Without JFR coverage, operators must enable `-Xlog:gc+refine=debug` to observe refinement dynamics — an option rarely available in production.

#### Emission points

**Normal sweep completion**:  
`G1ConcurrentRefineSweepState::complete_refinement()`  
[`g1ConcurrentRefine.cpp:377`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1ConcurrentRefine.cpp#L377)

**Sweep interrupted at safepoint**:  
`G1ConcurrentRefineSweepState::handle_ongoing_refinement_at_safepoint()`  
[`g1ConcurrentRefine.cpp:340`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1ConcurrentRefine.cpp#L340)

Log tag: `log_debug(gc,refine)` at both sites.

**Call chain**:
```
G1ConcurrentRefineThread control loop
  → sweep state machine
  → complete_refinement()   [g1ConcurrentRefine.cpp:377]   (normal)
  → handle_ongoing_refinement_at_safepoint()   [g1ConcurrentRefine.cpp:340]   (interrupted)
```

**Cadence**: Once per refinement sweep. Can fire multiple times between GC pauses (each sweep is one pass through the dirty-card queue).

**Thread**: G1 concurrent refinement thread (NOT the GC pause thread).

**NOT mergeable with G1ConcurrentRefinementPolicy**: different cadences (concurrent thread sweeps vs. per-GC-pause policy updates) and different threads.

#### Fields

| Field | Source | Nullable? |
|---|---|---|
| `startTime` | Standard JFR | No |
| `duration` | Standard JFR | No |
| `preSweepMs` | Pre-sweep duration | No |
| `cardRefineMs` | Card refinement duration | No |
| `cardsScanned` | Total cards scanned | No |
| `cardsClean` | Already-clean cards (no work needed) | No |
| `cardsNotClean` | Cards with dirty state to process | No |
| `cardsNotParsable` | Cards in mid-transition regions | Consider dropping — low production value |
| `cardsNoCrossRegion` | Cards filtered for within-region references; high value = good heap locality | No |
| `cardsRefersToCset` | Cards pointing to collection set at scan time | Consider dropping (see below) |
| `cardsStillRefersToCset` | Cards still pointing to CSet after refinement; delta vs. `cardsRefersToCset` = CSet churn | No |
| `cardsPending` | Backlog remaining after sweep | No |

Consider dropping `cardsRefersToCset` and keeping only `cardsStillRefersToCset` — the delta is derivable from the two fields, but the raw "still pointing" count is the actionable metric.

#### Why existing events don't cover this

- `jdk.G1AdaptiveIHOP`, `jdk.G1BasicIHOP`: cover old-gen occupancy for marking trigger; nothing about refinement.
- `jdk.EvacuationInformation`: records evacuation outcome at pause time; not refinement throughput between pauses.
- No existing JFR event exposes G1 concurrent refinement sweep metrics.

#### Open questions / upstream concerns

1. **Debug-level source**: the primary question upstream will ask. The counter-argument: the `print_refinement_stats()` function is in the product build, the data IS available, and JFR is a production observability tool. The log-level is about `-Xlog` verbosity, not data availability.
2. Should `cardsNotParsable` and `cardsRefersToCset` be dropped to simplify the field set?
3. JEP 522 context: does upstream want a note in the JEP or JFR RFE linking this event to the JEP 522 observability gap?

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
Log tag: `log_debug(gc,ergo,refine)`.

**Periodic (log_debug)**:  
`G1ConcurrentRefine::adjust_threads_wanted()`  
[`g1ConcurrentRefine.cpp:598`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1ConcurrentRefine.cpp#L598)  
Called from `adjust_num_threads_periodically()`.  
Log tag: `log_debug(gc,refine)`.

**Call chain (GC-pause path)**:
```
GC pause thread
  → G1YoungCollector::post_evacuate_collection_set()
    → G1Policy::record_young_collection_end()   [g1Policy.cpp:803]
```

**Call chain (periodic path)**:
```
G1 concurrent refinement control thread
  → G1ConcurrentRefine::adjust_num_threads_periodically()
    → adjust_threads_wanted()   [g1ConcurrentRefine.cpp:598]
```

**Cadence**: Once per young GC pause (pause path) plus periodically between pauses (periodic path).

**Thread**: GC pause thread (first path); concurrent refinement control thread (second path).

#### Fields

| Field | Source | Nullable? |
|---|---|---|
| `startTime` | Standard JFR | No |
| `threadsWanted` | `new_wanted` from `adjust_threads_wanted()` | No |
| `pendingCards` | Actual pending at pause time | No |
| `pendingCardsFromGC` | Pending due to GC activity | No |
| `pendingCardsTarget` | Policy goal (primary adaptive sizing lever) | No |
| `predictedPendingCards` | Predicted pending at next GC | Consider dropping |
| `predictedRefineRate` | Predicted refinement rate in cards/ms | No |
| `dirtiedCardRate` | Dirtied card rate in cards/ms (demand side) | No |
| `goalMs` | Refinement time goal window | No |
| `timeUntilNextGC` | Estimated time until next GC in ms | No |
| `exceededGoal` | Boolean: sweep exceeded goal window | No |

#### Why existing events don't cover this

- Same analysis as `jdk.G1ConcurrentRefinementSweep` — no existing JFR event covers G1 concurrent refinement policy or thread count adaptation.

#### Open questions / upstream concerns

1. Same debug-level question as `jdk.G1ConcurrentRefinementSweep`.
2. Should `predictedPendingCards` be dropped? It is a model estimate that may confuse rather than inform.
3. Two emission points from two threads: upstream may prefer a single emission point. The GC-pause path is the cleaner one; the periodic path adds thread-count adjustment visibility between pauses.

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

**Retained candidates**:  
`G1CollectionSet::select_candidates_from_retained()`  
[`g1CollectionSet.cpp:531`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1CollectionSet.cpp#L531)

Log tag: `log_debug(gc,ergo,cset)` at both sites.

**Call chain**:
```
GC pause thread (during CSet finalization, before evacuation)
  → G1CollectionSet::finalize_initial_collection_set()   [g1CollectionSet.cpp:715]
    → G1CollectionSet::finalize_old_part()   [g1CollectionSet.cpp:377]
      → select_candidates_from_marking()   [g1CollectionSet.cpp:414]
      → select_candidates_from_retained()   [g1CollectionSet.cpp:531]
```

**Cadence**: Twice per mixed GC pause (once for Marking, once for Retained). Zero times during non-mixed pauses.

**Thread**: GC pause thread.

#### Fields

| Field | Source | Nullable? |
|---|---|---|
| `startTime` | Standard JFR | No |
| `candidateType` | `"Marking"` or `"Retained"` — two passes per mixed GC | No |
| `minRegions` | Min regions to add (`min_old_cset_length`) | No |
| `maxRegions` | Max regions to add | No |
| `availableRegions` | Candidate regions available | No |
| `availableGroups` | Card-set groups available | Consider dropping |
| `selectedRegions` | Initial + normal regions selected | No |
| `optionalRegions` | Optional regions selected | No |
| `overBudgetRegions` | Regions added despite predicted time too high; nonzero = pause risk | No |
| `predictedInitialTimeMs` | Predicted time for initial regions | No |
| `predictedOptionalTimeMs` | Predicted time for optional regions | Consider dropping |
| `timeRemainingMs` | Remaining GC time budget | No |
| `stopReason` | `"exhausted"` / `"max_regions_reached"` / `"min_regions_reached"` / `"time_too_high"` / `"none_available"` | No |

**DROPPED field**: `continueMixed` — from `G1Policy::decide_on_concurrent_start_pause()`, a different call site; cannot be safely attached to this event without reading state from a separate code location. If needed, file as a separate event or add to an existing `jdk.G1HeapSummary` extension.

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
Also: `young_collection_shrink_amount()` at line 172.  
Log tag: `log_debug(gc,ergo,heap)` — `log_resize()` is debug level.

**Call chain**:
```
GC pause thread
  → G1CollectedHeap::resize_heap_after_young_collection()   [g1CollectedHeap.cpp:986]
    → young_collection_resize_amount()   [g1HeapSizingPolicy.cpp:216]
```

Fires at end of every young GC pause.

**Cadence**: Once per young GC pause. NOTE: fires even when `resizeBytes == 0` (no resize occurred). Consider gating JFR emission on `resizeBytes != 0`.

**Thread**: GC pause thread.

#### Fields

| Field | Source | Nullable? |
|---|---|---|
| `startTime` | Standard JFR | No |
| `shortTermGcCpuUsagePct` | Short-term GC CPU usage — primary driver | No |
| `longTermGcCpuUsagePct` | Long-term GC CPU usage — context | No |
| `lowerThresholdPct` | Below this → eligible to shrink (from `GCTimeRatio`) | No |
| `upperThresholdPct` | Above this → eligible to expand | No |
| `gcCpuUsageTargetPct` | Desired steady-state value | No |
| `expand` | Boolean: true=expand, false=shrink | Yes (null if `resizeBytes=0`) |
| `resizeBytes` | Resize amount; 0 = no resize | No |
| `atLimit` | Boolean: heap at expansion or shrink limit | No |
| `scaleFactorPct` | Scale factor used in shrink calculation | Yes (null on expansion path) |
| `freeRegions` | Free regions at shrink evaluation | Yes (null on expansion path) |
| `regionsNeededForAlloc` | Regions needed for allocation headroom | Yes (null on expansion path) |

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
- `rule_minor_timer`
- `rule_minor_allocation_rate_dynamic`
- `rule_minor_allocation_rate_static`
- `rule_minor_high_usage`
- `rule_major_timer`
- `rule_major_warmup`
- `rule_major_proactive`
- `rule_major_allocation_rate`

**Call chain**:
```
ZGC director thread
  → director tick loop → start_gc()   [zDirector.cpp:926]
    → make_major_gc_decision()   [zDirector.cpp:631]
      → individual major rule functions
    → make_minor_gc_decision()   [zDirector.cpp:607]
      → individual minor rule functions
```

**Early-exit**: `make_minor/major_gc_decision` return on first triggered rule — at most ONE minor and ONE major rule fires per tick.

Log tag: `log_debug(gc,director)` — ALL rule log sites in `zDirector.cpp`. There is no `log_info` in the entire file.

**Cadence**: Every director tick (~1s default).

**Thread**: ZGC director thread.

#### Design concern with the current 22-field design

The proposed event has 22 fields. Each rule populates only 3–5 of them; most fields are null for most firings. This creates a pathologically sparse event that is hard to query and will receive upstream pushback.

#### Recommended redesign: per-tick summary event

Emit one event per director tick with ~6 fields:

| Field | Source | Nullable? |
|---|---|---|
| `startTime` | Standard JFR | No |
| `generation` | `"Young"` / `"Old"` | No |
| `triggeredMinorRule` | String (rule name), null if no minor GC triggered | Yes |
| `triggeredMajorRule` | String (rule name), null if no major GC triggered | Yes |
| `timeUntilMinorOOM` | From alloc-rate rule; null if alloc-rate rule not triggered | Yes |
| `minorFreeBytes` | From alloc-rate/high-usage rules | Yes |
| `majorFreePercent` | From high-usage/warmup rules | Yes |

This design retains the key observability (which rule triggered, what the urgency signal was) without the sparse-field problem.

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
3. The per-tick summary design must be validated: does the information from individual rule functions flow up to a single place in `start_gc()` where all fields are available? If not, the summary event still requires a struct accumulation pattern.

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

**Old gen shrink fields**:  
`PSAdaptiveSizePolicy::compute_old_gen_shrink_bytes()`  
[`psAdaptiveSizePolicy.cpp:~182`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/psAdaptiveSizePolicy.cpp#L182)

**Eden/survivor desired sizes**:  
`PSYoungGen::compute_desired_sizes()`  
[`psYoungGen.cpp:367`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/psYoungGen.cpp#L367)

Log tag: `log_debug(gc,ergo)` — ALL sites are debug level.

**Call chain**:
```
GC pause thread (within PSScavenge::invoke)
  → PSScavenge::invoke()   [psScavenge.cpp:431]
    → size_policy->print_stats(_survivor_overflow)   [psScavenge.cpp:431]
    → (also within same invoke()) compute_old_gen_shrink_bytes()
    → (also within same invoke()) PSYoungGen::compute_desired_sizes()
```

**Cadence**: Once per young GC collection.

**Thread**: GC pause thread (within `PSScavenge::invoke`).

#### Fields

| Field | Source | Nullable? |
|---|---|---|
| `startTime` | Standard JFR | No |
| `throughput` | `mutator_time_percent()` — windowed estimate | No |
| `minorPauseMs` | `minor_gc_time_estimate()*1000` (major GC NOT included) | No |
| `pauseGoalMs` | `_gc_pause_goal_sec*1000` (from `MaxGCPauseMillis`) | No |
| `gcDistanceSec` | `_gc_distance_seconds_seq.davg()` — average | No |
| `gcDistanceSecLast` | `_gc_distance_seconds_seq.last()` | No |
| `promotedBytesEstimate` | `_avg_promoted->padded_average()` — smoothed and padded | No |
| `promotedBytesLast` | `_promoted_bytes.last()` | No |
| `survivorOverflow` | Boolean: objects bypassed survivor to old gen | No |
| `desiredEden` | Captured at `PSYoungGen::compute_desired_sizes()` call site | No |
| `desiredSurvivor` | Captured at `PSYoungGen::compute_desired_sizes()` call site | No |
| `throughputEdenIncrease` | Throughput-increase branch only | Yes (null on pause-reduction branch) |
| `oldGenFree` | From `compute_old_gen_shrink_bytes()` | No |
| `minFreeBytes` | Old gen minimum free threshold (10-min promotion rate lookahead) | No |
| `shrinkBytes` | Old gen shrink amount; 0 if no shrink | No |

**DROPPED fields**:
- `throughputGoal`: re-derivable from `GCTimeRatio`, available from `jdk.GCConfiguration`.
- `promotionRateEstimate`, `promotionRateLast`: derivable as `promotedBytes / gcDistance`.

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
