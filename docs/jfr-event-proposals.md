# JFR Event Proposals: Source-Level Evidence Dossier

**Status**: Working document — 14 active proposals, 2 removed/blocked  
**Audience**: OpenJDK developers; every claim is traceable to a source file, line, and log site  
**Last updated**: 2026-08-19 (pass 67)

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
| 4 | jdk.ShenandoahCollectionDecision | **Propose with caveats** | High | `log_info(gc,ergo)` / `log_info(gc)` | Shenandoah GC cycle start |
| 5 | jdk.ShenandoahReclaimProgress | **Propose with caveats** | Medium | `log_info(gc,ergo)` | End of degenerated or full Shenandoah GC |
| 6 | jdk.ShenandoahTenuringThreshold | **Propose** | Medium | `log_info(gc,age)` | Each Shenandoah young collection planning phase |
| 7 | jdk.ZGCTenuringThreshold | **Propose with caveats** | Medium | `log_info(gc,reloc)` | `jdk.ZYoungGarbageCollection` field extension |
| 8 | jdk.ZNMethodRegistration | **Propose with caveats** | Low | `log_info(gc,nmethod)` | End of each ZGC generation collection |
| 9 | jdk.G1ConcurrentRefinementSweep | **Propose with caveats** | Medium | `log_debug(gc,refine)` | Each G1 refinement sweep completion |
| 10 | jdk.G1ConcurrentRefinementPolicy | **Propose with caveats** | Medium | `log_debug(gc,refine)` | Each young GC pause end + periodic |
| 11 | jdk.G1CollectionSetCandidates | **Propose with caveats** | Medium | `log_debug(gc,ergo,cset)` | Each mixed GC CSet finalization |
| 12 | jdk.G1HeapResize | **Propose with caveats** | Medium | `log_debug(gc,ergo,heap)` | Each young GC pause end |
| 13 | jdk.ZDirectorRule | **Propose with caveats** | Medium | `log_debug(gc,director)` | Each ZGC director tick (~1s) |
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

`jdk.ResidentSetSize` tracks instantaneous RSS (`size` and `peak` fields, fires per-chunk). It is complementary: it answers "what is RSS right now," not "how much did a trim operation recover." The delta from a deliberate trim cannot be reconstructed from instantaneous RSS snapshots because other allocation activity happens concurrently.

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

**Current code** ([`trimNativeHeap.cpp:135-160`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/runtime/trimNativeHeap.cpp#L135)):

```cpp
void execute_trim_and_log(double t1) {
  os::size_change_t sc = { 0, 0 };
  LogTarget(Info, trimnative) lt;
  const bool logging_enabled = lt.is_enabled();

  // RSS data collected ONLY if logging is active:
  if (os::trim_native_heap(logging_enabled ? &sc : nullptr)) {
    _num_trims_performed++;
    if (logging_enabled) {
      if (sc.after != SIZE_MAX) {
        log_info(trimnative)("Periodic Trim (%lu): %s->%s (%c%s) %.3fms", ...);
      } else {
        log_info(trimnative)("Periodic Trim (%lu): complete (no details) %.3fms", ...);
      }
    }
  }
}
```

A JFR event implementation **must not** gate data collection on whether `-Xlog:trimnative=info` is active. The fix is to call `os::trim_native_heap()` with a non-null `SizingCollection*` unconditionally — or, equivalently, to check `(lt.is_enabled() || jfr_event_enabled)` before deciding whether to populate the struct. This is a small upstream code change but it is a real prerequisite.

#### Fields

| Field | Source | Nullable? | Tuning use |
|---|---|---|---|
| `startTime` | Standard JFR | No | Timestamp of this trim operation. Compute inter-trim intervals by diffing consecutive `startTime` values; compare against `-XX:TrimNativeHeapInterval` (default 1000ms in container environments). If the measured interval is consistently longer than the configured value, the trim thread is being delayed by OS scheduling pressure or by the trim operation itself taking longer than the interval. |
| `duration` | Standard JFR | No | Wall-clock time of the entire trim operation (`malloc_trim()` + `/proc/self/status` reads). **Action thresholds**: < 10ms = normal; 10–100ms = elevated (check `/proc/self/status` read latency in restricted containers, or investigate lock contention in glibc arena management); > 100ms = significant — the OS is taking unusually long to reclaim pages (possible cause: large number of arena spans, kernel THP processing, or container memory throttling). If `duration` > `TrimNativeHeapInterval`, trims are serializing — each trim's wall time exceeds the interval, and the JVM will trim continuously with no idle windows. |
| `trimCount` | `uint64_t _num_trims_performed` — cumulative since JVM start; first event = 1 | No | Monotonically increasing; gaps in a continuous recording indicate missed events (buffer overflow or JFR disabled). **Expected gap check**: `trimCount` difference between consecutive events should equal 1 under normal conditions. A difference of 2+ means at least one trim event was dropped from the JFR buffer — reduce JFR buffer pressure or increase buffer size. |
| `beforeBytes` | `sc.before` from `/proc/self/status VmRSS` — RSS snapshot taken immediately before `malloc_trim()` is called | Yes — null on non-Linux or restricted containers | Pre-trim RSS baseline. Use only to compute `deltaBytes` = `afterBytes - beforeBytes`; the absolute value reflects total JVM RSS at that instant (heap + native + code cache + stacks). When null (`detailsAvailable=false`), the trim still ran but OS-level feedback is unavailable — rely on OS-level tools (`/proc/self/status`, container metrics) for RSS visibility. Comparing `beforeBytes` across consecutive events (ignoring deltaBytes) gives a coarser RSS trend than `jdk.ResidentSetSize`, since trim events are less frequent. |
| `afterBytes` | `sc.after` from `/proc/self/status VmRSS` after the trim completes | Yes — same condition | Post-trim RSS; the OS-reported RSS immediately after `malloc_trim()` returned. Only meaningful alongside `beforeBytes` — the absolute value fluctuates with concurrent allocations. Use `deltaBytes` as the primary metric; `afterBytes` is the raw signal it's computed from. |
| `deltaBytes` | `afterBytes - beforeBytes` — **SIGNED**; negative = memory returned to OS (afterBytes < beforeBytes). Near zero = either no arena bloat or platform does not support RSS recovery. Positive = RSS grew during the trim window (concurrent allocation outpaced reclaim). | Yes — same condition | **Primary metric**: large negative value (e.g. −100MB) = significant glibc arena fragmentation was present and recovered; near-zero after `detailsAvailable=true` = arenas are fully committed, adjust `-XX:TrimNativeHeapInterval` |
| `detailsAvailable` | `sc.after != SIZE_MAX` — false on non-Linux or when `/proc/self/status` is inaccessible (e.g., restrictive container security policy blocking `/proc` reads) | No | When `false`: `beforeBytes`, `afterBytes`, and `deltaBytes` are all null; the trim operation ran and `malloc_trim()` was called, but RSS measurement failed. **Interpretation**: `false` persistently = platform limitation, not a trim failure — trim is still running; adjust trimming interval by monitoring application-level native memory metrics instead (e.g., container-level RSS via cgroup). `true` = all RSS fields are populated and `deltaBytes` is the authoritative reclaim metric. |

#### What it is used for

Containerized JVMs running glibc suffer from a well-known RSS bloat problem: malloc arenas fragment over time, returning memory to the OS slowly or not at all. `TrimNativeHeapInterval` (default 1000ms in container environments) runs a background trim. Without a JFR event, operators cannot verify that:
1. Trims are executing at the configured interval.
2. Each trim is recovering any RSS (a trim that executes but recovers 0 bytes indicates all arenas are fully committed — there is nothing to return).
3. The trim delta is significant enough to justify the trim overhead.

**Tuning patterns**:
- `deltaBytes` near 0 on most trims with `detailsAvailable=true` → two distinct cases: (a) the JVM is continuously using all its native memory (arenas fully committed, nothing to return) — this is normal under high allocation pressure; the trims are running but finding no bloat to reclaim; (b) glibc arenas are fragmented internally but in a way that `malloc_trim()` cannot compact (e.g., live allocations pinning arena segments). Distinguish case (a) from (b) by comparing JVM heap usage growth — if heap is stable but native RSS stays high after trim, fragmentation is the cause; if heap is growing, arenas are genuinely in use.
- `deltaBytes` near 0 with `detailsAvailable=false` → platform does not expose `/proc/self/status` (non-Linux container or restricted procfs) — trim is executing but outcome is unobservable.
- `deltaBytes` large (> 50MB) on first few trims, then near 0 → normal: initial trims clear accumulated arena bloat from the warm-up phase; subsequent trims find little to release. This is the healthy pattern.
- `deltaBytes` consistently large (> 20MB) on every trim → arenas are continuously accumulating bloat between trims; trim is reclaiming significant memory on each run but not frequently enough. Decrease `-XX:TrimNativeHeapInterval` to trim more frequently — the bloat accumulating between trims is proportional to allocation churn rate times the interval; halving the interval roughly halves the per-trim delta at steady state.
- `deltaBytes` consistently near 0 after every trim (not the first-few-warm-up pattern) → arenas have nothing to return, meaning either the workload holds native memory continuously or trim frequency exceeds the rate at which arenas accumulate bloat. Safe to increase `-XX:TrimNativeHeapInterval` (reducing trim overhead) — but first verify RSS is not growing: if `jdk.ResidentSetSize.size` is rising despite near-zero `deltaBytes`, glibc is acquiring new pages faster than trim can reclaim, which is a fragmentation or footprint issue, not an interval issue.

**Cross-event correlation**: join `jdk.NativeHeapTrim.startTime` with `jdk.GarbageCollection.startTime` by time proximity (within a 500ms window). If large `deltaBytes` trim events consistently coincide with GC pause windows, it means glibc arenas are releasing pages primarily during GC-induced allocation lulls — not during the trim itself. This pattern argues for a shorter `TrimNativeHeapInterval` so that arenas are reclaimed more aggressively between pauses rather than relying on GC-adjacent idleness. If large `deltaBytes` trims occur with no nearby GC events, the application's own allocation rate is releasing arena capacity naturally — trims are effective independent of GC. Join with `jdk.ResidentSetSize` (by `startTime` proximity, since that event fires periodically) to track whether `beforeBytes` of consecutive `jdk.NativeHeapTrim` events tracks the `jdk.ResidentSetSize.size` trend — if RSS is rising between trims faster than `deltaBytes` can reclaim, the native heap is growing net-positive despite trimming.

#### Why existing events don't cover this

- `jdk.ResidentSetSize`: carries `size` (current RSS) and `peak` (peak RSS since JVM start); fires `period="everyChunk"` as a snapshot. It answers "what is RSS right now" — it cannot attribute a change to a deliberate trim operation, because other allocation/deallocation activity happens concurrently. There is no `deltaBytes` field, no `trimDuration` field, and no way to isolate a single trim operation's contribution from background noise. The two events are orthogonal: `jdk.NativeHeapTrim` says "this specific trim recovered X bytes in Y ms"; `jdk.ResidentSetSize` says "RSS is currently Z bytes".
- No existing JFR event references `NativeHeapTrimmer`, `TrimNativeHeapInterval`, or `os::trim_native_heap`. The trim operation is entirely invisible in JFR today: there is no `beforeBytes`/`afterBytes` pair, no `trimDurationMs`, no `detailsAvailable` flag, and no `trimCount` monotonic counter. The only native-heap signal in JFR is the `jdk.ResidentSetSize` periodic snapshot, which captures no per-trim causality. Without `jdk.NativeHeapTrim`, an operator cannot answer "did the trim that ran 30 seconds ago recover any memory?" from a JFR recording alone.

#### External references

[PR #26756](https://github.com/openjdk/jdk/pull/26756) (JDK-8365306) — NativeHeapTrim JFR event, opened by Thomas Stuefe, closed December 2025. From the PR design discussion:

> "NativeHeapTrim Event (event-driven): RSS before/after measurements, Memory recovered, Automatic vs. manual trim distinction"

The PR was closed due to inactivity following a design disagreement about a broader `ProcessSize` umbrella event. The `NativeHeapTrim` event specifically was **not objected to** — only the `ProcessSize` umbrella was contested. A narrow trim-only re-proposal avoids the contested scope entirely.

Container environments running glibc suffer from well-documented RSS bloat (see Thomas Stuefe's work on `os::trim_native_heap` and the Red Hat container JVM investigations). `-XX:TrimNativeHeapInterval` was introduced specifically to address this; `jdk.NativeHeapTrim` closes the JFR observability gap for it.

`jdk.ResidentSetSize` is a complementary event — it answers "what is RSS right now" but cannot attribute changes to deliberate trims vs. allocation fluctuation. The two events are orthogonal.

#### Open questions / upstream concerns

1. **Upstream prerequisite: decouple data collection from `logging_enabled`**. The RSS data (`sc.before`/`sc.after`) is collected only when `LogTarget(Info, trimnative).is_enabled()`. The fix is one-line: change `logging_enabled ? &sc : nullptr` to `(logging_enabled || jfr_event_enabled) ? &sc : nullptr`, or unconditionally pass `&sc` and let the caller decide whether to use the values. The blast radius is minimal — `os::trim_native_heap()` receiving a non-null pointer merely populates two `size_t` fields from `/proc/self/status`; it does not change the trim behavior itself. The JFR PR should include this prerequisite change and document it in the commit message. Upstream accepted equivalent logging-decoupling changes in other JFR event proposals (e.g., NativeMemoryTracking events were similarly gated on `-XX:NativeMemoryTracking` before JFR decoupled them).
2. **Resolved**: `deltaBytes` as a signed `long` (JFR native type) is the right design. The underlying `os::size_change_t` has unsigned `before`/`after` fields; `deltaBytes = (long)afterBytes - (long)beforeBytes` is computable at emit time. JFR `long` is signed 64-bit, and the negative-means-returned convention is self-documenting. The `freedBytes + expanded_boolean` alternative adds a field without adding information — both `beforeBytes` and `afterBytes` are already in the event.
3. **Resolved**: `_num_trims_performed` is cumulative from JVM initialization (initialized to 0 in the constructor at [`trimNativeHeap.cpp:169`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/runtime/trimNativeHeap.cpp#L169), incremented at line 144). The field is cumulative — monotonically increasing since JVM start. Gaps in a continuous JFR recording where `trimCount` jumps by more than expected indicate missed events (buffer overflow or JFR disabled periods).

---

### 2. jdk.GCOverheadLimitExceeded

#### Verdict

**Propose with caveats.** Two GC implementations have different field shapes for free-space metrics. Either accept nullable fields (with documentation) or consider two separate events.

#### The question it answers

"What was the JVM's state immediately before throwing GCOverheadLimitExceeded OOM?"

No JFR event fires at the GC decision point — the moment the GC subsystem decides the overhead limit has been breached. Operators learn about `GCOverheadLimitExceeded` only via logs or heap dumps, not via a structured JFR record containing the GC time percent and free-space state at the moment of the decision. The JVM typically exits immediately on the first OOM, so post-hoc analysis is often impossible without pre-configured observability.

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

**Counter-update vs. throw-point distinction**: `update_gc_overhead_counter()` ([`g1CollectedHeap.cpp:995`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1CollectedHeap.cpp#L995)) runs at each safepoint and logs the raw counter at `log_debug(gc)`. The JFR event belongs at the throw point — `satisfy_failed_allocation()` line 1109 — where `gc_overhead_limit_exceeded()` returns true and control flow is about to return null to the allocating thread. The `long_term_gc_time_ratio` and `free_space_percent` locals are scoped inside `update_gc_overhead_counter()` and are NOT directly in scope at line 1109; the JFR implementation must re-read them at the emission site (both are cheap accessor calls — see field table below).

**G1 counter update + throw point** ([`g1CollectedHeap.cpp:995-1111`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1CollectedHeap.cpp#L995)):

```cpp
// Called at each safepoint (per-GC-pause counter update):
void G1CollectedHeap::update_gc_overhead_counter() {
  bool gc_time_over_limit =
    (_policy->analytics()->long_term_gc_time_ratio() * 100) >= GCTimeLimit; // default 98%
  double free_space_percent =
    percent_of(num_available_regions() * G1HeapRegion::GrainBytes, max_capacity());
  bool free_space_below_limit = free_space_percent < GCHeapFreeLimit;  // default 2%

  log_debug(gc)("GC Overhead Limit: GC Time %f Free Space %f Counter %zu",
                ..., _gc_overhead_counter);

  if (gc_time_over_limit && free_space_below_limit) {
    _gc_overhead_counter++;   // Both conditions must be true simultaneously
  } else {
    _gc_overhead_counter = 0; // Reset if either condition clears
  }
}

// Called at allocation failure (throw point):
// satisfy_failed_allocation() at g1CollectedHeap.cpp:1076:
update_gc_overhead_counter();   // Update counter first
// ... attempt final GC ...
// At line 1109: check and log:
if (gc_overhead_limit_exceeded()) {  // _gc_overhead_counter >= GCOverheadLimitThreshold (=5)
  log_info(gc)("GC Overhead Limit exceeded too often (%zu).", GCOverheadLimitThreshold);
  // ← JFR event fires HERE; must re-read long_term_gc_time_ratio and free_space_percent
  //   via _policy->analytics()->long_term_gc_time_ratio() and percent_of(...) — not in scope here
}
return nullptr;  // OOM thrown to allocating thread
```

The JFR event fires at the `log_info` site. To access `long_term_gc_time_ratio` and `free_space_percent` at the JFR emission point (line 1109), the implementation needs to either: (a) re-read them from the policy object at line 1109 — `_policy->analytics()->long_term_gc_time_ratio()` and `percent_of(num_available_regions() * G1HeapRegion::GrainBytes, max_capacity())` are both cheap reads accessible at that point; or (b) modify `update_gc_overhead_counter()` to store the values as fields. Option (a) is simpler — both accessor calls are already present in `update_gc_overhead_counter()` and can be repeated inline at the JFR emission site.

#### Fields

| Field | Source | G1 | Parallel | Nullable? | Tuning use |
|---|---|---|---|---|---|
| `startTime` | Standard JFR | Yes | Yes | No | Timestamp of the OOM throw point — the moment `satisfy_failed_allocation()` decided to return null to the allocating application thread. Typically the last structured record before the JVM exits (when `-XX:+ExitOnOutOfMemoryError` is set). |
| `gcId` | `GCId::peek() - 1` — last assigned GC id; `peek()` returns `_next_id` (the NEXT id to be assigned), so `peek()-1` gives the last completed GC id | Yes | Yes | Yes (undefined if no GC has run yet) | Join with `jdk.GarbageCollection` on this `gcId` to retrieve the last GC's type (`cause`), duration, and whether it was a Full GC or a minor GC — a long Full GC immediately before the throw confirms the GC was doing maximum work; a short minor GC confirms old gen was not being touched. Also join with `jdk.G1HeapSummary` (G1) or `jdk.PSHeapSummary` (Parallel) on this `gcId` to see heap occupancy after the last GC — the used/committed ratio from those events gives the starting conditions for the OOM sequence. Null when no GC has completed; in that case the JVM threw OOM on the very first allocation attempt (extremely unusual — implies heap too small to start). |
| `collector` | String literal: `"G1"` or `"Parallel"` | Yes | Yes | No | Determines which free-space fields are non-null (`freeSpacePercent` for G1; `freeSpaceYoungPercent` + `freeSpaceOldPercent` for Parallel) and which GC heap events to join on `gcId` (`jdk.G1HeapSummary` for G1; `jdk.PSHeapSummary` for Parallel). In a mixed-GC fleet, always split analysis by `collector` before comparing thresholds — G1's `freeSpacePercent` and Parallel's `freeSpaceOldPercent` are not directly comparable (G1's is whole-heap free fraction; Parallel's old/young split reflects `NewRatio` sizing). |
| `gcTimePercent` | G1: `_policy->analytics()->long_term_gc_time_ratio() * 100` ([`g1CollectedHeap.cpp:1002`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1CollectedHeap.cpp#L1002)) — must be re-read via this accessor at line 1109, not taken from `update_gc_overhead_counter()` local; Parallel: `_size_policy->gc_time_percent() * 100` (= `(1 - mutator_time_percent()) * 100`) — `gc_time_percent()` returns a fraction 0..1 ([`adaptiveSizePolicy.hpp:151`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shared/adaptiveSizePolicy.hpp#L151)), member accessible at line 507 | Yes | Yes | No | **Primary diagnostic**: must be ≥ `GCTimeLimit` (default 98%) for the throw to happen — this is a pre-condition, not an insight. The real insight is the magnitude: if `gcTimePercent` is exactly at the limit (98%) and `freeSpacePercent` is near 0%, both conditions were tight — this is genuine heap exhaustion. If `gcTimePercent` is at the limit but `freeSpacePercent` is significantly above `GCHeapFreeLimit` (2%), the standard dual-condition logic should have reset the counter; this suggests the counter was driven entirely by the GC-time condition while free space happened to be low only on the counting GCs. Compare `gcTimePercent` against the last `jdk.GCCPUTime` or `jdk.GarbageCollection.duration` — if the final GC was very short (< 100ms) despite 98% GC time ratio, the rolling average is dominated by earlier slow GCs; the workload had a sustained GC performance problem before the final OOM. |
| `freeSpacePercent` | G1: `percent_of(num_available_regions() * G1HeapRegion::GrainBytes, max_capacity())` ([`g1CollectedHeap.cpp:1003`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1CollectedHeap.cpp#L1003)) | Yes | No | Yes (null for Parallel) | G1 only: must be < `GCHeapFreeLimit` (default 2%) for the throw to happen. **Diagnosis at throw time**: near 0% = heap is completely exhausted; available region count is critical — increase `-Xmx`. 1–2% = just at the threshold; a single additional promotion would have crossed it — this is borderline exhaustion; a 10–20% `-Xmx` increase is likely sufficient. Above 2% at throw time = both conditions should have been true for 5 consecutive GCs but `freeSpacePercent` is inconsistently above the threshold; verify whether `GCHeapFreeLimit` was modified or whether the G1 overhead-limit feature in [PR #27950](https://github.com/openjdk/jdk/pull/27950) is functioning as expected. |
| `freeSpaceYoungPercent` | Parallel: `percent_of(_young_gen->free_in_bytes(), _young_gen->capacity_in_bytes())` ([`parallelScavengeHeap.cpp:437`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/parallelScavengeHeap.cpp#L437)) | No | Yes | Yes (null for G1) | Parallel only: free fraction in young gen at throw time. Near 0 = eden nearly full; the allocation that failed could not fit even in an empty survivor. Compare with `freeSpaceOldPercent`: if both are near 0, the entire heap is exhausted; if young is near 0 but old has free space, promotion is failing and a minor GC would not have helped. |
| `freeSpaceOldPercent` | Parallel: `percent_of(_old_gen->free_in_bytes(), _old_gen->capacity_in_bytes())` ([`parallelScavengeHeap.cpp:438`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/parallelScavengeHeap.cpp#L438)) | No | Yes | Yes (null for G1) | Parallel only: free fraction in old gen at throw time; near 0 = old gen exhausted. If `freeSpaceYoungPercent` is non-zero but `freeSpaceOldPercent` is near 0, the bottleneck is old gen capacity — increase `-Xmx` or reduce `NewRatio` to give old gen more of the heap. |
| `consecutiveViolations` | **RECOMMENDED TO DROP** — always equals `GCOverheadLimitThreshold` (= 5, a `develop` flag, not configurable in production). The counter is always 5 at the emission point; carrying no diagnostic information. See open question 3. | Yes | Yes | No | Always 5 at throw time. Zero information value — the event fires exactly once when the OOM is thrown, which already implies the threshold was reached. Recommend omitting from the upstream proposal. |

#### Why existing events don't cover this

- No `jdk.OutOfMemoryError` event exists in the JFR metadata — verified against `src/hotspot/share/jfr/metadata/metadata.xml`. The JVM does fire `jdk.JavaErrorThrow` but that is at the Java exception propagation level, after the OOM object is constructed, and carries no GC state fields.
- `jdk.GCHeapSummary`, `jdk.G1HeapSummary`, `jdk.PSHeapSummary`: record heap sizes at GC events (`heapSpace`, `edenSpace`, etc.) — outcome fields at GC boundaries, not at the allocation failure → OOM decision moment. Do not carry `gc_overhead_counter`, `long_term_gc_time_ratio`, or the `GCTimeLimit`/`GCHeapFreeLimit` threshold state.
- `jdk.GCCPUTime` (G1/Parallel/Serial): records per-pause CPU time (`userTime`, `systemTime`, `realTime`) — does not expose the `_gc_overhead_counter` incremented by `update_gc_overhead_counter()`, the rolling average `long_term_gc_time_ratio()`, or the `GCHeapFreeLimit` free-space check. Even if it did, it fires at pause end, not at the OOM throw point where the counter reached the threshold.
- No existing JFR event captures the GC overhead limit violation counter or the moment the JVM decides to throw. Specifically: `_gc_overhead_counter` (the consecutive-violation counter incremented by `update_gc_overhead_counter()`), `long_term_gc_time_ratio` (the rolling average GC time fraction), and `free_space_percent` at throw time are not present in any JFR event in `metadata.xml`.

#### What it is used for

`GCOverheadLimitExceeded` OOM is one of the hardest production failures to diagnose post-hoc because the JVM typically exits immediately. Heap dumps capture the live set but not the GC overhead metrics at the moment of the decision. This event fires synchronously at the throw point, giving you a structured record of:

- Was the threshold correctly calibrated? `gcTimePercent` shows the actual GC time fraction at the moment of throw. If it equals exactly `GCTimeLimit` (default 98%), the threshold was met as expected. Both conditions (`gcTimePercent >= GCTimeLimit` and `freeSpacePercent < GCHeapFreeLimit`) must be simultaneously true for 5 consecutive GC cycles before the OOM is thrown.
- What was the heap free-space ratio? Low `freeSpacePercent` confirms heap exhaustion; high `freeSpacePercent` with high `gcTimePercent` indicates GC is running but not reclaiming (live set too large, not heap exhaustion).

**G1 interpretation** (`collector="G1"`): `freeSpacePercent` is the G1 unified free-region fraction. If it is near 0% at throw time, G1 ran out of available regions — increase `-Xmx`. If `gcTimePercent` is at the limit but `freeSpacePercent` is non-trivially above 2% (the `GCHeapFreeLimit` threshold), something unusual happened — the standard threshold logic requires both to be true, so re-check whether the G1 overhead-limit feature is functioning as documented in [PR #27950](https://github.com/openjdk/jdk/pull/27950).

**Parallel GC interpretation** (`collector="Parallel"`): `freeSpaceYoungPercent` and `freeSpaceOldPercent` allow a more specific diagnosis:
- `freeSpaceYoungPercent ≈ 0` and `freeSpaceOldPercent > 20%`: the young gen exhausted but old gen has space — promotion is failing (live set is too large for a single minor GC cycle). Reduce `NewRatio` to give old gen more of the heap, or increase `-Xmx`.
- `freeSpaceYoungPercent > 10%` and `freeSpaceOldPercent ≈ 0%`: old gen is exhausted. Increase `-Xmx`, reduce live set, or reduce `NewRatio` to shrink young gen and give old gen more capacity.
- Both near 0%: the entire heap is exhausted; only `-Xmx` increase will help.

**Cross-event correlation**: use `gcId` to join with `jdk.GarbageCollection` and retrieve the last GC's duration (`duration`), pause time, and cause before the throw. If the last GC was a Full GC with a very long duration, GC was doing maximum work before the OOM — the live set is genuinely too large. If the last GC was a minor GC with a short duration, GC was not reclaiming any old-gen space, confirming old-gen exhaustion. Join with `jdk.G1HeapSummary` (G1) or `jdk.PSHeapSummary` (Parallel) on `gcId` to see the heap state after the last GC before the throw — `heapUsed` and `heapSpace.committedSize` at that GC give the starting conditions for the OOM sequence.

#### External references

[JDK-8212084](https://bugs.openjdk.org/browse/JDK-8212084) — "Add GCOverheadLimit check to G1GC": the JBS issue tracking G1 support for the overhead limit check.

[PR #27950](https://github.com/openjdk/jdk/pull/27950) — G1 GCOverheadLimitExceeded implementation, merged JDK 26. From the PR description:

> "The feature operates by: Detection Point: Checking overhead metrics at the conclusion of initial garbage collection phases... Triggering Condition: Returning null prematurely when both GC CPU usage and heap usage thresholds are exceeded for a sustained sequence of collections"

Oracle JDK 26 documentation on `GCOverheadLimit`:

> The default `GCTimeLimit=98` means the JVM throws `OutOfMemoryError` if more than 98% of time is spent in GC with less than `GCHeapFreeLimit=2%` heap freed. Without a JFR event, operators can only discover this threshold was hit from the OOM itself — the GC time percent and free-space state at the moment of the decision are lost unless heap dumps and logs were pre-configured.

#### Open questions / upstream concerns

1. **Resolved: single combined event with nullable free-space fields.** G1 and Parallel have different free-space shapes (`freeSpacePercent` for G1; `freeSpaceYoungPercent` + `freeSpaceOldPercent` for Parallel). The nullable pattern is appropriate here: the `collector` field makes null semantics self-documenting, and there is only one event per JVM lifetime in most cases. Separate events (`jdk.G1GCOverheadLimitExceeded` + `jdk.ParallelGCOverheadLimitExceeded`) are cleaner but double the JFR metadata boilerplate for an event that fires at most once. The combined event with `collector="G1"` or `collector="Parallel"` is the chosen approach for the upstream submission.
2. **Resolved**: `gcId` uses `GCId::peek() - 1` at the throw point. `GCId::peek()` returns `_next_id` (the id to be assigned to the NEXT GC), so `peek() - 1` is the last assigned GC id. If `peek() == 0` (no GC has run), the field is undefined. At `satisfy_failed_allocation()` the executing thread is the allocating application thread, so `GCId::current()` would assert (it is only valid on a GC thread); `peek()-1` is the correct mechanism. This is a well-established JFR pattern.
3. **Resolved: drop `consecutiveViolations`**. The counter always equals `GCOverheadLimitThreshold` at throw time — any other value is impossible since the throw only occurs when `_gc_overhead_counter >= GCOverheadLimitThreshold`. Furthermore `GCOverheadLimitThreshold = 5` is a `develop` flag and is not configurable in production builds. The field therefore carries exactly zero information at throw time: it is always 5. Keeping it risks misleading users into thinking it varies. The schema is adequately self-documenting without it: the event fires exactly once when the OOM is thrown, which already implies the threshold was reached. Removed from the proposed schema.
4. **Resolved: G1 field scoping**: `long_term_gc_time_ratio` and `free_space_percent` are locals inside `update_gc_overhead_counter()` and out of scope at the throw point (line 1109). Re-read them at the JFR emission site: `_policy->analytics()->long_term_gc_time_ratio()` and `percent_of(num_available_regions() * G1HeapRegion::GrainBytes, max_capacity())`. Parallel GC does not have this issue — `_size_policy` is a class member accessible throughout `ParallelScavengeHeap`.

---

### 3. jdk.ShenandoahMMU

#### Verdict

**Propose with caveats.** The end-of-cycle path (log_info) is clean and ready to propose. The periodic path (log_debug) should be dropped from the initial proposal or guarded behind a separate JFR flag. Do not bundle the debug-level periodic path with the info-level end-of-cycle path in the same upstream submission.

#### The question it answers

"What fraction of wall-clock time is the Shenandoah GC consuming vs. mutator threads?"

`jdk.G1MMU` exists but measures something structurally different: it records `gcTime` (ms stopped in GC during last time slice) vs. `pauseTarget` (max allowed pause in that slice) — a discrete pause-compliance check. Shenandoah GCU%/MU% measures the CPU-time fraction over the **entire GC phase window**, including concurrent GC work that is not a pause at all. For a concurrent collector, GCU% is the more complete overhead metric: it captures the CPU cost of all GC work (concurrent + STW), while `jdk.G1MMU`-style pause fractions miss the concurrent portion entirely.

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

**GCU% computation** ([`shenandoahMmuTracker.cpp:86-110`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahMmuTracker.cpp#L86)):

```cpp
void ShenandoahMmuTracker::update_utilization(size_t gcid, const char* msg) {
  double current = os::elapsedTime();
  _most_recent_gcid = gcid;

  double gc_cycle_period = current - _most_recent_timestamp;  // wall-clock since last GC
  _most_recent_timestamp = current;

  double gc_thread_time, mutator_thread_time;
  fetch_cpu_times(gc_thread_time, mutator_thread_time);  // cumulative CPU times

  // GCU = (GC thread CPU time this cycle) / (active CPUs × wall-clock time)
  double gc_time = gc_thread_time - _most_recent_gc_time;
  _most_recent_gc_time = gc_thread_time;
  _most_recent_gcu = gc_time / (_active_processors * gc_cycle_period);

  // MU = mutator CPU fraction (not simply 100 - GCU; can exceed 1.0 briefly)
  double mutator_time = mutator_thread_time - _most_recent_mutator_time;
  _most_recent_mutator_time = mutator_thread_time;
  _most_recent_mu = mutator_time / (_active_processors * gc_cycle_period);

  log_info(gc, ergo)("At end of %s: GCU: %.1f%%, MU: %.1f%% during period of %.3fs",
                     msg, _most_recent_gcu * 100, _most_recent_mu * 100, gc_cycle_period);
}
```

**Callers** (the `phase` string and exact GC phase):
- `record_young(gcid)` → `"Concurrent Young GC"`
- `record_global(gcid)` → `"Concurrent Global GC"`
- `record_bootstrap(gcid)` → `"Concurrent Bootstrap GC"`
- `record_mixed(gcid)` → `"Mixed Concurrent GC"`
- `record_full(gcid)` → `"Full GC"`
- Degenerated GC caller → `"Degenerated %s GC"` (formatted by `shenandoahDegeneratedGC.cpp:61`)

#### Fields

| Field | Source | Nullable? | Tuning use |
|---|---|---|---|
| `startTime` | Standard JFR | No | Timestamp of GC phase completion. Correlate with `jdk.GarbageCollection` on `gcId` to join GCU%/MU% against the specific collection's pause duration — comparing `gcuPercent` (concurrent CPU fraction) with `jdk.GarbageCollection.duration` (pause time) for the same `gcId` gives the complete cost picture: pause + background CPU overhead. `periodSeconds` covers the full inter-GC wall-clock window; `jdk.GarbageCollection.duration` covers the stop-the-world portion; the difference is the concurrent phase wall-clock time. |
| `gcId` | `_most_recent_gcid` — GC ID of the collection that updated the MMU tracker; set by each `record_young(gcid)` / `record_global(gcid)` / `record_full(gcid)` caller | No | Join with `jdk.GarbageCollection` to correlate GCU%/MU% against the specific collection that produced them. Particularly useful for comparing `gcuPercent` across different `phase` values on the same GC ID timeline. |
| `phase` | `"Concurrent Young GC"`, `"Concurrent Global GC"`, `"Concurrent Bootstrap GC"`, `"Mixed Concurrent GC"`, `"Full GC"`, `"Degenerated Young GC"`, `"Degenerated Global GC"`, `"Degenerated Bootstrap Old GC"` — exact strings from `update_utilization()` callers in [`shenandoahMmuTracker.cpp`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahMmuTracker.cpp) and [`shenandoahDegeneratedGC.cpp:61`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahDegeneratedGC.cpp#L61) | Yes (null for periodic path if added later) | **Phase GCU% benchmarks**: healthy concurrent young GCs typically run at 5–15% GCU; Full GC and Degenerated GC at 50–100% (STW, all CPUs engaged). If `phase="Full GC"` shows `gcuPercent < 30%`, the JVM is underutilizing CPUs during compaction — suspect I/O or NUMA issues. If `phase="Degenerated Young GC"` has `gcuPercent > 50%`, the STW fallback is working hard — the concurrent GC was seriously behind. Comparing `gcuPercent` between `"Concurrent Young GC"` and `"Degenerated Young GC"` for the same workload quantifies the overhead cost of failing concurrent GC. |
| `gcuPercent` | GC utilization 0–100 — `_most_recent_gcu * 100` where `_most_recent_gcu = gc_time / (_active_processors * gc_cycle_period)`. `_active_processors` is fixed at JVM initialization via `os::initial_active_processor_count()` (line 182) — it does NOT update if CPU affinity changes after JVM start. | No | **Primary metric**: GC CPU fraction across the entire collection phase. Typical healthy range for latency-sensitive workloads: < 10%; balanced: < 20%; batch: < 30%. Sustained `gcuPercent > 30%` means GC is consuming significant CPU and application throughput is meaningfully impacted — increase `-Xmx` or reduce live set. **Container caveat**: if CPU quota is changed post-startup (cgroup updates), `_active_processors` is stale and GCU% overstates real utilization; verify against container metrics or `jdk.ProcessCPULoad`. |
| `muPercent` | Mutator utilization 0–100+ — `_most_recent_mu * 100` from `update_utilization()`, independently measured from GC thread CPU time; **not** simply `100 - gcuPercent`. Both fractions are measured against `_active_processors × gc_cycle_period`. On a 16-core machine running at 50% load, both GCU and MU can be far below 100% (remaining = I/O, sleep, other processes). MU can briefly exceed 100% when the CPU-time accounting window boundary falls mid-cycle and threads spike at the boundary — this is a measurement artifact, not a real > 100% utilization; treat MU > 100% as approximately 100% in practice. | No | **Idle indicator**: if `muPercent + gcuPercent << 100` consistently (e.g. sum < 60%), remaining CPU is idle — application is I/O-bound or throttled by other processes; heap sizing and thread counts are not the bottleneck. **Not a GC problem**: `muPercent < 50%` and `gcuPercent < 10%` = throughput-limited by I/O or network, not GC — tuning heap will not help. |
| `periodSeconds` | `gc_cycle_period = current - _most_recent_timestamp` — wall-clock elapsed since the **previous call to `update_utilization()`**, not the GC phase duration. On normal cycles this approximates the inter-GC interval. | No | Context for interpreting `gcuPercent` and `muPercent`: a short period (e.g. 50ms young GC every 100ms) vs. a long period (e.g. 2s global GC every 3s) yield different absolute CPU times even at the same GCU%. Absolute GC CPU time = `gcuPercent × periodSeconds × active_processors / 100` |

**DROPPED field**: `isPeriodicSample` — removed from initial proposal since the periodic `report()` path is `log_debug` and excluded (see open question 1).

#### What it is used for

`jdk.G1MMU` measures whether G1 met its pause-time goal within a fixed window. Shenandoah MMU measures something fundamentally different: what fraction of wall-clock time was the JVM spending on GC across an entire GC phase? This answers SLA questions like "is my application spending > 10% of time in GC?" — questions that pause-time metrics alone cannot answer for concurrent collectors (where much of the GC work is not a pause at all).

**Key patterns**:
- `gcuPercent` trending upward across consecutive young GCs → GC CPU overhead is growing; allocation rate is increasing faster than GC throughput (the only way GCU% can grow while young gen size is fixed). **Actions**: (a) increase `-Xmx` to provide more headroom between collections; (b) check `jdk.ShenandoahCollectionDecision` `triggerType` to confirm the allocation trigger (`rate_average` = steady growth, `rate_accelerated` = phase-change burst); (c) if `muPercent` is also high (> 70%) and trending upward together with `gcuPercent`, the workload is genuinely memory-intensive and heap sizing is the primary lever; if `muPercent` is flat while `gcuPercent` rises, GC is becoming less efficient per allocated byte — check `triggerType=fragmentation` events in `jdk.ShenandoahCollectionDecision`.
- `gcuPercent` high for `phase="Concurrent Young GC"` but normal for global → young generation is undersized, running concurrent collections more frequently than the old generation needs. **Action**: check `ShenandoahMinYoungGenPercent` and `ShenandoahMaxYoungGenPercent` — if young gen ceiling is too low relative to allocation rate, GC cycles back-to-back. Verify via `jdk.ShenandoahCollectionDecision` `available` field: if `available` is consistently low at young GC start, the young gen is exhausted too quickly.
- `gcuPercent > 30%` sustained → GC overhead is at a level that materially impacts application throughput. Split analysis by `phase`: if the 30%+ is from `"Concurrent Young GC"`, young gen is undersized or allocation rate is very high; first action is `-Xmx` increase. If it's from `"Degenerated Young GC"`, concurrent GC is failing frequently — the problem is not heap size but GC concurrency (root: heap already too full when GC starts → check `jdk.ShenandoahCollectionDecision` `available`). `gcuPercent > 50%` sustained on concurrent young GCs is a critical threshold — the JVM is spending more than half its CPU on GC, which is unsustainable; emergency actions are `-Xmx` increase and live-set reduction.
- Comparing `gcuPercent` for `"Full GC"` vs `"Concurrent Young GC"` phases quantifies the relative cost of fallback vs. normal operation. If Full GC `gcuPercent` is 5–10× higher than Concurrent Young `gcuPercent`, the fallback path is causing extreme CPU overhead bursts — even occasional Full GCs dominate the average GCU%. Use `jdk.ShenandoahReclaimProgress` `badProgressCount` to predict upcoming Full GCs: when `badProgressCount` reaches 1 (one step before Full GC escalation), intervene (increase `-Xmx` or reduce live set) before the Full GC fires. A sustained ≥ 20% gap between Full GC and Concurrent Young `gcuPercent` at the same heap size is a strong signal that degenerated GCs (which fall back to STW) are common and heap sizing is the root cause.

**Cross-event correlation**: join `jdk.ShenandoahMMU` with `jdk.GarbageCollection` on `gcId` to get the absolute pause duration alongside the fractional CPU cost — a long pause with low `gcuPercent` means the GC was pause-heavy but concurrent-light; a short pause with high `gcuPercent` means most GC work was concurrent but still consuming significant CPU. Join with `jdk.ShenandoahCollectionDecision` on `gcId` to compare the trigger reason against the resulting GCU%: if `triggerType=rate_accelerated` and `gcuPercent` for the subsequent young GC is also elevated (> 20%), the acceleration burst caused both a forced early GC and high CPU overhead for that cycle. Join with `jdk.ProcessCPULoad` (periodic event, fires every chunk) by time window: when `jdk.ProcessCPULoad.jvmUser + jdk.ProcessCPULoad.jvmSystem` is high while `gcuPercent` is also high, GC is a significant fraction of total JVM CPU — the workload is CPU-bound on GC; when `jdk.ProcessCPULoad` is low but `gcuPercent` is high, the application itself is IO-bound or mostly idle and GC is consuming the small amount of CPU the application does use.

#### Why existing events don't cover this

- `jdk.G1MMU`: measures pause compliance in a fixed window (ms units, G1-specific). Structurally different from Shenandoah's GCU%/MU% fraction — it answers "did the pause stay under the goal within a rolling window?" not "what fraction of wall-clock time was GC?".
- `jdk.GCCPUTime`: records GC CPU time per pause (user/system/real times). **Explicitly does not support Shenandoah** — the event description in `metadata.xml` reads "Supported: G1GC, ParallelGC and SerialGC". `GCTraceCPUTime` is never constructed in Shenandoah's GC path (`shenandoahConcurrentGC.cpp`, `shenandoahDegeneratedGC.cpp`, `shenandoahFullGC.cpp`). Even if it were, per-pause CPU time is structurally different from GCU% across an entire concurrent phase window.
- `jdk.ShenandoahEvacuationInformation`: records CSet region counts, used-before/after bytes, and free regions after evacuation (from `shenandoahTrace.cpp:32`). No CPU utilization fields — `gcuPercent`, `muPercent`, `periodSeconds` do not exist in this event.
- `jdk.ShenandoahPromotionInformation`: records promotion counts by generation and region type. **No CPU utilization fields** — `gcuPercent`, `muPercent`, and `periodSeconds` do not exist in this event. It fires once per collection, not per GC phase window.
- `jdk.GarbageCollection`: records GC completion with cause and duration. Duration is the STW pause only; it does not capture GCU% across the full concurrent phase. The ratio `jdk.GarbageCollection.duration / inter-GC interval` is a crude approximation of pause-fraction, not the `gcuPercent` (which includes concurrent GC threads).
- `jdk.ShenandoahHeapRegionStateChange`: fires when a region transitions between `Empty`, `Regular`, `HumongousStart`, `HumongousContination`, `CSet`, `Pinned` etc. states — fine-grained region lifecycle events. No time-fraction breakdown; no `gcuPercent`, `muPercent`, or `periodSeconds` fields. This event tracks individual region state changes, not aggregate GC CPU consumption across a phase window.
- No existing JFR event captures the `ShenandoahMmuTracker` `gcuPercent`/`muPercent` data. The `ShenandoahMmuTracker` object fields (`_most_recent_gcu`, `_most_recent_mu`, `_most_recent_timestamp`, `_active_processors`) have no representation in any existing `jdk.Shenandoah*` JFR event. Without `jdk.ShenandoahMMU`, GC CPU overhead in a Shenandoah JVM is entirely unquantifiable from JFR — the only substitute is `-Xlog:gc,ergo=info` log parsing, which is unavailable in post-mortem JFR analysis.

#### External references

[JEP 521: Generational Shenandoah](https://openjdk.org/jeps/521) (production-ready JDK 25):

> "The generational mode introduces a GC utilization (GCU%) metric: the fraction of wall-clock time spent in GC work, measured across each collection phase."

For concurrent collectors like Shenandoah, traditional pause-time metrics undercount GC overhead: most GC work is concurrent (not a pause). GCU% captures the total CPU overhead. `jdk.ShenandoahMMU` is the only way to observe this metric in JFR; without it, operators can only see pause times from `jdk.GarbageCollection`, not the concurrent GC CPU overhead.

#### Open questions / upstream concerns

1. **Resolved**: Drop the `isPeriodicSample=true` path from the initial proposal. `report()` at [`shenandoahMmuTracker.cpp:156`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahMmuTracker.cpp#L156) is `log_debug(gc)` — the periodic snapshot is debug-tier data. The initial proposal should cover only the end-of-cycle `update_utilization()` path (info-level). The `isPeriodicSample` field can be dropped from the initial event definition.
2. **Resolved**: `gcId` from `_most_recent_gcid` is reliable. The `gcid` parameter is passed by each `record_*` caller at cycle end: `record_young(gcid)`, `record_global(gcid)`, `record_full(gcid)`, etc. — see [`shenandoahMmuTracker.cpp:112-153`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahMmuTracker.cpp#L112). The value is set to the ID of the collection that just completed, not a stale value from a prior cycle. Note: `record_old_marking_increment()` deliberately does NOT call `update_utilization()` — old-marking increments are rolled up into the next full-cycle report.
3. **Resolved**: Should the event merge with `jdk.ShenandoahCollectionDecision`? No: they fire at opposite ends of the GC cycle (start vs. end), carry non-overlapping fields, and are on different threads. Merging is not technically feasible without a data-accumulation struct across the full GC lifetime.

---

### 4. jdk.ShenandoahCollectionDecision

#### Verdict

**Propose with caveats.** The redesign path is resolved: propose `jdk.ShenandoahCollectionDecision` as a base-fields-only event from a single emission point (`service_concurrent_normal_cycle()`, control thread), then file `jdk.ShenandoahGCTrigger` as a separate follow-up carrying the trigger-specific nullable fields from `log_trigger()` (regulator thread). The split keeps each event on a single thread, avoids the nullable-field explosion of the combined design, and gives upstream a tractable first PR. Drop `decision` from the initial submission (always `"normal"` at the sole emission point — carries zero information). The base-fields event (`generation`, `cause`, `available`, `softMaxCapacity`) is clean and ready to file.

#### The question it answers

"Why did Shenandoah start a GC cycle, which generation was targeted, and what triggered it?"

No existing JFR event captures Shenandoah's control-thread FSM decisions. `jdk.GCHeapSummary` and `jdk.ShenandoahHeapRegionStateChange` show sizes and region states after the fact; neither captures the heuristic reasoning. Without this event, an operator seeing frequent GC in a JFR recording cannot determine whether GC is triggered by allocation rate pressure (`rate_average`), a momentary burst (`rate_momentary`), old-gen fragmentation, or old-gen growth — four conditions with different root causes and different tuning responses. The `available` field also reveals how much headroom remained when the decision fired, which cannot be derived from post-GC heap summaries.

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

| Field | Source | Nullable? | Tuning use |
|---|---|---|---|
| `startTime` | Standard JFR | No | GC cycle start timestamp. Correlate with `jdk.ShenandoahMMU` (end-of-cycle) to measure the full cycle wall time. The gap between consecutive `startTime` values shows inter-cycle allocation time. |
| `decision` | `gc_mode_name(gc_mode())` from `ShenandoahGenerationalControlThread` at [`shenandoahGenerationalControlThread.cpp:765`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahGenerationalControlThread.cpp#L765): `"idle"`, `"normal"` (concurrent normal), `"degenerated"` (STW degenerated), `"full"` (STW full), `"old"` (servicing old), `"bootstrap"` (bootstrapping old). **RECOMMENDED TO DROP from initial proposal** — at the `service_concurrent_normal_cycle()` emission point this is always `"normal"`. The field carries no information in its initial form. Re-add in a follow-up when multi-site emission is implemented (see open question 3). | No | **Drop from initial proposal.** At the sole emission point (`service_concurrent_normal_cycle()`), this value is always `"normal"` — carrying zero information. Future multi-site emission (OQ3) would expose `"degenerated"` / `"full"` / `"old"` / `"bootstrap"` — those values ARE diagnostic. When that follow-up lands: `"degenerated"` and `"full"` = STW fallback modes; `"old"` / `"bootstrap"` = old-gen servicing active. Use `generation` field to distinguish young/old/global within the initial normal-cycle path. |
| `generation` | `"Young"` / `"Old"` / `"Global"` | No | **Per-value semantics**: `"Young"` = young-gen concurrent GC, the steady-state normal path; high frequency relative to `"Old"` is expected and healthy. `"Old"` = old-gen collection running (mixed or concurrent old marking); seeing this with `triggerType=growth` means old gen is accumulating live objects faster than promotions die out; with `triggerType=fragmentation` = old gen is becoming dense with small holes. `"Global"` = full-heap concurrent GC (non-generational or emergency-escalated path); rarely fires in steady generational mode; if it fires repeatedly, the generational heuristic is not preventing full-heap collections — check `triggerType` alongside. The ratio of `"Young"` to `"Old"` events indicates young-gen GC frequency relative to old-gen collection frequency; if `"Young"` events appear without any `"Old"` for hundreds of cycles, old-gen collection may have stalled. |
| `cause` | `shenandoah_concurrent_gc` / `metadata_GC_threshold` / `alloc_failure` / etc. from `GCCause` enum | No | **Urgency indicator**: `shenandoah_concurrent_gc` = normal heuristic-driven cycle (healthy). `alloc_failure` = urgent: an allocating thread stalled waiting for GC to free space; if frequent, heap is undersized for this allocation rate — increase `-Xmx`. `metadata_GC_threshold` = metaspace pressure, not heap exhaustion — caused by high-rate class loading, OSGi hot-swap, or reflection-heavy code generating proxy classes; action: `-XX:MetaspaceSize` / `-XX:MaxMetaspaceSize`, or reduce class generation if OSGi or cglib-based. |
| `available` | Available bytes at decision time (mutator free partition) | No | Available mutator-free bytes at GC start. Fill fraction = `1 - available/softMaxCapacity`. **Interpretation**: > 30% fill = healthy headroom; 70–90% fill = heuristic triggered reactively but within normal range; > 90% fill (< 10% available) = heuristic triggered very late, allocation nearly stalled. **Action**: `available` consistently < 10% of `softMaxCapacity` → raise `ShenandoahMinFreeThreshold` (default 10%) or increase `-Xmx`. If `triggerType=alloc_failure` appears alongside, heap is critically undersized. |
| `softMaxCapacity` | Soft max capacity in bytes (`-XX:SoftMaxHeapSize`); if unset, equals `-Xmx` | No | **Heap ceiling in use**: `1 - available/softMaxCapacity` = utilization at GC start. `SoftMaxHeapSize < Xmx` means the JVM is voluntarily using less heap than the physical limit — common in container environments where GC wants to stay under RSS limits. If `available` is consistently low but `softMaxCapacity << Xmx`, the effective limit is the soft max, not the hard max — raising `-XX:SoftMaxHeapSize` (or `-Xmx` if they are equal) gives GC more room before triggering. |

**Source** ([`shenandoahGenerationalControlThread.cpp:765-773`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahGenerationalControlThread.cpp#L765)):
```cpp
const char* ShenandoahGenerationalControlThread::gc_mode_name(GCMode mode) {
  case none:              return "idle";
  case concurrent_normal: return "normal";    // Young OR Old concurrent collection
  case stw_degenerated:   return "degenerated"; // STW fallback (GC failed concurrently)
  case stw_full:          return "full";        // Full compacting GC
  case servicing_old:     return "old";         // Old-gen collection thread running
  case bootstrapping_old: return "bootstrap";   // Young + old bootstrap phase
  case stopped:           return "stopped";     // Control thread exiting
}
```

**Adaptive heuristic fields** (null for non-adaptive heuristics):

| Field | Source | Nullable? | Tuning use |
|---|---|---|---|
| `marginOfError` | `_margin_of_error_sd` from `ShenandoahAdaptiveHeuristics` — standard deviations added to the predicted GC duration as a safety buffer | Yes | **Calibration indicator**: higher `marginOfError` = heuristic is uncertain about GC duration and is triggering conservatively (earlier than strictly necessary). It increases after back-to-back degenerated GCs or high-variance cycle durations and decreases after smooth consecutive concurrent cycles. **Monitoring**: growing `marginOfError` trend over tens of cycles = GC duration variance is increasing (workload is becoming less predictable); investigate JIT warmup, metaspace growth, or class unloading cycles adding variable overhead. **Interaction with other triggers**: `marginOfError` affects only the `rate_average` and `rate_accelerated` triggers via `anticipatedGcDurationMs`; a high `marginOfError` makes these triggers fire earlier, effectively increasing young-gen collection frequency. If the allocation rate is healthy but collections are frequent, a high `marginOfError` is causing pre-emptive GCs — the value will self-correct as cycles become more consistent; no flags can tune `marginOfError` directly (it is purely algorithmic). |
| `triggerType` | `"rate_average"` / `"rate_momentary"` / `"rate_accelerated"` / `"fragmentation"` / `"growth"` / `"expansion_failure"` / `"min_free"` / `"learning"` / `"pending"` / `"other"` | Yes | **Per-value tuning**: `"rate_average"` = steady allocation pressure; if `anticipatedGcDurationMs` is increasing over consecutive cycles, GC is getting slower relative to headroom. `"rate_accelerated"` = allocation is spiking (acceleration detected); short-lived if workload phases are normal; sustained = new persistent allocation source. `"rate_momentary"` = single-cycle spike, transient; usually harmless. `"fragmentation"` = old gen is fragmenting (`fragmentationDensityPct` populated); lower `-XX:ShenandoahOldGarbageThreshold` to collect more regions. `"growth"` = old gen has grown significantly since last marking; compute `(currentUsageBytes - liveAtPrevMarkBytes) / liveAtPrevMarkBytes × 100`; high growth rate = promotions accumulating without reclamation. `"expansion_failure"` = heap cannot grow beyond current size; check `currentUsageBytes` vs `-Xmx`; OOM imminent. `"min_free"` / `"learning"` / `"pending"` = non-heuristic triggers (floor violation, warm-up, pending degeneration) — rare in steady state; `"learning"` is normal during the first few hundred cycles after startup. |
| `anticipatedGcDurationMs` | ms; rate triggers only — `rate.duration_seconds() * 1000` | Yes | How long the heuristic predicted this GC would take, used to project future heap consumption during GC execution. If `anticipatedGcDurationMs` is increasing over consecutive cycles, GC is taking longer — the heuristic is learning. **Cross-field use**: `baselineConsumptionBytes = baselineRate × anticipatedGcDurationMs/1000`; if `anticipatedGcDurationMs` is large (> 500ms) and `available` is already low, allocation stalls during this GC are likely. Sustained growth of `anticipatedGcDurationMs` indicates a workload getting harder to collect — check live set size growth. |
| `baselineConsumptionBytes` | `rate.baseline_consumption()` = `baseline_rate × anticipated_duration`; rate_average trigger only — the bytes expected to be consumed at the average allocation rate during this GC | Yes | **Budget the trigger is protecting against**: at trigger time, the heuristic concluded that `allocatable_bytes` (derived from `available`) would be exhausted by the time GC finishes if GC starts now. `baselineConsumptionBytes ≈ allocatable_bytes` confirms the trigger fired at the correct threshold. If `baselineConsumptionBytes >> available`, the rate is high relative to headroom — allocation pressure is severe. Cross-reference: `baselineConsumptionBytes / anticipatedGcDurationMs` = the average allocation rate in bytes/ms that the heuristic measured; compare across cycles to detect rate acceleration. |
| `fragmentationDensityPct` | Density = `used / used_regions_size`; fragmentation trigger only | Yes | Density at the time the fragmentation trigger fired. Low density (< 50%) = live objects spread sparsely across many regions, many empty holes that cannot be reused because they are between live objects. **Action at trigger time**: old gen collection is already starting — the density reading explains why. After collection, compare the density in subsequent events: if density recovers to > 70% following old-gen mixed GCs, compaction is working. If density stays below 50% across multiple consecutive `generation="Old"` events, old gen is fragmenting faster than mixed GC can compact it — lower `ShenandoahOldGarbageThreshold` to include more regions as mixed GC candidates (more aggressive reclamation). |
| `fragmentedFreeBytes` | `used_regions_size - used` — free bytes spread across sparsely occupied old-gen regions; fragmentation trigger only | Yes | Bytes that are nominally "free" but inaccessible for new allocations because they exist as small holes between live objects within old-gen regions. This is not allocatable headroom — it requires compaction before it can be reused. **Severity gauge**: `fragmentedFreeBytes / totalOldGenSize × 100` = fragmentation waste percentage. > 20% = significant fragmentation; > 40% = severe, compaction will take multiple old-gen cycles. If `fragmentedFreeBytes` is large but `availableRegions` in `jdk.G1CollectionSetCandidates` (analogous) is low, old gen lacks cleanly-reclaimable regions — the collection must evacuate and compact rather than simply reclaim. |
| `liveAtPrevMarkBytes` | Live bytes at end of last old marking completion; growth trigger only — the baseline from which current usage growth is measured | Yes | **Growth-rate baseline**: `growthRate = (currentUsageBytes - liveAtPrevMarkBytes) / liveAtPrevMarkBytes × 100%`. The trigger fires when this rate exceeds the internal growth threshold (source: `_growth_trigger` in `shenandoahOldHeuristics.cpp`). **Actionability**: if `growthRate > 50%`, old gen is growing very rapidly since the last old-GC cycle — promotions are exceeding reclamation. Action: lower `ShenandoahOldGarbageThreshold` to collect more old-gen regions per cycle, or increase old-GC frequency. If `liveAtPrevMarkBytes` itself is growing across multiple events (each new baseline is higher than the last), the live set in old gen is accumulating over time — a long-term trend that requires either reducing live set at the application level or increasing `-Xmx`. |
| `currentUsageBytes` | Current old gen usage in bytes at trigger time; growth and expansion_failure triggers | Yes | Old gen fill level when the trigger fired. For `growth` trigger: compute growth rate as `(currentUsageBytes - liveAtPrevMarkBytes) / liveAtPrevMarkBytes × 100` — if this is above `ShenandoahOldGarbageThreshold`, old-gen reclamation is not keeping up with promotions. For `expansion_failure`: current old-gen capacity; if near `-Xmx`, heap is at the limit and OOM is imminent. |

**Mixed GC fields** (null unless mixed GC):

| Field | Source | Nullable? | Tuning use |
|---|---|---|---|
| `immediateGarbage` | Immediate garbage bytes from `prepare_for_old_collections()` — bytes from regions that are 100% garbage (no live objects) | Yes | 100%-garbage regions are collected free: they require no evacuation, just marking as free. High `immediateGarbage` = efficient old-gen reclaim with zero evacuation overhead. Low `immediateGarbage` = most old regions contain live objects and must be evacuated. If `immediateGarbage + immediateRegions×regionSize ≈ 0` consistently, old gen has no free-reap opportunity and all reclamation comes from mixed GC evacuation — GC cost per reclaimed byte is highest in this state. |
| `immediateRegions` | Immediate garbage region count — old-gen regions where all bytes are garbage; these are freed without evacuation | Yes | `immediateRegions / totalOldRegions` ratio indicates the fraction of old gen that is dead at collection time. Low ratio (< 5%) means most old-gen regions contain live data — the live set is large relative to heap size. If zero across many consecutive cycles, old gen is accumulating live data faster than it dies; long-term this leads to `triggerType=growth` firing. |
| `mixedCandidates` | Old region mixed collection candidates identified by `prepare_for_old_collections()` — regions above the garbage-density threshold for mixed GC | Yes | The pool available for mixed GC region selection. If `mixedCandidates = 0` but old gen is growing, old-gen marking has not completed or `ShenandoahOldGarbageThreshold` is set too high (no region meets the threshold). Lower `ShenandoahOldGarbageThreshold` to include more regions as candidates. |
| `mixedRegionsSelected` | Old regions actually selected for the current mixed GC from the candidate pool | Yes | **Compare to `mixedCandidates`**: if `mixedRegionsSelected << mixedCandidates`, the selection budget (`oldEvacuationBudget`) is the binding constraint — the heuristic found more regions worth collecting than it could fit in the evacuation budget. In this case, either increase `-Xmx` (more heap = more evacuation headroom), or accept more frequent old-gen cycles. If `mixedRegionsSelected ≈ mixedCandidates`, selection is not budget-constrained — all viable candidates were consumed, and old-gen reclamation is bounded by what mixed GC identified, not what it was willing to evacuate. |
| `oldEvacuationBudget` | Old gen evacuation budget in bytes — space reserved for copying live objects out of selected old-gen regions during mixed GC | Yes | **Capacity constraint**: if `oldEvacuationBudget` is small relative to `mixedCandidates × averageRegionSize`, the heuristic can only evacuate a small fraction of candidates per cycle. A consistently small `oldEvacuationBudget` relative to old-gen live data means mixed GC will require many cycles to fully reclaim identified garbage. Monitor alongside `mixedRegionsSelected / mixedCandidates` ratio. |
| `defragRegions` | Defragmentation region count — regions selected specifically to reduce old-gen fragmentation (below the garbage threshold but included for compaction benefit) | Yes | Non-zero = the heuristic is running defragmentation work in addition to reclamation. These regions cost evacuation budget without contributing proportional bytes freed. If `defragRegions` is frequently > 0 and `mixedRegionsSelected` is constrained, fragmentation reduction is competing with reclamation for the same budget — check `fragmentationDensityPct` from trigger events to assess whether the defrag work is justified by actual density improvements. |

#### Why existing events don't cover this

- `jdk.ShenandoahEvacuationInformation`: fires during CSet selection; records collection-set region counts, used-before/after, free regions, and immediate-garbage regions. **No heuristic decision fields** — only the resulting CSet composition, not why GC was triggered or which generation was targeted.
- `jdk.ShenandoahPromotionInformation`: records per-generation bytes collected and humongous/regular promotion breakdown. **No trigger or decision fields** — does not carry `generation`, `triggerType`, `available`, `cause`, `anticipatedGcDurationMs`, `marginOfError`, or any heuristic output. It answers "how much was promoted?" not "why was this collection started?".
- `jdk.ShenandoahHeapRegionStateChange`: fires after regions change state; does not capture the heuristic decision at the start of a cycle. No `generation`, `triggerType`, `available`, or `cause` fields.
- `jdk.GCHeapSummary`: records heap sizes before/after GC (`heapSpace.used`, `heapSpace.size`); does not capture why GC was started, which generation was targeted, or any adaptive heuristic output (`anticipatedGcDurationMs`, `marginOfError`, fragmentation metrics).
- `jdk.GarbageCollection`: records GC outcomes; the `cause` field carries a high-level GC cause string (e.g., `"GCInvokedWithForce"`) but not the adaptive heuristic reasoning — `triggerType`, `rate_average` vs. `rate_accelerated`, `fragmentationDensityPct`, `liveAtPrevMarkBytes`, or any of the diagnostic fields this event provides. An operator seeing only `jdk.GarbageCollection` cannot distinguish a rate-triggered GC from an expansion-failure-triggered GC.
- No existing JFR event exposes any field from `ShenandoahAdaptiveHeuristics` or `ShenandoahOldHeuristics`. The heuristic state (`_margin_of_error_sd`, `_anticipated_gc_duration_secs`, `_cannot_expand_trigger`, `_fragmentation_trigger`, `_growth_trigger`) is computed at trigger time and emitted to `-Xlog:gc=info` but has no JFR representation. The result is that JFR recordings contain no basis for answering why a Shenandoah GC cycle started — only that it did.

#### What it is used for

Shenandoah's generational heuristics make nuanced decisions — not just "heap is full, start GC" but "allocation is accelerating at this rate for this anticipated duration, and given this margin of error." Without this event, every GC start looks identical in JFR: a `jdk.GarbageCollection` event with a cause string. You cannot tell whether GC started because of a smooth allocation rate, a momentary spike, old-gen fragmentation, or a growth trigger.

**Tuning patterns**:
- `triggerType=rate_average` repeatedly with stable `anticipatedGcDurationMs` → normal steady-state allocation pressure; GC is keeping up. If `available` is also stable and above 20%, this is healthy operation — no action. If `available` is declining across consecutive events while `triggerType=rate_average` persists, allocation rate is exceeding GC reclaim rate over time; increase `-Xmx` or check for live-set growth.
- `triggerType=rate_accelerated` repeatedly → workload has frequent phase changes (many threads suddenly allocating). `anticipatedGcDurationMs` tells you how much buffer exists; if it's shrinking over time, the heap is under increasing pressure. Check `marginOfError` — a growing `marginOfError` alongside `rate_accelerated` indicates the heuristic is compensating for unpredictable GC durations by triggering earlier; reducing GC duration variance (via heap sizing) will lower `marginOfError` and reduce trigger-ahead time.
- `triggerType=rate_momentary` → a single allocation burst exceeded the headroom; not a sustained rate issue. If it appears only occasionally, no action needed. If it appears on every cycle, the young gen is too small to absorb burst allocations — increase `ShenandoahMaxYoungGenPercent`.
- `triggerType=fragmentation` with growing `fragmentationDensityPct` → old gen is becoming sparser; lower `-XX:ShenandoahOldGarbageThreshold` (default 25%, i.e., collect regions with > 25% garbage) — but be careful: setting it too low forces collection of nearly-live regions, increasing GC work per old cycle. If `fragmentationDensityPct` is declining across subsequent old-GC cycles, old-gen compaction is working. If it stays below 50% despite repeated old GCs, fragmentation is structural — objects are scattered across many regions and GC cannot compact them because they are all live; the only recourse is increasing `ShenandoahUnloadClassesFrequency` to release class-backed objects, or increasing `-Xmx` to give GC more regions to work with.
- `triggerType=growth` with `currentUsageBytes` >> `liveAtPrevMarkBytes` → compute `(currentUsageBytes - liveAtPrevMarkBytes) / liveAtPrevMarkBytes × 100%` for growth rate. > 50% = very rapid old-gen accumulation; increase old-gen GC frequency by lowering `ShenandoahOldGarbageThreshold` or reducing `ShenandoahMaxYoungGenPercent` to reduce promotion rate. If `liveAtPrevMarkBytes` itself grows across multiple events, the live set is accumulating long-term — the live set is genuinely growing and only `-Xmx` increase or application-level object retention reduction helps.
- `triggerType=expansion_failure` → old gen cannot expand (heap at `-Xmx`). Compute `currentUsageBytes / softMaxCapacity × 100%` — if > 95%, OOM is imminent within the next few GC cycles. Primary action: increase `-Xmx`. If `-Xmx` cannot be increased (container limit), check whether `SoftMaxHeapSize` is set below `-Xmx` — raising it gives more headroom without changing the container limit. This is the most urgent trigger type; any subsequent degenerated GC with `goodProgress=false` in `jdk.ShenandoahReclaimProgress` will escalate directly toward Full GC.
- `generation="Old"` firing frequently with `triggerType=growth` → old-gen collections are being triggered by growth, not fragmentation; check `liveAtPrevMarkBytes` trend — if it is increasing across cycles, promotions are outpacing reclamation. Action: raise old-gen IHOP to trigger old marking earlier, or reduce `ShenandoahMaxYoungGenPercent` to constrain young-gen size and reduce promotion rate.
- `generation="Young"` with `triggerType=rate_average` alternating with `generation="Old"` with `triggerType=fragmentation` in consecutive cycles → young GC running frequently due to allocation pressure while old gen fragments; old collections aren't keeping up. Check whether `immediateGarbage` is near zero (old gen has no free regions) and `mixedRegionsSelected << mixedCandidates` (budget is limiting collection).
- Frequent `goodProgress=false` in `jdk.ShenandoahReclaimProgress` following a `generation="Young"` collection → young-gen degenerated GC is not making progress; escalation to full GC is building. Cross-reference `badProgressCount` — at value 2, the next non-progress degenerated GC triggers Full GC.

**Cross-event correlation**: join `jdk.ShenandoahCollectionDecision` with `jdk.ShenandoahMMU` on `gcId` to compare the GC start conditions (available headroom, triggerType) against the CPU overhead of the resulting cycle (gcuPercent). A `triggerType=rate_accelerated` event followed by a young GC with high `gcuPercent` (> 20%) confirms the burst caused both an early trigger and elevated CPU cost; a `triggerType=rate_average` event with high `gcuPercent` means GC is running at normal frequency but consuming disproportionate CPU — a fragmentation or live-set efficiency problem rather than a sizing problem. Join with `jdk.ShenandoahReclaimProgress` on `gcId` when the cycle degenerates (degenerated or full GC events share `gcId` with the originating collection decision): `failedDimension` + `badProgressCount` from ReclaimProgress identifies whether the cycle triggered by a given `triggerType` made progress or began the escalation chain. Join with `jdk.GarbageCollection` on `gcId` to get the actual GC duration alongside the trigger condition: `triggerType=expansion_failure` followed by a long GC duration confirms the old gen was under maximum pressure; `triggerType=rate_average` followed by a short GC duration indicates GC is proactively collecting well before pressure peaks.

#### External references

[JEP 521: Generational Shenandoah](https://openjdk.org/jeps/521) (production-ready JDK 25):

> "The adaptive heuristics predict when the next GC must start, based on current allocation rates, anticipated GC duration, and a margin-of-error adjustment."

The three young-gen trigger types (`rate_average`, `rate_momentary`, `rate_accelerated`) and three old-gen trigger types (`expansion_failure`, `fragmentation`, `growth`) from JEP 521's adaptive heuristics are directly captured in `triggerType`. Without this event, the `-Xlog:gc=info` trigger messages (via `ShenandoahHeuristics::log_trigger()` → `log_info(gc)`) are the only production way to observe these decisions.

#### Open questions / upstream concerns

1. **Resolved: accumulate via struct for multi-site fields.** This event spans `service_concurrent_normal_cycle()` (control thread), `log_trigger()` (regulator thread), and `prepare_for_old_collections()` (old heuristics). The standard HotSpot approach is a thread-local or GC-cycle-scoped struct populated across the call chain and emitted at the control thread site. However, the initial proposal avoids this complexity by splitting the event (see OQ2).
2. **Resolved: split into base event + separate trigger event.** `jdk.ShenandoahCollectionDecision` carries `startTime`, `gcId`, `generation`, `cause`, `available`, `softMaxCapacity` (always-present base fields, single emission point in control thread). `jdk.ShenandoahGCTrigger` is a separate proposed event emitted from `log_trigger()` in `ShenandoahHeuristics` and carries: `gcId` (join key), `triggerType`, and the type-specific nullable fields. The split avoids the multi-thread emission problem by keeping each event on a single thread. For the initial upstream submission, propose `jdk.ShenandoahCollectionDecision` alone (base fields); file `jdk.ShenandoahGCTrigger` as a follow-up once the base event is accepted.
3. **Resolved: drop `decision` field from initial proposal.** At the sole emission point (`service_concurrent_normal_cycle()`), `decision` is always `"normal"` — carrying zero information. The `generation` field already distinguishes young/old/global within the normal cycle path. Drop from the initial proposal; re-add as a `gcMode` enum field in the follow-up once multi-site emission (OQ1) is implemented.

---

### 5. jdk.ShenandoahReclaimProgress

#### Verdict

**Propose with caveats.** Use the simplified 5-field version for the initial upstream submission (`startTime`, `freePercent`, `goodProgress`, `failedDimension`, `badProgressCount`). The 12-field full version with nullable dimensions will receive pushback. `badProgressCount` is the single most actionable field and must be present in any version.

#### The question it answers

"Did the last degenerated or full GC make sufficient progress to avoid escalation?"

`ShenandoahMetricsSnapshot::is_good_progress()` assesses four dimensions after a degenerated or full GC: free space, used space freed, internal fragmentation, and external fragmentation. If two consecutive degenerated GCs fail this check, the policy escalates to Full GC. There is no JFR event today that exposes this progress assessment or the escalation counter. Without it, `badProgressCount` incrementing from 0 → 1 → 2 is invisible — the only observable symptom is a Full GC appearing after two degenerated GCs, with no indication that the prior degenerated GCs had already failed progress checks. This event makes the escalation chain observable one step earlier, giving operators a chance to act before the Full GC fires.

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

**Exact evaluation logic** ([`shenandoahMetrics.cpp:38-90`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahMetrics.cpp#L38)):

```cpp
// shenandoahMetrics.cpp:38
bool ShenandoahMetricsSnapshot::is_good_progress() const {
  const size_t free_actual = _free_set->available();
  const size_t free_expected = (soft_max_capacity / 100) * ShenandoahCriticalFreeThreshold;
  const bool prog_free = free_actual >= free_expected;
  log_info(gc, ergo)("%s progress for free space: ...", prog_free ? "Good" : "Bad", ...);
  if (!prog_free) {
    return false;           // Hard gate: no further evaluation
  }

  const size_t progress_actual = (_used_before > used_after) ? _used_before - used_after : 0;
  const size_t progress_expected = ShenandoahHeapRegion::region_size_bytes();
  const bool prog_used = progress_actual >= progress_expected;
  log_info(gc, ergo)("%s progress for used space: ...", prog_used ? "Good" : "Bad", ...);
  if (prog_used) { return true; }   // Short-circuit success

  const double if_actual = _if_before - _free_set->internal_fragmentation();
  const double if_expected = 0.01;  // 1%
  const bool prog_if = if_actual >= if_expected;
  log_info(gc, ergo)("%s progress for internal fragmentation: ...", prog_if ? "Good" : "Bad", ...);
  if (prog_if) { return true; }     // Short-circuit success

  const double ef_actual = _ef_before - _free_set->external_fragmentation();
  const double ef_expected = 0.01;  // 1%
  const bool prog_ef = ef_actual >= ef_expected;
  log_info(gc, ergo)("%s progress for external fragmentation: ...", prog_ef ? "Good" : "Bad", ...);
  if (prog_ef) { return true; }     // Short-circuit success

  return false;   // Free passed but none of used/if/ef showed improvement
}
```

Free space (`free_actual >= free_expected`) is a **hard prerequisite** — if it fails, no further dimensions are checked and the function immediately returns `false`. If free space passes, the function returns `true` on the first of used_space, internal_frag, or external_frag that passes. Only if all three subsequent dimensions also fail does the function return `false`.

This means:
- `goodProgress=false, failedDimension=free_space` → free was below critical threshold; used/frag not evaluated
- `goodProgress=false, failedDimension=all_secondary` → free passed, but used_space, internal_frag, AND external_frag all failed
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
| `startTime` | Standard JFR | No | Timestamp of `is_good_progress()` evaluation — fires after degenerated or full GC completes. Correlate with `jdk.GarbageCollection` on the same `gcId` to see the GC cause, duration, and heap sizes alongside the progress assessment. |
| `freePercent` | `free_actual * 100 / soft_max_capacity` — available bytes in mutator partition / soft max | No | Threshold: `ShenandoahCriticalFreeThreshold` (default 1%). At `freePercent < 1%`, the free-space hard gate fails and `failedDimension="free_space"` fires. `freePercent` between 1–3% is the danger zone — a single allocation burst can cross the gate. `freePercent < 0.5%` = OOM is imminent; increase `-Xmx` or reduce live set immediately. `freePercent > 10%` on a `goodProgress=false` event means the problem is compaction quality, not heap capacity — `failedDimension` will be `"all_secondary"`. |
| `goodProgress` | Boolean result of `is_good_progress()` — `true` if the degenerated GC passed at least one of the three progress checks | No | `true` = `_consecutive_degenerated_gcs_without_progress` was reset to 0; escalation chain is cleared. `false` = this degenerated GC did not improve heap state; `badProgressCount` is incremented. Both values are actionable: `true` confirms the degenerated GC was productive and no escalation risk remains; `false` starts the escalation countdown. |
| `failedDimension` | When `goodProgress=false`: `"free_space"` if free gate failed (no further dims checked); `"all_secondary"` if free passed but used_space, internal_frag, AND external_frag all failed; `null` when `goodProgress=true` | Yes | **Failure path discriminator** — maps directly to tuning action. `"free_space"` = heap has < `ShenandoahCriticalFreeThreshold`% (default 1%) free bytes; OOM risk is real — increase `-Xmx` or reduce live set immediately. `"all_secondary"` = free space OK but GC reclaimed < 1 region of used space AND failed to improve fragmentation by ≥ 1%; GC ran but the heap state did not measurably improve — likely cause: very dense live set (little garbage to collect), or severe fragmentation that persists through GC. Action: lower `ShenandoahGarbageThreshold` (default 25%) to force collection of partially-occupied regions; if fragmentation is the issue, increase `-XX:ShenandoahUnloadClassesFrequency` to run more frequent class unloading. |
| `badProgressCount` | `_consecutive_degenerated_gcs_without_progress` from `ShenandoahCollectorPolicy`; threshold = `CONSECUTIVE_BAD_DEGEN_PROGRESS_THRESHOLD` (= 2) | No | **Escalation countdown**: 0 = all recent degenerated GCs were productive (normal). 1 = one consecutive non-productive degenerated GC — warning; the next `goodProgress=false` event will hit the threshold. 2 = threshold reached; the **next** non-successful (failed or produced `goodProgress=false`) degenerated GC will escalate to Full GC (`ShenandoahCollectorPolicy::should_start_full_gc()` returns true when `_consecutive_degenerated_gcs_without_progress >= CONSECUTIVE_BAD_DEGEN_PROGRESS_THRESHOLD`). "Non-productive" means the heap did not improve (heap state is stuck despite STW collection). **Action at count = 1**: if `failedDimension="free_space"` is the cause, increase `-Xmx` immediately; if `"all_secondary"`, investigate fragmentation or dense live set. A Full GC is expensive but necessary if degenerated GC cannot make progress — the escalation is correct behavior, but the underlying cause must be addressed. Cross-reference with `freePercent` — if `freePercent < 1%` and `badProgressCount` is rising, OOM may arrive before the Full GC can run. |

**Full version (12 fields — for reference, not for initial proposal)**:

| Field | Source | Nullable? | Tuning use |
|---|---|---|---|
| `startTime`, `freePassed`, `goodProgress` | Always present | No | Core outcome fields: `freePassed=true` means the heap had ≥ `ShenandoahCriticalFreeThreshold`% free at evaluation time (free gate passed); `goodProgress=true` means at least one secondary check also passed; the combination determines whether the degenerated GC was productive overall |
| `freeActual`, `freeNeeded` | Always present | No | `freeActual < freeNeeded` = hard gate failed; `freeNeeded = softMaxCapacity × ShenandoahCriticalFreeThreshold / 100` (default 1%). `freeActual / softMaxCapacity` = free fraction — compare against the 0.5% OOM-imminent / 1–3% danger-zone / > 10% compaction-failure thresholds from `freePercent` in the simplified event |
| `usedFreed`, `usedNeededToFree`, `usedPassed` | Null if free check failed first | Yes | Bytes reclaimed vs. 1-region threshold: `usedNeededToFree` = one region's worth of bytes (ShenandoahHeapRegion::region_size_bytes()). Low `usedFreed` = live set is dense, GC found little garbage to collect — indicates either a small live-set-to-garbage ratio or a full heap where most objects are live. If `usedFreed = 0` repeatedly, the heap contains no collectable garbage at all; the only resolution is reducing live set via application changes or increasing `-Xmx` |
| `internalFragDeltaPct`, `internalFragThresholdPct`, `internalFragPassed` | Null if earlier dimension failed | Yes | Delta in internal fragmentation (holes inside regions between live objects) since last check; threshold = 1%. `internalFragPassed=false` with low `internalFragDeltaPct` (near 0%) = fragmentation is not improving — live objects are pinning region holes in place, preventing compaction. This persists until those objects die and are collected. No direct tuning flag; increase `-XX:ShenandoahUnloadClassesFrequency` to evict stale class references that may be extending object lifetimes |
| `externalFragDeltaPct`, `externalFragThresholdPct`, `externalFragPassed` | Null if earlier dimension failed | Yes | Delta in external fragmentation (ratio of small free chunks to total free bytes, counting only completely-free regions vs. partially-occupied); threshold = 1%. `externalFragPassed=false` = the collection did not coalesce free space into fully-free regions, likely because the regions still contain a few live objects blocking full reclaim. Reduce `ShenandoahGarbageThreshold` to allow evacuating and reclaiming partially-occupied regions more aggressively |

#### What it is used for

A degenerated GC is Shenandoah's first-tier fallback: when a concurrent GC fails to keep up, the JVM falls back to a stop-the-world degenerated GC. If that too fails to make progress (e.g., heap is full and fragmented), the JVM escalates to Full GC (compacting, much longer pause). This event tells you **whether each fallback GC was productive**, and gives you an early warning of the escalation chain: `badProgressCount=1` means one consecutive failure, `badProgressCount=2` means the next failure triggers Full GC.

**Tuning actions per `failedDimension`**:
- `free_space`: heap free bytes are below `ShenandoahCriticalFreeThreshold` (default 1% of soft max). This is the hard gate — the degenerated GC ran but the heap remained critically low. Primary action: increase `-Xmx` or reduce live set. Secondary action: if live set cannot be reduced, lower `ShenandoahCriticalFreeThreshold` slightly (e.g., from 1% to 0.5%) to make the threshold less aggressive, but this risks triggering earlier escalation on the next cycle. Check `freePercent` value — if it is > 0.5%, `ShenandoahCriticalFreeThreshold` is above what the workload actually requires (the heap had more free space than the threshold demanded but still failed the check because of the `is_good_progress()` short-circuit); if it is near 0%, OOM is genuinely imminent and only `-Xmx` increase helps.
- `all_secondary`: free space passed (heap is not critically low) but GC made no measurable improvement on any of the three secondary dimensions. This means one of three things — and the sub-dimension that failed first determines the action: (1) **Used-space failure** (`usedFreed < 1 region`): GC ran but reclaimed less than one region's worth of objects. The live set is nearly the entire heap — every region has live objects. Action: lower `ShenandoahGarbageThreshold` (default 25%) to force collection of regions with lower garbage density, enabling GC to reclaim partially-occupied regions. (2) **Internal fragmentation failure** (`internalFragDelta < 1%`): GC did not reduce internal fragmentation (wasted space inside regions). Objects are pinned into fragmented regions. Action: increase `ShenandoahUnloadClassesFrequency` to run class unloading more often — pinned class objects are a common cause. (3) **External fragmentation failure** (`externalFragDelta < 1%`): free space is spread across many small segments and GC did not consolidate it. Same root cause as internal fragmentation; same action. Note: in the simplified 5-field event, these sub-dimensions are not individually exposed — `all_secondary` covers all three. The full 12-field version distinguishes them for targeted diagnosis.

**Cross-event correlation**: join `jdk.ShenandoahReclaimProgress` with `jdk.ShenandoahCollectionDecision` on `gcId` to determine **what triggered the GC that then degenerated**. If `jdk.ShenandoahCollectionDecision.triggerType=expansion_failure` appears before a `jdk.ShenandoahReclaimProgress.failedDimension=free_space` event, the heap was already at capacity when the degenerated GC ran — `badProgressCount` escalation to 2 means Full GC is imminent and the root cause is `expansion_failure`, not fragmentation. Join with `jdk.ShenandoahEvacuationInformation` on `gcId` to see how many regions were evacuated in the degenerated GC — if `regionsEvacuated` is near 0 alongside `goodProgress=false`, the degenerated GC found no evacuatable regions at all, which confirms the `all_secondary` path. Track `badProgressCount` as a running series: count=0 after each good-progress event means the escalation counter was reset — a sequence 0→1→2 with no reset in between is the final warning before Full GC.

#### Why existing events don't cover this

- `jdk.ShenandoahCollectionDecision` (proposed): fires at the START of a cycle when the heuristic decides to begin GC; `ReclaimProgress` fires at the END of a degenerated/full GC when `is_good_progress()` is evaluated. They are not mergeable — their emission points are on different code paths (regulator thread at cycle start vs. control thread at cycle end), and `badProgressCount` only exists in `ShenandoahMetricsSnapshot`, not in the collection decision context.
- `jdk.ShenandoahEvacuationInformation`: records CSet regions, used-before/after, free regions — evacuation outcome metrics, not the progress assessment or escalation counter. It says how much was evacuated; it does not say whether the degenerated GC passed the `is_good_progress()` gate or what value `badProgressCount` holds.
- `jdk.ShenandoahPromotionInformation`: records promotion bytes per generation — no degeneration progress assessment, no free-space percentage, no escalation counter. There is no field in this event that corresponds to `freePassed`, `goodProgress`, `failedDimension`, or `_consecutive_degenerated_gcs_without_progress`.
- `jdk.GarbageCollection`: records GC completion with cause and duration; does not expose `freePassed`, `goodProgress`, `failedDimension`, or `badProgressCount`. The cause field may say `"GCInvokedWithForce"` for a Full GC but gives no diagnostic information about why it was forced.
- No existing JFR event exposes `_consecutive_degenerated_gcs_without_progress` — the counter that determines when the next degenerated GC triggers a Full GC. This counter is the single field that gives advance warning of a Full GC: when it reaches 1 (one bad-progress degenerated GC recorded), the NEXT non-progress degenerated GC will trigger Full GC.

#### External references

[JEP 521: Generational Shenandoah](https://openjdk.org/jeps/521) (production-ready JDK 25):

> "Degenerated GC is a stop-the-world fallback. If degenerated GC does not make sufficient progress (free space, memory reclaimed, or fragmentation improvement), the policy escalates to Full GC after two consecutive failures."

This escalation counter (`badProgressCount`, threshold = `CONSECUTIVE_BAD_DEGEN_PROGRESS_THRESHOLD = 2`) is exactly what `jdk.ShenandoahReclaimProgress` exposes. Without this event, the first sign of the escalation chain is the Full GC itself — by which time any tuning opportunity is already missed.

#### Open questions / upstream concerns

1. **Resolved**: use the simplified 5-field version for the initial proposal. The 12-field version with cascading nullability will receive pushback. The simplified version covers all actionable states: `goodProgress=false, failedDimension=free_space` (heap under pressure), `goodProgress=false, failedDimension=all_secondary` (compaction/fragmentation failure), and `goodProgress=true` (confirmed sufficient). Expand to the full version as a follow-up if needed.
2. `badProgressCount` at value 2 means "Full GC will be triggered next" — this is the single most actionable field. If upstream pushes back on the full event, propose just this field as an extension to `jdk.GarbageCollection`.
3. **Resolved**: the event fires for both `goodProgress=true` and `goodProgress=false`. The `is_good_progress()` function is always called after degenerated or full GC — emitting on success is as useful as emitting on failure, because it confirms the GC made progress and `badProgressCount` was reset to 0.
4. **Resolved**: `failedDimension` has two values when `goodProgress=false` (`"free_space"` or `"all_secondary"`), and is always null when `goodProgress=true`. This asymmetry is inherent in the short-circuit logic and is documented in the field table. The two failure paths map to different tuning actions (see "What it is used for").

---

### 6. jdk.ShenandoahTenuringThreshold

#### Verdict

**Propose.** Info-level source, clean 5-field design, no nullable fields, no multi-site emission complexity. Ready to file.

#### The question it answers

"What tenuring threshold did Shenandoah compute this cycle, and what are the min/max bounds in effect?"

Shenandoah generational uses a mortality-rate-based algorithm ([JEP 521](https://openjdk.org/jeps/521), production-ready JDK 25) to compute the tenuring threshold each young collection: it scans age cohorts from oldest to youngest, finds the oldest cohort with high mortality (`mortality_rate > MortalityRateThreshold`), and returns `that_age + 1` as the threshold — keeping that high-mortality cohort in young gen one more cycle before promotion. Result is clamped to `[ShenandoahGenerationalMinTenuringAge, ShenandoahGenerationalMaxTenuringAge]`. No existing JFR event exposes this per-cycle computed value.

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

**Algorithm**: `compute_tenuring_threshold()` scans from oldest cohort down to youngest. For each cohort at age `i`, it computes `mortality_rate = (prev_pop - cur_pop) / prev_pop`. If the cohort has sufficient population (> `ShenandoahGenerationalTenuringCohortPopulationThreshold`) **and** mortality rate > `ShenandoahGenerationalTenuringMortalityRateThreshold`, it returns `i + 1` as the threshold (keep that cohort in young one more cycle). If `ShenandoahGenerationalCensusIgnoreOlderCohorts` is set, the scan only goes up to the previous cycle's threshold (to avoid promotion artifacts distorting the count). Result clamped to `[ShenandoahGenerationalMinTenuringAge, ShenandoahGenerationalMaxTenuringAge]`.

**Source** ([`shenandoahAgeCensus.cpp:264-326`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahAgeCensus.cpp#L264)):

```cpp
// Starting from the oldest age cohort, scan down to find the oldest age
// with HIGH mortality. The tenuring threshold = that age + 1, meaning:
// objects that are "about to die" are kept in young gen one more cycle.
uint tenuring_threshold = upper_bound;  // default: max age (retain all in young)
for (uint i = upper_bound; i >= lower_bound; i--) {
  const size_t cur_pop  = cur_pv->sizes[i];    // objects of age i this cycle
  const size_t prev_pop = prev_pv->sizes[i-1]; // objects of age i-1 last cycle
  const double mr = mortality_rate(prev_pop, cur_pop);  // fraction that died
  if (prev_pop > ShenandoahGenerationalTenuringCohortPopulationThreshold
      && mr > ShenandoahGenerationalTenuringMortalityRateThreshold) {
    // This is the oldest cohort with high mortality.
    // Return age+1 so we do NOT prematurely promote this cohort.
    return i + 1;
  }
  tenuring_threshold = i;  // This cohort should be tenured (promote at this age)
}
return tenuring_threshold;  // clamped to [min, max]

// mortality_rate: (prev_pop - cur_pop) / prev_pop
// Returns 0.0 when cur_pop >= prev_pop ("dark matter" — objects that reappear)
```

**Interpretation**: A high mortality rate at age N means objects dying at that age — those objects do NOT need to graduate to old gen. A low mortality rate (survivors) → promote them. The threshold is set one above the oldest high-mortality cohort so that cohort gets one more young cycle before a promotion decision is made.

#### Fields

| Field | Source | Nullable? | Tuning use |
|---|---|---|---|
| `startTime` | Standard JFR | No | Timestamp of `update_tenuring_threshold()` call — fires during collection preparation, before CSet finalization. Correlate with `jdk.GarbageCollection` and `jdk.ShenandoahCollectionDecision` on the same `gcId` to get the full picture: trigger type, headroom, and the resulting tenuring threshold in one cycle. |
| `gcId` | Current young collection's GC ID — set by `GCIdMark` in `service_concurrent_normal_cycle()` before `prepare_regions_and_collection_set()` is called | No | Join with `jdk.GarbageCollection` and `jdk.ShenandoahCollectionDecision` on the same `gcId` to see which trigger caused the collection, how much headroom was available, and what tenuring threshold was computed — the full heuristic picture for one young cycle. |
| `tenuringThreshold` | New threshold (age in GC cycles) — from `compute_tenuring_threshold()` | No | Low value (e.g., 1–3) → objects promote quickly, putting pressure on old gen; high value (≥ `maxTenuringAge`) → objects linger in young gen, increasing young-gen pressure. **Oscillation** (threshold alternating between values across consecutive cycles): allocation pattern is bursty — object lifetime varies dramatically cycle to cycle. This causes young-gen collections to vacillate between aggressive and conservative promotion, leading to old-gen occupancy spikes on the aggressive passes. **Action on oscillation**: (a) if oscillation is between `minTenuringAge` and some mid-range value: the algorithm is finding high-mortality cohorts inconsistently — likely due to workload phase changes; raise `ShenandoahGenerationalTenuringMortalityRateThreshold` to make it less sensitive to transient mortality spikes; (b) if oscillation is between mid-range and `maxTenuringAge`: the algorithm alternates between seeing all-surviving objects and finding some high-mortality cohorts; the pattern is real and may reflect workload structure (some allocation waves die young, others survive); this oscillation is informational rather than pathological — check old-gen occupancy trend for impact; (c) raising `ShenandoahGenerationalMaxTenuringAge` only reduces oscillation amplitude if the high end of the oscillation is clamped at `maxTenuringAge` — otherwise it shifts the ceiling without reducing oscillation. |
| `minTenuringAge` | `ShenandoahGenerationalMinTenuringAge` flag value | No | Context: threshold is always ≥ this. If `tenuringThreshold == minTenuringAge` on consecutive cycles, the algorithm wanted to promote more aggressively but was clamped. **Consequence of clamping at min**: objects that would otherwise be promoted sooner are held in young gen, increasing young-gen pressure and potentially increasing young collection frequency. **Action**: if old-gen occupancy is stable, lower `ShenandoahGenerationalMinTenuringAge` by 1 to allow the algorithm to express its preference; verify that old-gen occupancy does not spike after the change. |
| `maxTenuringAge` | `ShenandoahGenerationalMaxTenuringAge` flag value | No | Context: threshold is always ≤ this. If `tenuringThreshold == maxTenuringAge` on consecutive cycles, the algorithm found no high-mortality cohort at any age — all objects are surviving. **Consequence of clamping at max**: long-lived objects are accumulating in young gen, surviving repeated young collections. This is a survival-pressure pattern — expect higher young-gen evacuation costs and potential promotion surges when objects eventually graduate. **Action**: if old-gen capacity is available, raise `ShenandoahGenerationalMaxTenuringAge` to delay promotion further; if old-gen is under pressure, accept early promotion by lowering `maxTenuringAge` instead, and verify that the old-gen collection frequency stays manageable. |

Fields excluded from the proposal (present at `log_debug` sites): mortality rate per-cohort, dark matter fraction. These are too detailed and at the wrong log level.

#### What it is used for

Tenuring threshold controls when objects "graduate" from young to old generation. A mis-tuned threshold causes either:
- **Too-early promotion** (low threshold): young objects that are actually short-lived get promoted to old gen, growing the old gen unnecessarily and eventually triggering old-gen collections.
- **Too-late promotion** (high threshold): long-lived objects stay in young gen longer, surviving multiple young collections and consuming young-gen space. Young-gen evacuation live-set grows as survivors accumulate; young collection frequency may increase as eden fills faster with a large live-set. When these objects eventually cross the `maxTenuringAge` clamp and do promote, they arrive in old gen in a cohort burst — a spike visible as a sudden jump in old-gen occupancy. **Actionable signal**: if `tenuringThreshold == maxTenuringAge` for 3+ consecutive cycles and old-gen occupancy is rising gradually between young collections (visible via `jdk.ShenandoahHeapRegionStateChange` old-gen region transitions), the threshold ceiling is allowing an excessive backlog to accumulate. Lower `ShenandoahGenerationalMaxTenuringAge` by 1–2 to allow earlier promotion and spread old-gen load across more cycles rather than concentrating it into a burst.

Shenandoah computes this dynamically from mortality rates, so the threshold adapts to object lifetimes automatically. This event lets you verify that the algorithm is working correctly for your workload.

**Diagnostic patterns**:

| Pattern | Meaning | Tuning action |
|---|---|---|
| `tenuringThreshold` stable at a mid-range value | Algorithm has converged; steady-state workload | No action; healthy. Record the stable value as a workload baseline — a future regression where the threshold drops or oscillates becomes immediately visible against this baseline. |
| `tenuringThreshold` oscillates between `minTenuringAge` and `maxTenuringAge` | Bursty allocation pattern — object lifetime varies cycle to cycle | Check for phase changes in application (e.g., batch bursts). Raise `ShenandoahGenerationalTenuringMortalityRateThreshold` to make the algorithm less sensitive to transient mortality spikes (higher threshold = more evidence required before treating a cohort as high-mortality = fewer threshold drops on ephemeral bursts); lowering it does the opposite — more sensitive, faster adaptation, wider oscillation. |
| `tenuringThreshold == minTenuringAge` every cycle | Clamp is binding; algorithm found high-mortality cohorts at every age and wants to promote more aggressively | **Consequence**: objects are being held in young gen longer than the algorithm thinks is optimal, increasing young-gen evacuation cost and live-set size. **Action**: lower `ShenandoahGenerationalMinTenuringAge` by 1 to give the algorithm more room; first verify that old-gen occupancy is stable — if old gen is under pressure, dropping the minimum will increase promotion rate and may accelerate old-gen fill. |
| `tenuringThreshold == maxTenuringAge` every cycle | Algorithm found no high-mortality cohort at any age; all objects are surviving with low mortality rates | Objects are genuinely long-lived and keep cycling through young gen. If old gen grows, it's because survivors eventually graduate as a cohort. **Action**: raise `ShenandoahGenerationalMaxTenuringAge` to keep objects in young gen longer (defers promotion, useful if old gen is under pressure); if young-gen live-set footprint is too large, lower it instead to accept faster promotion and verify old-gen handles the increased rate. |
| `tenuringThreshold` suddenly drops after being stable | New allocation pattern with shorter-lived objects has appeared; algorithm is adapting to new mortality rates | Normal during warm-up (first 50–100 cycles) or after a workload phase change (e.g., batch job starts, cache reload). Transient if it returns to the stable value within 20–30 cycles. If the drop persists beyond 50 cycles, it reflects a permanent workload shift — allow the new stable value to emerge before re-evaluating. |

**Cross-event correlation**: join `jdk.ShenandoahTenuringThreshold` with `jdk.ShenandoahPromotionInformation` on `gcId` to validate the threshold against actual promotion outcome — if `tenuringThreshold` drops to 1 but `promotedBytes` (from `jdk.ShenandoahPromotionInformation`) does not spike, the algorithm is reacting to a cohort with high mortality that is small in bytes; if `promotedBytes` does spike alongside a low threshold, the old gen is about to receive a burst of promotions. Join with `jdk.TenuringDistribution` (available for G1/Parallel but not directly for Shenandoah) for comparison context when running mixed-GC workloads: `jdk.TenuringDistribution` shows the age-bucket object counts that Shenandoah's mortality-rate algorithm is operating on, so the two events together give the input (distribution) and the output (threshold). Join with `jdk.ShenandoahCollectionDecision` on `gcId` — if `triggerType=growth` in the decision event and `tenuringThreshold` is at `minTenuringAge` in the tenuring event for the same cycle, the algorithm is promoting as aggressively as the clamp allows while old gen is already under growth pressure; this is the highest-risk configuration and warrants immediate heap sizing review.

#### Why existing events don't cover this
- `jdk.GarbageCollection`: records GC type, cause, and duration; has no tenuring threshold field, no mortality-rate field, no per-age-cohort analysis. The cause string is always `shenandoah_concurrent_gc` for a normal young collection — it carries no information about whether the threshold was clamped or whether the algorithm found a high-mortality cohort.
- `jdk.ShenandoahPromotionInformation`: records bytes promoted by generation and region type — the outcome of promotion decisions; does not expose the tenuring threshold or the mortality-rate computation that determined it.
- `jdk.TenuringDistribution` (G1/Parallel): records per-age-bucket object counts; exists only for G1 and Parallel GC, not Shenandoah. Even if it existed for Shenandoah, it would expose the age distribution as an input, not the computed threshold or `ShenandoahGenerationalTenuringMortalityRateThreshold` boundary that determined when to stop scanning.
- No existing JFR event exposes the `compute_tenuring_threshold()` algorithm result or the min/max clamp bounds in effect for Shenandoah. Specifically: `new_threshold` (the computed value), `min` (`ShenandoahGenerationalMinTenuringAge`), and `max` (`ShenandoahGenerationalMaxTenuringAge`) from the `log_info(gc,age)` call at `shenandoahAgeCensus.cpp:258` have no representation in any existing JFR event. `jdk.TenuringDistribution` provides age-bucket counts for G1/Parallel but not for Shenandoah, and even if it did, it would expose the input (age distribution), not the computed threshold output.

#### External references

[JEP 521: Generational Shenandoah](https://openjdk.org/jeps/521) (production-ready JDK 25):

> "Dynamic tenuring: The generational Shenandoah collector dynamically adjusts the tenuring threshold based on mortality rates observed in previous collections."

Oracle ZGC Tuning Guide — [ZGC](https://docs.oracle.com/en/java/javase/26/gctuning/z-garbage-collector1.html) (for comparison context):

> "ZGC uses a dynamic tenuring threshold to decide when to promote objects from the young generation to the old generation."

The Shenandoah algorithm uses mortality-rate analysis (`compute_tenuring_threshold()` at `shenandoahAgeCensus.cpp:264`) rather than the simple age-based threshold in G1 and Parallel GC. `jdk.ShenandoahTenuringThreshold` is the only way to observe this per-cycle computation in production.

#### Open questions / upstream concerns

1. **Resolved**: Should algorithm input fields (mortality rate, dark matter fraction) be included? No — they are exposed only at `log_debug(gc,age)` level. The initial proposal includes only the `log_info`-level output (`new_threshold`, `min`, `max`). Intermediate algorithm values (`mortalityRate` per cohort, `darkMatterFraction`) can be added in a follow-up that promotes those fields to `log_info` — that is a separate log-level promotion PR and should not block the initial event submission.
2. **Resolved**: `gcId` is the right correlation key. `GCIdMark gc_id_mark` is set in `service_concurrent_normal_cycle()` at [`shenandoahGenerationalControlThread.cpp:248`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahGenerationalControlThread.cpp#L248), before `prepare_regions_and_collection_set()` is called. `GCId::current()` returns the current young collection's ID at `update_tenuring_threshold()` time — the same ID as the `jdk.GarbageCollection` and `jdk.ShenandoahCollectionDecision` events for the same cycle.

---

### 7. jdk.ZGCTenuringThreshold

#### Verdict

**Propose with caveats.** The standalone event design is redundant with `jdk.ZYoungGarbageCollection.tenuringThreshold`. The upstream approach is a field extension: add `tenuringThresholdReason` (string: `"Promote All"` / `"ZTenuringThreshold"` / `"Computed"`) to the existing `jdk.ZYoungGarbageCollection` event. This is a one-file diff in `zTracer.cpp`, avoids duplicating the threshold value, and will receive less friction than a new event. The value `reason` exposes cannot be derived from any existing field in any existing event — it is the unique contribution. File as a standalone PR: "Add tenuringThresholdReason field to jdk.ZYoungGarbageCollection." If the upstream review requires a separate event (e.g., for timing granularity at `select_relocation_set()` vs. collection end), the existing standalone design below is the fallback.

#### The question it answers

"Why did ZGC select this tenuring threshold — was it user-pinned (`-XX:ZTenuringThreshold`), emergency-forced (`"Promote All"`), or dynamically computed?"

`jdk.ZYoungGarbageCollection` already records the per-cycle threshold value. The gap is the **selection reason**: without knowing whether the threshold came from a flag override, a `"Promote All"` emergency flush, or the dynamic algorithm, the threshold value alone cannot be interpreted correctly. A threshold of 1 could mean "strong allocation pressure drove the algorithm to 1" or "Promote All forced everything to promote immediately" — these require completely different responses.

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

**Selection logic** ([`zGeneration.cpp:704-716`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zGeneration.cpp#L704)):

```cpp
// zGeneration.cpp:704
void ZGenerationYoung::select_tenuring_threshold(ZRelocationSetSelectorStats stats, bool promote_all) {
  const char* reason = "";
  if (promote_all) {
    _tenuring_threshold = 0;        // Emergency: flush all young objects to old gen
    reason = "Promote All";
  } else if (ZTenuringThreshold != -1) {
    _tenuring_threshold = static_cast<uint>(ZTenuringThreshold);  // Admin override
    reason = "ZTenuringThreshold";
  } else {
    _tenuring_threshold = compute_tenuring_threshold(stats);      // Dynamic algorithm
    reason = "Computed";
  }
  log_info(gc, reloc)("Using tenuring threshold: %d (%s)", _tenuring_threshold, reason);
}
```

**The `"Computed"` algorithm** ([`zGeneration.cpp:719-816`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zGeneration.cpp#L719)):

```cpp
// Life expectancy: ratio of live bytes at age N+1 to age N, averaged across all ages.
// Values < 1 = generational behaviour (objects die young). Values ≥ 1 = anti-generational.
const double young_life_decay_factor = 1.0 / young_life_expectancy;

// Residency reciprocal: how small the young generation is relative to the heap.
// Small young gen → high factor → push threshold up (less benefit from promoting).
const double young_residency_reciprocal = double(soft_max_capacity) / double(young_live_total);
const double young_residency_factor = MAX2(young_residency_reciprocal, 1.0);

// Allocation pressure: ratio of new allocations to garbage collected.
// High ratio = GC struggling to keep up → use larger log base → reduce threshold (more promotions).
const double allocated_garbage_ratio = double(young_allocated) / double(young_garbage + 1);
const double young_log = MAX2(MIN2(allocated_garbage_ratio, 1.0) * 16, 2.0);  // log base in [2,16]
const double young_log_residency = log(young_residency_factor) / log(young_log);

// Final threshold = decay × log-residency, rounded and clamped.
const double tenuring_threshold_raw = young_life_decay_factor * young_log_residency;
const uint tenuring_threshold = clamp((uint)round(tenuring_threshold_raw), lower_bound, upper_bound);
```

**Interpretation**: a workload with strong generational behaviour (objects die young → high `young_life_decay_factor`) and a small young gen relative to the heap (high `young_residency_factor`) gets a **high** threshold — fewer premature promotions. A workload where the GC is struggling to keep up (high `allocated_garbage_ratio`) gets a **lower** threshold — more promotions to reduce young-gen load.

#### Fields

| Field | Source | Nullable? | Tuning use |
|---|---|---|---|
| `startTime` | Standard JFR | No | Fires during `select_relocation_set()`, before collection end — earlier than `jdk.ZYoungGarbageCollection`. Join with `jdk.ZYoungGarbageCollection` on `gcId` to correlate the selection decision (threshold + reason) with the collection outcome (duration, bytes freed, promotion bytes). The gap between this `startTime` and `jdk.ZYoungGarbageCollection.startTime` gives the duration of the relocation-set selection phase itself — if this gap is large, the ZGC selection algorithm is taking significant time. |
| `gcId` | Current young collection's GC ID — `GCIdMark` set in `ZDriverScopeMinor` before `collect()`, valid throughout the minor collection including the concurrent select phase | No | Join with `jdk.ZYoungGarbageCollection` on `gcId` to correlate the selection reason with the collection outcome (duration, bytes freed). A `reason="Promote All"` collection followed by elevated old-gen bytes in the subsequent `jdk.ZOldGarbageCollection` confirms the expected old-gen growth spike. |
| `tenuringThreshold` | Selected threshold — age in GC cycles before object is promoted. **Also present in `jdk.ZYoungGarbageCollection.tenuringThreshold`** (at collection end). Included here for context alongside `reason`; if standalone event is replaced by a field addition to `jdk.ZYoungGarbageCollection`, this field becomes redundant. | No | **Reason-specific interpretation**: for `reason="Computed"`: threshold 1–3 = aggressive promotion, puts pressure on old gen (check `jdk.ZOldGarbageCollection` frequency — if increasing, promotions are overwhelming old gen); threshold 10+ = conservative, objects linger in young gen but young-gen footprint grows; stable mid-range (4–7) = algorithm converged to a workload-appropriate value, healthy. For `reason="ZTenuringThreshold"`: any value here is the static admin override — the dynamic algorithm did not run; growing old-gen occupancy confirms the override is too high (remove `-XX:ZTenuringThreshold` and allow the computed path). For `reason="Promote All"`: threshold is 0 or 1 (all objects promoted); this is emergency mode; expect immediate old-gen occupancy spike. Cross-reference `reason` before interpreting `tenuringThreshold` — the same numeric value means very different things depending on how it was chosen. |
| `reason` | `"Promote All"` / `"ZTenuringThreshold"` / `"Computed"` — the **unique value** of this proposal; not present in any existing JFR event | No | **Key discriminator**: `"Promote All"` = memory pressure forced full flush to old gen (OOM-risk indicator; check `-Xmx` and `ZYoungGenerationSizePercent`); `"ZTenuringThreshold"` = admin flag override in effect (validate the static value is correct for current workload; remove if old-gen occupancy is growing); `"Computed"` = dynamic algorithm ran normally (use `tenuringThreshold` value to assess conservatism). A threshold of 1 means something different for each path — `reason` disambiguates whether it is a policy decision, an override, or an emergency. Use `reason` as a filter key in analysis: separate `"Promote All"` events from `"Computed"` before interpreting `tenuringThreshold` distributions. |

#### What it is used for

- **Baseline the computed threshold**: the stable threshold value is a workload fingerprint. For a latency-sensitive web service with short request lifetimes, a stable threshold of 3–5 is typical — objects that survive more than 3–5 minor collections are session state or connection-pool objects that should be in old gen. For a batch-processing workload with large intermediate result objects, a threshold of 8–12 is appropriate because many objects survive multiple batches before being discarded. Compare across deployments, canary releases, and load patterns: if the stable threshold for a service drops from 6 to 2 after a new deployment, the new code is creating more long-lived objects per request — the threshold shift is a regression signal even if no latency alarm fired yet. Also compare across JVM restarts after a code change; a persistent stable-threshold shift across restarts confirms the change altered object lifetime distribution.
- **Detect mode shifts**: `reason="Promote All"` is an emergency signal — ZGC decided to flush the young gen entirely because allocation pressure exceeded its model. This causes a spike in old-gen promotions.
- **Validate flag overrides**: if `-XX:ZTenuringThreshold` is set but `reason` shows `"Computed"`, the flag value was out of range; if `reason="ZTenuringThreshold"` on every collection, the flag is locking the threshold and the dynamic algorithm is not running.

**Diagnostic patterns by `reason`**:

| `reason` | Interpretation | Tuning action |
|---|---|---|
| `"Computed"` (stable threshold) | Algorithm converged; the life-decay factor is consistently selecting the same threshold — workload has predictable generational behavior | No tuning needed. Record the stable value as a deployment baseline: note it in runbooks alongside heap size and `ZYoungGenerationSizePercent`. A future regression where the threshold drops suddenly (towards 1) or oscillates is immediately visible against this baseline — the delta from the stable value quantifies the severity of the workload change. Compare the stable value across JVM restarts and canary deployments to catch configuration drift. |
| `"Computed"` (oscillating threshold) | Object lifetime distribution varies cycle to cycle — the log-residency computation finds different optimal thresholds each cycle | Investigate allocation bursts or workload phase changes. If old-gen occupancy is not affected, oscillation may be harmless. If old gen grows on low-threshold cycles, the bursts are promoting too many objects — increase young-gen size with `-XX:ZYoungGenerationSizePercent`. |
| `"Computed"` (threshold consistently at 1) | Strong allocation pressure: high `allocatedGarbageRatio` is forcing a low log base, pushing the computed threshold toward the minimum | Increase young-gen size with `-XX:ZYoungGenerationSizePercent`; if already at max, increase `-Xmx`. Threshold 1 means nearly all objects are being promoted each cycle — old gen will fill quickly. |
| `"ZTenuringThreshold"` | Admin override (`-XX:ZTenuringThreshold`) is active; dynamic algorithm result was overridden by the configured value | Verify the static value matches current workload. If old-gen occupancy is growing, the override is too high — it is keeping objects in young gen longer than needed, but they eventually promote in a burst. Remove `-XX:ZTenuringThreshold` entirely to re-enable dynamic adaptation; the ZGC computed value tracks actual object lifetime distribution and reacts to workload changes within a few dozen cycles. A static value set months ago for a different load pattern is almost certainly wrong. |
| `"Promote All"` | Emergency: heap exhaustion triggered a full young-gen flush to old gen — every surviving young object was promoted regardless of age | Heap is undersized for this workload. Increase `-Xmx` or raise `-XX:SoftMaxHeapSize`. If `"Promote All"` fires repeatedly, the steady-state allocation rate exceeds what the current young-gen size can absorb — also check `-XX:ZYoungGenerationSizePercent`. Expect immediate old-gen growth spike visible in `jdk.ZOldGarbageCollection`. |

**Cross-event correlation**: join `jdk.ZGCTenuringThreshold` with `jdk.ZYoungGarbageCollection` on `gcId` — `jdk.ZYoungGarbageCollection` already carries a `tenuringThreshold` field (set from `ZGeneration::young()->tenuring_threshold()` in `zTracer.cpp:104`), so the join validates that the threshold written to the trace matches what this event computed. The unique value of this event is the `reason` field — use it as a split key when analyzing `jdk.ZYoungGarbageCollection` durations: group by `reason` and compare pause time distributions between `"Computed"` (normal) and `"Promote All"` (emergency) to quantify the cost of promotion overflow. Join with `jdk.ZOldGarbageCollection` by time proximity: a `reason="Promote All"` event should be followed within 1–2 old-GC intervals by a `jdk.ZOldGarbageCollection` event — the promoted burst from `"Promote All"` fills old gen and triggers an old collection. If the delay exceeds 2 old-GC intervals, old gen has sufficient free space to absorb the burst; if old gen was already near full, the burst may trigger `jdk.ZAllocationStall` before the old GC completes.

- `jdk.ZYoungGarbageCollection`: **already has `tenuringThreshold` field** (set in `zTracer.cpp:104` to `ZGeneration::young()->tenuring_threshold()`). This is the per-collection threshold value. However, it has **no `reason` field** — an operator cannot tell whether the threshold came from a `"Promote All"` emergency, a `-XX:ZTenuringThreshold` flag override, or the dynamic computation. The `reason` field is the unique contribution of this proposal.
- `jdk.ZGCConfiguration`: records the static `-XX:ZTenuringThreshold` flag value at JVM startup. Not the per-cycle selection (which can differ from the flag when `"Promote All"` or `"Computed"` paths fire).
- No existing JFR event covers the selection reason for ZGC's per-cycle tenuring threshold. `jdk.ZYoungGarbageCollection` carries the resulting `tenuringThreshold` value but not why it was chosen (`"Computed"` vs `"ZTenuringThreshold"` vs `"Promote All"`). Without `reason`, a threshold of 1 is ambiguous: it could be normal allocation-pressure adaptation, an admin override, or an OOM-risk emergency flush — three scenarios requiring completely different operator responses.

#### External references

[JEP 439: Generational ZGC](https://openjdk.org/jeps/439) (production default since JDK 24):

> "Dynamic adaptation: ZGC resizes generations, scales GC threads, and adjusts tenuring thresholds in response to workload changes."

Oracle ZGC Tuning Guide — [ZGC](https://docs.oracle.com/en/java/javase/26/gctuning/z-garbage-collector1.html):

> "ZGC supports the `-XX:ZTenuringThreshold` flag to override the dynamic tenuring decision. Setting this to a fixed value disables the computed path."

The three selection paths (`"Promote All"`, `"ZTenuringThreshold"`, `"Computed"`) are exactly what `jdk.ZGCTenuringThreshold.reason` discriminates. Without this event, operators cannot tell whether the dynamic algorithm is running or whether a flag override or emergency promotion is in effect.

#### Why not merged with jdk.ShenandoahTenuringThreshold

Different algorithms (mortality rate analysis vs. life decay factor), different lifecycle positions (collection preparation phase vs. relocation-set selection), different GC subsystems with different field semantics. The structural mismatch outweighs the cosmetic similarity of both being "tenuring threshold" events. Merging would require either a common abstraction that fits neither well, or a confusing union of fields from both GC implementations.

#### Open questions / upstream concerns

1. **Resolved: prefer field extension to `jdk.ZYoungGarbageCollection`**. Add `tenuringThresholdReason` (string: `"Promote All"` / `"ZTenuringThreshold"` / `"Computed"`) as a new field in `jdk.ZYoungGarbageCollection`. This is the smaller change: it avoids duplicating `tenuringThreshold`, keeps the reason co-located with the threshold value, and is a single-file diff in `zTracer.cpp`. File as a standalone PR against `jdk.ZYoungGarbageCollection` with justification: "Without a reason field, a threshold of 1 is ambiguous — it could mean allocation pressure drove the dynamic algorithm to 1, or that `-XX:ZTenuringThreshold` is set, or that Promote All was forced." The standalone `jdk.ZGCTenuringThreshold` event (documented below) serves as the fallback design if timing granularity at `select_relocation_set()` is required by upstream reviewers.
2. **Resolved**: Should `reason="Computed"` be supplemented with the 3 intermediate values (`lifeDecayFactor`, `youngLogResidency`, `allocatedGarbageRatio`)? No — these are at `log_debug` level and belong in a follow-up log-level promotion PR. Excluded from the initial submission.
3. **Resolved**: `gcId` is reliable at `select_tenuring_threshold()` call time. The `GCIdMark _gc_id` field is initialized in `ZDriverScopeMinor` at [`zDriver.cpp:169`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zDriver.cpp#L169), which is constructed before `ZGenerationYoung::collect()` is called. The mark is in scope for the entire minor collection including the concurrent select phase — `GCId::current()` is valid and returns the current young collection's ID.

---

### 8. jdk.ZNMethodRegistration

#### Verdict

**Propose with caveats.** Info-level source, single emission point. However, production motivation is weak. Before filing upstream, validate that nmethod table overhead is a real production concern (e.g., collect evidence from GraalVM or other large-codebase JVM deployments where nmethod counts are high).

#### The question it answers

"Is the ZGC nmethod table growing or accumulating stale entries, and how much scan overhead does it add to each collection?"

ZGC must scan all registered nmethods every collection to find object references in compiled code. The nmethod table is a ZGC-specific structure separate from the code cache; its size directly determines per-collection scan cost. Stale (`_nunregistered`) entries are unregistered nmethods whose table slots have not yet been reclaimed — they consume scan capacity without holding live references. No JFR event currently exposes this table's state.

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

| Field | Source | Nullable? | Tuning use |
|---|---|---|---|
| `startTime` | Standard JFR | No | Timestamp of `ZStatNMethods::print()` call at the end of each ZGC generation collection. Correlate with `jdk.ZYoungGarbageCollection` or `jdk.ZOldGarbageCollection` on the same `gcId`. Watch `registeredNMethods` trend across consecutive young collections — a growing count indicates steady JIT compilation activity. |
| `registeredNMethods` | `_nregistered` — current live count from `ZNMethodTable` | No | Size of the nmethod table ZGC must scan every collection. **Typical ranges**: 5–15K for standard workloads; 20–100K+ for large JIT-heavy or polyglot (GraalVM) workloads. Correlation: if ZGC nmethod-scan phase is > 5% of collection duration, `registeredNMethods` is the likely cause — check code cache size, consider reducing JIT aggressiveness via `-XX:TieredStopAtLevel=3`, or cap code cache with `-XX:ReservedCodeCacheSize`. A steadily growing count (without class unloading) indicates ongoing JIT compilation; plateau = compilation complete. |
| `staleNMethodSlots` | `_nunregistered` — zombie entries pending table rebuild; NOT cumulative; resets to 0 after each rebuild | No | **Staleness indicator**: measures `staleNMethodSlots / registeredNMethods` ratio. Ratio > 10% = many table slots hold dead references still consuming scan capacity. Root cause: rapid nmethod eviction — deoptimization, code-cache pressure, or hot-class-reload patterns. **Action**: if ratio stays > 10% across multiple consecutive young collections, rebuild frequency is lagging: investigate deoptimization rate via `jdk.Deoptimization` events; if code-cache eviction is causing it, increase `-XX:ReservedCodeCacheSize`. If stale count never decreases to 0, rebuilds may be suppressed by GC contention — check collection frequency. |

**DROPPED field**: `tableRebuilt` — no per-cycle boolean exists in `ZStatNMethods::print()`. Adding this field would require new instrumentation in `ZNMethodTable` to record whether a rebuild occurred in the current cycle. That is a prerequisite change, not part of the base event.

#### Why existing events don't cover this

- No existing JFR event exposes nmethod registration counts for any GC. `ZNMethodTable::registered_nmethods()` (`_nregistered`) and the stale-slot count (`_nunregistered`) have no JFR representation. The nmethod table is a ZGC-specific structure separate from the code cache — it tracks only the subset of compiled methods that contain heap references (oops in compiled frames) that ZGC must scan per collection.
- `jdk.CodeCacheStatistics`: carries `entryCount`, `methodCount`, `adaptorCount`, `unallocatedCapacity` for each code heap (`codeBlobType`) — global code cache occupancy metrics. Does not expose the ZGC-specific nmethod table (`ZNMethodTable`) which is a separate data structure, nor does it expose `_nunregistered` stale slots or per-GC scan costs. Without `jdk.ZNMethodRegistration`, there is no way to determine from a JFR recording how much of a ZGC pause is attributable to nmethod scanning, nor whether stale slots from deoptimization are accumulating.

#### What it is used for

ZGC must scan all registered nmethods during each GC cycle to find object references in compiled code. A large or stale nmethod table adds scanning overhead to every collection. The `staleNMethodSlots` counter tracks zombie entries — nmethods that have been unregistered (deoptimized or evicted) but whose table slots have not yet been reclaimed by a rebuild.

A steadily growing `staleNMethodSlots / registeredNMethods` ratio suggests the table rebuild cadence is not keeping up with nmethod eviction rate. This is primarily a concern in environments with:
- Dynamic class loading/unloading (OSGi, JEE, microservices with hot class reloading)
- Large polyglot workloads using GraalVM where nmethod count is very high
- Short-lived lambda-heavy applications generating many single-use compiled methods

**Tuning actions**:
- `staleNMethodSlots / registeredNMethods > 10%` across ≥ 3 consecutive young collections → check deoptimization rate via `jdk.Deoptimization` events (each deoptimization unregisters a compiled method and leaves a stale slot); if code-cache eviction is the root cause, increase `-XX:ReservedCodeCacheSize`; if JVM TI agents (e.g., debugger, coverage tools) are redefining classes at high rate, that is the source.
- `registeredNMethods > 100K` and ZGC nmethod-scan phase visible in GC logs → investigate code cache tiers: reduce JIT aggressiveness with `-XX:TieredStopAtLevel=3` (disable C2 to reduce compiled method count at cost of peak throughput); increase code cache with `-XX:ReservedCodeCacheSize`; on GraalVM or polyglot workloads, review truffle partial evaluation producing excessive nmethod compilations.
- `staleNMethodSlots` never reaches 0 between rebuilds → the `ZNMethodTable` rebuild is either not completing or not triggering. Rebuilds occur at safepoints during GC; if the stale count grows monotonically across 10+ consecutive young collections, confirm rebuild is scheduled: check `-Xlog:gc+nmethod=debug` for "Unregister nmethod" events. If unregistrations are happening but the table is not shrinking, the rebuild trigger threshold is not being reached — this is a ZGC internals issue that warrants filing a JDK bug rather than a tuning change.

**Cross-event correlation**: join `jdk.ZNMethodRegistration` with `jdk.ZYoungGarbageCollection` or `jdk.ZOldGarbageCollection` on `gcId` to correlate `registeredNMethods` against GC pause duration — if young GC duration is growing as `registeredNMethods` grows, nmethod scanning is contributing to pause time. Join with `jdk.Deoptimization` by time window: a spike in `staleNMethodSlots` in one event followed immediately by multiple `jdk.Deoptimization` events explains the source of the stale slots — each deoptimization removes a compiled method from use but leaves its table slot until the next rebuild. Join with `jdk.CodeCacheStatistics` by `startTime` proximity: compare `jdk.CodeCacheStatistics.entryCount` (total code cache entries) against `registeredNMethods` — a large discrepancy (many code cache entries but few registered nmethods) is expected and normal, since only nmethods with heap references are registered in the ZGC table; a near-equal count indicates nearly all compiled methods contain heap references, which may inflate nmethod scan cost disproportionately.

> "ZGC must scan all registered nmethods during each GC cycle to locate object references in compiled code (oops in compiled frames). The cost of this scan grows with the size of the nmethod table."

`jdk.CodeCacheStatistics` reports aggregate code cache occupancy but gives no signal about the ZGC-specific nmethod table (which is a separate data structure). There is no existing JFR event that exposes `ZNMethodTable::registered_nmethods()` or the stale-slot count.

#### Open questions / upstream concerns

1. **Weak production motivation — concrete evidence required before upstream submission**. The `log_info(gc,nmethod)` site exists and the fields are clean, but nmethod table overhead causing production issues has no documented evidence in OpenJDK issue tracker or user-facing reports. Before filing upstream, collect at least one of: (a) a JDK bug or user report where nmethod table growth caused measurable GC overhead; (b) a profile or benchmark showing `ZNMethodTable` scanning as >1% of GC time in a real workload; (c) a GraalVM or polyglot workload case study where nmethod count reaches 50K+. Without this, upstream reviewers will ask "why do we need this?" and the answer must be more concrete than "it could be a problem." If no evidence is available, retain the proposal but keep Priority=Low and acknowledge the gap in the motivation.
2. **Resolved: emit for both young and old collections.** `ZStatNMethods::print()` fires at `ZStatPhaseGeneration::register_end()` after every ZGC generation collection. The nmethod table is shared (not per-generation), so both young and old collections contribute to scan time. Old collections are more expensive per-collection but less frequent; young collections are cheaper but frequent and cumulative. The `staleNMethodSlots` counter is most diagnostic when compared across consecutive young collections — emitting only for old would miss the per-young accumulation pattern. Keep both; correlate with `jdk.ZYoungGarbageCollection` and `jdk.ZOldGarbageCollection` by `gcId`.
3. The dropped `tableRebuilt` field: if upstream wants it, a prerequisite patch to `ZNMethodTable` is needed.

---

### 9. jdk.G1ConcurrentRefinementSweep

#### Verdict

**Propose with caveats.** The code is in the product build (not `#ifndef PRODUCT` guarded); the data is available. The `log_debug` source is a valid concern for upstream reviewers, but the argument is straightforward: refinement sweep metrics are essential for understanding G1 concurrent refinement behavior (actively redesigned across recent JDK versions) in production, and they have never been accessible without enabling debug logging. JFR changes the access model, not the data.

#### The question it answers

"Is G1's concurrent card refinement keeping up with the mutator write rate, or is it accumulating a backlog that will inflate pause times?"

G1's concurrent refinement thread processes dirty card queue entries between GC pauses. If it falls behind, the residual backlog must be drained during the next GC pause under the `G1RSetUpdatingPauseTimePercent` budget — extending pause time unpredictably. The G1 concurrent refinement subsystem has undergone active redesign across recent JDK versions, changing card-processing mechanics and throughput characteristics. Without JFR coverage, operators must enable `-Xlog:gc+refine=debug` to observe refinement dynamics — an option rarely available in production.

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
| `startTime` | Standard JFR | No | Timestamp of this refinement sweep. Consecutive `startTime` differences give the inter-sweep interval — compare against GC pause frequency to see how often sweeps run between pauses. If sweeps are very frequent (< 50ms apart) and `cardsPending` is still growing, refinement threads are looping continuously without draining the backlog — check `threadsWanted` vs. `G1ConcRefinementThreads`. Use as a join key with `jdk.GarbageCollection` events: sweeps between the same two consecutive GC pauses share the same inter-pause window; correlate their `cardsPending` trends to see whether the backlog grew, shrank, or stabilized during that window. |
| `duration` | Standard JFR (wall-clock time of the entire sweep) | No | Total sweep wall time including pre-sweep bookkeeping and card refinement. A sweep that takes longer than the inter-sweep interval means refinement threads are running continuously without pause — a saturation signal. Compare `duration` against `preSweepMs + cardRefineMs` to see whether JFR overhead accounts for the difference. |
| `preSweepMs` | Time before actual card refinement begins (snapshot, bookkeeping) | No | **Overhead ratio**: compare against `cardRefineMs`. `preSweepMs > cardRefineMs / 4` (> 25% of refinement time in setup) is elevated. Root causes: (a) lock contention acquiring the dirty-card queue — more likely under very high write rates with many mutator threads; (b) large remembered-set structures requiring expensive snapshot; (c) heap region count high (e.g., small region size with large heap). No direct tuning flag; if `preSweepMs` dominates, investigate whether `-XX:G1HeapRegionSize` is too small (more regions = more bookkeeping per sweep). |
| `cardRefineMs` | `TimeHelper::counter_to_millis(stats->refine_duration())` — CPU time spent in `refine_card_concurrently()` calls only; excludes pre-sweep bookkeeping | No | **Primary throughput metric**: `cardsNotClean / cardRefineMs` = effective refinement throughput in cards/ms. If this drops over time while `cardsNotClean` stays constant, refinement is getting slower per card — investigate lock contention or humongous-object interference. Compare against `dirtiedCardRate` from `jdk.G1ConcurrentRefinementPolicy` to see whether throughput matches the write rate. |
| `cardsScanned` | `stats->cards_scanned()` — total dirty cards examined: equals `cardsClean + cardsNotClean + cardsNotParsable + cardsNoCrossRegion + cardsStillRefersToCset` (approximately; some edge categories may differ) | No | **Denominator for all card ratios**: `cardsClean / cardsScanned` = wasted-scan fraction; `cardsNotClean / cardsScanned` = effective work fraction; `cardsNoCrossRegion / cardsScanned` = write-churn fraction. A sweep with small `cardsScanned` but large `cardsPending` = many cards arrived too late to be processed this sweep (high write rate vs. sweep cadence). Use `cardsScanned / duration` as the sweep throughput in cards/ms and compare across consecutive events to detect degradation. |
| `cardsClean` | `stats->cards_clean()` — cards already clean when scanned (no work needed) | No | **Wasted-scan ratio**: `cardsClean / cardsScanned > 50%` = more than half of scanned cards were already clean when the refinement thread arrived. Two distinct root causes: (a) **GC-phase cleanup**: the GC pause processed the same cards before the concurrent thread reached them — expected and harmless; (b) **Thread over-count**: too many refinement threads racing to process the same cards, each finding them already clean. Distinguish by comparing with `G1ConcRefinementThreads` setting — if `threadsWanted` from `jdk.G1ConcurrentRefinementPolicy` is much lower than `G1ConcRefinementThreads`, the policy is not using all available threads and the clean-card ratio reflects GC-phase cleanup (case a). If `threadsWanted ≈ G1ConcRefinementThreads` and ratio is still high, consider reducing `G1ConcRefinementThreads` to reduce redundant work. |
| `cardsNotClean` | `stats->cards_not_clean()` — cards that required actual processing (had cross-region references to update) | No | **Effective work metric**: `cardsNotClean / cardsScanned` = effective work ratio; this should be high (> 80%) for healthy refinement — if it is low (< 50%), most scanned cards were already clean or false dirty, meaning thread time is being wasted. `cardsNotClean / cardRefineMs` = refinement throughput in cards/ms; declining throughput with stable `cardsNotClean` = per-card processing is slowing (investigate object graph complexity or lock contention). Growing `cardsNotClean` across sweeps while `threadsWanted` is maxed = write rate has increased beyond refinement capacity — cross-reference `dirtiedCardRate` from `jdk.G1ConcurrentRefinementPolicy`. |
| `cardsNotParsable` | `stats->cards_not_parsable()` — cards that returned `G1RemSet::CouldNotParse` and were **re-dirtied for retry** (source: `g1ConcurrentRefineSweepTask.cpp:75-79`): the card region was in an unparsable state so the thread put the card back as dirty for next sweep. | No | **Retry-storm indicator**: a single non-zero sweep is transient and ignorable. Sustained non-zero across ≥ 3 consecutive sweeps indicates the refinement thread repeatedly encounters regions in mid-transition — typically caused by concurrent humongous object allocation (regions skip to HUMONGOUS state between scans). **Action if sustained**: confirm via `-Xlog:gc+humongous=debug`; if humongous allocation is the cause, tune `-XX:G1HeapRegionSize` upward to reduce the number of regions a humongous object spans, or reduce humongous allocations if possible. |
| `cardsNoCrossRegion` | `stats->cards_no_cross_region()` — cards where the mutator changed all cross-region references AFTER dirtying the card, making the card a false dirty. From `G1RemSet::NoCrossRegion` result: [`g1RemSet.hpp:122`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1RemSet.hpp#L122) "There is no interesting reference in the card any more. The mutator changed all references to such after dirtying the card." | No | **Write churn indicator**: `cardsNoCrossRegion / cardsScanned` > 20% = significant fraction of refinement work is wasted on cards whose cross-region references were overwritten before refinement ran (allocate-and-immediately-overwrite patterns common in producer/consumer or cache-eviction workloads). These cards consumed scan CPU without contributing to remembered-set accuracy. **Action**: this metric cannot be tuned via GC flags — it reflects application write patterns. If it dominates refinement cost, profile hot write-barrier paths in the application; reduce object graph edge churn (e.g., avoid storing cross-region references in frequently-mutated fields). Alternatively, accept the overhead if the write pattern is correct — the refinement thread will process and discard these cards quickly. |
| `cardsRefersToCset` | **DROPPED** — `stats->cards_refer_to_cset()`: intermediate count of newly-discovered to-CSet cards during this sweep. The actionable metric is `cardsStillRefersToCset` (cards already marked as to-CSet before this sweep, which will re-appear in the next GC pause `Update RS` phase). See open question 2. | — | Dropped |
| `cardsStillRefersToCset` | `stats->cards_already_refer_to_cset()` — cards found to be already marked as to-CSet (`G1RemSet::AlreadyToCSet` result, `g1ConcurrentRefineSweepTask.cpp:66-69`): these were previously discovered as pointing into the CSet and are being re-encountered. High count = many cards are cycling back through the refinement queue with references that still point into the collection set. | No | **`Update RS` pressure indicator**: `cardsStillRefersToCset / cardsScanned > 5%` across ≥ 2 consecutive sweeps = a significant fraction of refinement work is being re-processed for references into the CSet. These cards will be re-encountered in the GC pause `Update Remembered Set` phase, extending pause time. **Cause**: the CSet selection is including regions that have many incoming cross-region references — regions with high reference fan-in. **Action**: lower `-XX:G1MixedGCLiveThresholdPercent` (default 85%) to exclude densely-referenced regions from the CSet; this reduces `cardsStillRefersToCset` at the cost of leaving those regions in old gen longer. Alternatively, profile which regions have highest fan-in (via `-Xlog:gc+remset=debug`) and whether they can be reduced at the application level (e.g., shared caches or singletons with many pointers). |
| `cardsPending` | `stats->cards_pending()` — backlog remaining after sweep | No | **Backlog trend**: compare across consecutive sweeps. Growing monotonically over 3+ sweeps = refinement throughput is below the write rate — the backlog is accumulating. Cross-reference with `pendingCardsTarget` from `jdk.G1ConcurrentRefinementPolicy` (same metric name, same calculation) — once `cardsPending > pendingCardsTarget`, the policy will try to add more threads (`threadsWanted` increases); if `threadsWanted` is already at the max and `cardsPending` continues growing, the spill will manifest as extended `Update Remembered Set` work in the next GC pause. |

#### What it is used for

G1 concurrent refinement processes dirty card queue (DCQ) entries between GC pauses. If refinement cannot keep up, the backlog grows and must be processed during the next GC pause — extending pause time. The G1 concurrent refinement subsystem has seen active ongoing redesign; this event provides the first structured way to monitor refinement throughput in production without enabling debug logging.

**Key diagnosis**:
- `cardsPending` growing monotonically across 3+ consecutive sweeps → refinement throughput is below the write rate. **Branch on `threadsWanted` from the paired `jdk.G1ConcurrentRefinementPolicy` event**: (a) `threadsWanted < G1ConcRefinementThreads` → the policy is not using all available threads; increase `-XX:G1ConcRefinementThreads` to raise the ceiling. (b) `threadsWanted` already equals `G1ConcRefinementThreads` → the policy is at maximum thread count and the write rate genuinely exceeds concurrent refinement capacity; increasing thread count further will not drain the backlog. At this point, the only levers are: reduce cross-region write rate at the application level (profile hot write-barrier paths), raise `-XX:G1RSetUpdatingPauseTimePercent` (default 10%) to allocate a larger pause fraction to processing the backlog in-pause (accepting longer pauses), or raise `-Xmx` to space out GC pauses and give refinement more time between them.
- `cardsClean / cardsScanned` > 50% → more than half of scanned cards were already clean when the refinement thread reached them — likely a GC-phase effect where the GC pause itself processed the cards before the concurrent thread arrived, or a write-barrier false-positive that marks cards without actual cross-region writes. **Action**: if sustained, check whether `G1ConcRefinementThreads` is set too high (threads racing each other to process the same cards); reducing the count may improve actual throughput by reducing redundant work.
- `cardRefineMs / duration` consistently above 80% across successive sweeps → the refinement thread is spending nearly all sweep wall time in actual card processing, with almost no time left for `preSweepMs` bookkeeping. This means the sweep thread is saturated: every sweep is a full-utilization pass with no slack between sweeps. **Distinguish two root causes using `preSweepMs`**: (a) `preSweepMs` is low (< 10% of `cardRefineMs`) and `cardsNotClean / cardsScanned` is also low — the thread is spending most time in card-processing setup but finding few dirty cards per sweep; consider whether `G1ConcRefinementThreads` is too high (many threads racing for the same cards). (b) `preSweepMs > cardRefineMs / 4` (bookkeeping above 25% of processing time) — pre-sweep overhead dominates; check whether `-XX:G1HeapRegionSize` is too small (more regions = more bookkeeping per sweep); increasing region size reduces the per-sweep snapshot cost. In both cases, confirm saturation by checking `cardsPending` trend: saturated refinement is always accompanied by a growing backlog — if `cardsPending` is stable despite high `cardRefineMs / duration`, the thread is keeping pace (no action needed).
- `cardsStillRefersToCset` non-zero frequently → cards pointing into CSet regions are re-encountered across consecutive sweeps. This means references into the current CSet are long-lived and persistent (not short-lived). No GC tuning flag directly reduces this count; it reflects the application's object reference topology. If it causes `Update Remembered Set` pause spikes, the underlying issue is that too many live objects reference CSet candidates — check whether `G1MixedGCLiveThresholdPercent` is including regions with high reference fan-in (dense live sets). Lowering the threshold excludes such regions from the CSet, reducing future `cardsStillRefersToCset` at the cost of slower old-gen reclamation.
- `cardsNoCrossRegion / cardsScanned` high → many cards were dirtied but the references already changed before refinement ran (write churn). These cards produced no useful work. This is a sign of short-lived cross-region pointer patterns — allocate-and-overwrite patterns common in producer/consumer workloads.

**Cross-event correlation**: join `jdk.G1ConcurrentRefinementSweep` with `jdk.GarbageCollection` on `gcId` to measure the impact of pending-card backlog on actual GC pause time. When `cardsPending` at the last sweep before a GC is high (e.g., > 5× `pendingCardsTarget`), check whether the corresponding `jdk.GarbageCollection.duration` is longer than average — the excess is the cost of processing the backlog in the `Update Remembered Set` pause phase. Correlate the sweep before and after each GC: if `cardsPending` drops significantly from the pre-GC sweep to the next post-GC sweep, the GC pause itself absorbed the backlog (confirming the pause extension was caused by card processing). Join with `jdk.G1ConcurrentRefinementPolicy` by time proximity (within the same inter-GC interval) to compare `cardsPending` (observed throughput) against `threadsWanted` (policy decision) — if `threadsWanted` is increasing but `cardsPending` from consecutive sweeps is not decreasing, the predicted refine rate is too optimistic and the write rate is genuinely exceeding maximum thread capacity.

#### Why existing events don't cover this

- `jdk.G1AdaptiveIHOP`, `jdk.G1BasicIHOP`: cover old-gen occupancy threshold for initiating concurrent marking (a separate policy); carry no refinement fields whatsoever. `jdk.G1AdaptiveIHOP` contains `threshold`, `thresholdPercent`, `ihopPercent`, `recentMutatorAllocationSize`, `recentMutatorDuration`, `recentGCDuration`, and `recentOldGenAllocationSize` — none of these are dirty-card or refinement metrics.
- `jdk.EvacuationInformation`: records per-GC-pause evacuation outcome (regions evacuated, bytes copied, region counts) — fires at pause end, not between pauses. Does not carry `cardsScanned`, `cardsPending`, `cardRefineMs`, or any refinement throughput metric.
- `jdk.GarbageCollection`: records GC cause, duration, and GC ID — outcome event; no refinement data. The `duration` field in `jdk.GarbageCollection` reflects the total GC pause; it does not decompose into the `Update RS` sub-phase where card backlog processing occurs.
- No existing JFR event exposes the dirty-card queue backlog (`cardsPending`), refinement throughput (`cardRefineMs`, `cardsScanned`), or the write-churn indicator (`cardsNoCrossRegion`). These are only available via `-Xlog:gc+refine=debug`.

#### External references

Oracle JDK 26 G1 GC Tuning Guide — [Garbage-First Garbage Collector Tuning](https://docs.oracle.com/en/java/javase/26/gctuning/garbage-first-garbage-collector-tuning.html):

> "The concurrent remembered set update (refinement) work can be controlled with this option. Refinement tries to schedule work concurrently so that at most `-XX:G1RSetUpdatingPauseTimePercent` percent of the maximum pause time goal is spent in the garbage collection pause in the Update RS phase, processing remaining work."

> "An alternative to completely disabling concurrent refinement can be limiting the maximum number of refinement threads by changing the value of `-XX:G1ConcRefinementThreads`. By default, the heuristics allow G1 to use up to the number of parallel GC threads. Work exceeding the capacity of the refinement threads will spill over into the garbage collection pause."

> "The amount of `Pending Cards` relative to `Scanned Cards` determines the refinement work with the `Scan Heap Roots` phase in the garbage collection pause."

The Oracle tuning guide explicitly calls out `-XX:G1ConcRefinementThreads` and the `Pending Cards` metric as controls for GC pause time — yet those knobs are currently only observable via `-Xlog:gc+refine=debug`. `jdk.G1ConcurrentRefinementSweep` makes these observable in production JFR without requiring debug logging.

[G1 Concurrent Refinement redesign (JDK-8382089, JDK-8383794, and related)](https://bugs.openjdk.org/browse/JDK-8382089) — ongoing G1 refinement improvements: changed how the sweep state machine runs and how `no_cross_region` results are returned. The `cardsNoCrossRegion` field directly measures write-churn: cards that were dirtied but whose cross-region references were subsequently overwritten before refinement ran, producing no useful work.

#### Open questions / upstream concerns

1. **Debug-level source**: the primary question upstream will ask. The counter-argument: the `print_refinement_stats()` function is in the product build, the data IS available, and JFR is a production observability tool. The log-level is about `-Xlog` verbosity, not data availability. The precedent is `jdk.G1AdaptiveIHOP` and `jdk.G1BasicIHOP` — those also originate from `log_debug(gc,ihop)` sites but are JFR events in the JDK today. The Oracle GC Tuning Guide explicitly calls out `G1ConcRefinementThreads` and `Pending Cards` as tuning controls — yet the data behind those controls is only accessible at debug log level. JFR should provide the same data without requiring debug logging. **Recommended approach for upstream submission**: propose promoting `print_refinement_stats()` from `log_debug(gc,refine)` to `log_info(gc,refine)` as part of the same PR — this resolves the log-level concern simultaneously with adding JFR coverage. The promotion is justified by the same Oracle tuning guide references that motivate the JFR event.
2. **Resolved**: keep `cardsNotParsable` (renamed from "Consider dropping" — it is a retry-storm indicator and the only signal for `CouldNotParse` card results). Drop `cardsRefersToCset` — it is an intermediate discovery count; `cardsStillRefersToCset` is the actionable metric. Both decisions reflected in the fields table.
3. **Resolved: link to refinement redesign RFE** — the JFR RFE should reference JDK-8382089/JDK-8383794 as the context for the redesign. The sweep state machine changes in those RFEs reduced observability by removing the old per-thread card-count logs. This event restores structured observability in JFR form.

---

### 10. jdk.G1ConcurrentRefinementPolicy

#### Verdict

**Propose with caveats.** Same debug-level caveat as `jdk.G1ConcurrentRefinementSweep`. Consider proposing both refinement events in the same RFE/PR since they are complementary.

#### The question it answers

"How many refinement threads does G1 want, and is the pending-card target being met?"

`G1ConcurrentRefinementSweep` captures per-sweep throughput; `G1ConcurrentRefinementPolicy` captures the adaptive policy that decides how many threads to run and whether the system is keeping up with the dirtied-card rate. Together they provide complete visibility into G1 concurrent refinement. Without this event, `threadsWanted` — the output of the control loop that directly determines whether refinement keeps pace with mutator writes — is invisible. When `threadsWanted` increases from 2 to 4 to max over successive policy decisions, that progression is the only warning before the unrefined card backlog spills into the next GC pause and extends pause time. No existing event exposes this control variable.

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
| `startTime` | Standard JFR | No | Timestamp of periodic refinement policy evaluation; fires between GC pauses (periodic path only). Correlate with surrounding `jdk.GarbageCollection` events to see the policy state in the inter-GC window |
| `threadsWanted` | `new_wanted` from `adjust_threads_wanted()` — [`g1ConcurrentRefine.cpp:610`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1ConcurrentRefine.cpp#L610). Available on the periodic path only (OQ3 recommends periodic-path-only emission). | No | **Primary output of the control loop**: desired thread count, not the actual running count. If `threadsWanted` consistently equals the max (`-XX:G1ConcRefinementThreads`), the policy is capacity-saturated — increase the flag. If `threadsWanted` is low (≤ 25% of max) but `pendingCards > pendingCardsTarget`, the model is misaligned: the write rate is higher than the policy's prediction. In this case, check `dirtiedCardRate` vs. `predictedRefineRate × threadsWanted` — if write rate genuinely exceeds modeled capacity, workload write patterns may require tuning at the application level or accepting larger card processing in GC pauses. |
| `pendingCards` | `policy->current_pending_cards()` — current total pending dirty cards from the card queue | No | Current backlog; if growing between policy ticks, refinement is falling behind. **Rate-of-growth heuristic**: if `pendingCards` increases by > 20% between consecutive periodic events (`(new - old) / old > 0.2`), the refinement threads are not draining the backlog — the queue is growing faster than it is being consumed. At this rate, `pendingCards` will exceed `pendingCardsTarget` within a few ticks. Compare to `pendingCardsTarget`: sustained `pendingCards > pendingCardsTarget` means the policy has set a target it cannot achieve with current thread count. |
| `pendingCardsFromGC` | `pending_cards_from_gc()` — cards dirtied by GC-internal operations (remembered-set rebuilding, evacuation); available on periodic path | No | Distinguishes GC-generated card traffic from mutator write traffic; `pendingCards - pendingCardsFromGC` = mutator-driven backlog. High `pendingCardsFromGC` relative to `pendingCards` (e.g., > 30%) means GC itself is the primary refinement source — a sign of heavy remembered-set work during evacuation. If `pendingCards` is high but `pendingCardsFromGC` accounts for most of it, reducing mutator cross-region writes will not help; the issue is GC-internal RS churn. In that case check `jdk.EvacuationInformation.cSetUsedBefore` — large evacuation sets generate large RS updates. The only lever is reducing CSet size via `G1MixedGCLiveThresholdPercent` or `G1OldCSetRegionThresholdPercent`. |
| `pendingCardsTarget` | `_pending_cards_target` — policy's goal for pending card count | No | **Key tuning lever**: if `pendingCards` consistently exceeds `pendingCardsTarget`, the target may need to increase or thread count is constrained. The target is derived from `_mmu_tracker->max_gc_time() × G1RSetUpdatingPauseTimePercent / 100 × predictedRefineRate` — so raising `-XX:G1RSetUpdatingPauseTimePercent` (default 10%) increases the time budget allocated to refinement, which raises the target. Raising `-XX:MaxGCPauseMillis` also increases it by giving a larger `max_gc_time()`. Do not raise `G1RSetUpdatingPauseTimePercent` above 25% — at that point, card processing dominates GC pauses and young-gen evacuation gets crowded out. |
| `predictedPendingCards` | `_threads_needed.predicted_cards_at_next_gc()` — projected backlog at the next GC pause: `num_cards + incoming_rate × predicted_time_until_next_gc`. Source: [`g1ConcurrentRefineThreadsNeeded.cpp:64`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1ConcurrentRefineThreadsNeeded.cpp#L64) | No | **Future-backlog projection**: the number the `adjust_threads_wanted()` algorithm is trying to keep below `pendingCardsTarget`. If `predictedPendingCards > pendingCardsTarget` with `threadsWanted` already at max, adding threads will not help — write rate fundamentally exceeds refinement throughput capacity. **Actions in that case**: (a) reduce cross-region write rate by profiling hot write-barrier paths in the application; (b) increase `-XX:G1RSetUpdatingPauseTimePercent` to allocate more pause budget to card processing (accepting longer pauses in exchange); (c) reduce allocation rate to space out GC pauses and give refinement more time between them. |
| `predictedRefineRate` | `analytics->predict_concurrent_refine_rate_ms()` — predicted cards/ms that the refinement threads can process, derived from historical sweep throughput | No | **Capacity side**: `predictedRefineRate × threadsWanted × timeUntilNextGC` = cards refinement expects to clear before next pause. If this is less than `pendingCards`, the backlog will spill into the GC pause and consume `Update RS` pause budget. A declining `predictedRefineRate` across events = refinement threads are getting slower per card (lock contention, region-structure changes, large RS rebuilds); investigate with `-Xlog:gc+refine=debug`. A sudden drop in `predictedRefineRate` after a G1 region-size change or humongous-allocation surge is expected — those operations invalidate many cards simultaneously, creating a burst of cards that are harder to process. |
| `dirtiedCardRate` | `analytics->predict_dirtied_cards_rate_ms()` — predicted cards/ms being dirtied by mutator writes, derived from recent write activity | No | **Demand side**: if `dirtiedCardRate > predictedRefineRate × threadsWanted`, the policy will fall behind and the backlog will grow; this is the fundamental refinement-capacity inequality. **Trend monitoring**: growing `dirtiedCardRate` across events = the application's cross-region write rate is increasing (e.g., growing object graph, new promotion-heavy allocation pattern). The policy uses this ratio to determine `threadsWanted` — a sustained high `dirtiedCardRate` will drive `threadsWanted` toward `G1ConcRefinementThreads` max. If `dirtiedCardRate` is consistently high but the application cannot reduce writes, the only tuning levers are more threads or accepting larger GC-pause `Update RS` work. |
| `goalMs` | `_pending_cards_target` time equivalent: the time window within which refinement is expected to clear its backlog, derived from `_mmu_tracker->max_gc_time() × G1RSetUpdatingPauseTimePercent/100`. On the periodic path (recommended, see OQ3): the time window the policy uses to decide how many threads are needed. | No | **Reference target**: compare `pendingCards / (predictedRefineRate × threadsWanted)` against `goalMs` — if the computed time exceeds `goalMs`, the current thread count cannot drain the backlog before the pause budget expires. `predictedRefineRate × threadsWanted × goalMs` = maximum cards clearable per goal window; if `pendingCards` exceeds this, the backlog will spill into the GC pause. **When `goalMs` is consistently too small**: the root cause is either a tight `MaxGCPauseMillis` (shrinks `max_gc_time()`) or a low `G1RSetUpdatingPauseTimePercent` (default 10%). Actions: (1) raise `G1RSetUpdatingPauseTimePercent` to allocate a larger fraction of the pause budget to card processing — each 1% increase raises `goalMs` proportionally; (2) raise `MaxGCPauseMillis` to increase the absolute pause budget, which also raises `goalMs`; (3) do NOT set `G1RSetUpdatingPauseTimePercent > 25%` — beyond that, card processing dominates the pause and evacuation is crowded out. If `goalMs` is large but `threadsWanted` is at max and the backlog still exceeds capacity, the write rate fundamentally exceeds refinement throughput; only reducing cross-region write rate at the application level will resolve it. |
| `pendingCardsTimeMs` | **DROPPED** — only available on GC-pause path which is excluded by OQ3 recommendation. Correlate with `jdk.GarbageCollection` `Update Remembered Set` phase duration instead. | — | Dropped |
| `timeUntilNextGC` | `_threads_needed.predicted_time_until_next_gc_ms()` — predicted milliseconds until the next GC pause, derived from the GC analytics model | No | Time budget for refinement: `timeUntilNextGC × predictedRefineRate × threadsWanted` = expected cards clearable before next pause; compare to `pendingCards + dirtiedCardRate × timeUntilNextGC` (total expected backlog at next GC) — if the expected clearable count is less than the projected backlog, card processing will spill into the pause. Very short `timeUntilNextGC` (< 50ms) with high `pendingCards` means nearly all backlog must be processed in-pause under `G1RSetUpdatingPauseTimePercent` budget — a GC frequency problem; increase `-Xmx` or reduce allocation rate to space out pauses. |
| `exceededGoal` | Boolean: `pendingCards > pendingCardsTarget` — pending backlog exceeds the policy's target | No | **Three-branch resolution**: (a) `exceededGoal=true` with `threadsWanted < G1ConcRefinementThreads` → policy wants more threads than available; increase `-XX:G1ConcRefinementThreads`; (b) `exceededGoal=true` with `threadsWanted` at max AND `goalMs` is small (check from same event) → the time budget for refinement is too tight; raise `-XX:G1RSetUpdatingPauseTimePercent` (each 1% increase raises `goalMs` proportionally; cap at 25%) or raise `-XX:MaxGCPauseMillis` to increase the absolute budget; (c) `exceededGoal=true` with `threadsWanted` at max AND `goalMs` is adequate → write rate fundamentally exceeds refinement throughput regardless of thread count or budget; only reducing cross-region write rate at the application level resolves this. |

#### What it is used for

Complements `jdk.G1ConcurrentRefinementSweep`: where Sweep shows per-sweep throughput, Policy shows the adaptive thread-count decision. Together they answer: "Is G1 adjusting the right number of refinement threads, and is the pending-card target realistic for this workload?"

**Concrete scenario**: Suppose `dirtiedCardRate = 500 cards/ms` and `predictedRefineRate = 200 cards/ms` with `threadsWanted = 2`. Expected clearance = 200 × 2 = 400 cards/ms — less than the dirtied rate. `pendingCards` will grow each tick, eventually exceeding `pendingCardsTarget`. The residual backlog spills into the next GC pause for processing under the `G1RSetUpdatingPauseTimePercent` budget (default 10% of pause time). This event exposes the imbalance in real time; without it, the symptom is unexplained pause-time variance with no apparent cause in GC logs below `debug` level.

**Key patterns**:
- `threadsWanted` at maximum and `pendingCards > pendingCardsTarget` AND `goalMs` too small → raise `-XX:G1RSetUpdatingPauseTimePercent` (controls refinement time budget, default 10%; cap at 25%) or raise `-XX:MaxGCPauseMillis`; if `goalMs` is adequate but write rate exceeds max-thread capacity, only application-level cross-region write reduction helps.
- `dirtiedCardRate >> predictedRefineRate × threadsWanted` → write rate exceeds refinement capacity; `pendingCards` will grow between pauses and spill into pause-time card processing. Quantify the gap: `deficit = dirtiedCardRate - (predictedRefineRate × threadsWanted)` in cards/ms; multiply by the inter-pause interval to estimate the cards that will arrive at the next GC pause. If the deficit is > `pendingCardsTarget`, the full target backlog will arrive at each pause — that is the upper bound on pause extension from residual processing.
- `exceededGoal=true` with `threadsWanted < G1ConcRefinementThreads` → increase `-XX:G1ConcRefinementThreads` to give the policy more threads to allocate. The policy only requests `threadsWanted` threads but is constrained by `G1ConcRefinementThreads`; doubling the cap when `threadsWanted` is at the limit is a reasonable first step. If `threadsWanted` equals `G1ConcRefinementThreads` but `dirtiedCardRate` still exceeds capacity after the increase, the write rate has hit a fundamental ceiling — additional threads will not help and application-level cross-region write reduction is required.

**Cross-event correlation**: `jdk.G1ConcurrentRefinementPolicy` and `jdk.G1ConcurrentRefinementSweep` have no shared `gcId` (Policy fires on a timer; Sweep fires per sweep completion). Join by time window: group all Sweep events within the same inter-GC interval as a Policy event, then compare `pendingCards` trend across those sweeps against the `threadsWanted` value in the Policy event. If `threadsWanted` is rising but the sweep sequence shows `cardsPending` also rising between sweeps, the policy is not converging — the write rate is growing faster than the thread-count response. Join with `jdk.GarbageCollection` (using the `startTime` of the next GC that follows a Policy event) to confirm whether a high `predictedPendingCards` from the Policy event translated to a longer-than-average `duration` in that GC — this closes the loop between the policy's prediction and the actual pause impact.

#### Why existing events don't cover this

- Same analysis as `jdk.G1ConcurrentRefinementSweep` applies for the base refinement gap. Additionally: no existing JFR event exposes the adaptive refinement thread count (`threadsWanted`) or the `pendingCardsTarget` policy parameter. These are the key outputs of the `adjust_threads_wanted()` heuristic — the thread count the policy *wants* vs. what it *has* — and neither is observable in any existing JFR event.
- No existing JFR event fires from `G1ConcurrentRefineTask::adjust_threads_wanted()`. The result is that the entire adaptive thread-count control loop — G1's mechanism for keeping pace with the mutator write rate — is invisible in JFR recordings. An operator cannot determine from JFR alone whether G1 refinement is running at 2 threads or 8, whether it is consistently at the thread ceiling, or whether the pending-card target is being met.

#### External references

Oracle JDK 26 G1 GC Tuning Guide — [Garbage-First Garbage Collector Tuning](https://docs.oracle.com/en/java/javase/26/gctuning/garbage-first-garbage-collector-tuning.html):

> "Refinement tries to schedule work concurrently so that at most `-XX:G1RSetUpdatingPauseTimePercent` percent of the maximum pause time goal is spent in the garbage collection pause in the Update RS phase, processing remaining work."

> "By default, the heuristics allow G1 to use up to the number of parallel GC threads. Work exceeding the capacity of the refinement threads will spill over into the garbage collection pause."

`jdk.G1ConcurrentRefinementPolicy` directly exposes the `threadsWanted` output of this heuristic and the `pendingCardsTarget` it is trying to satisfy — without debug logging operators cannot see whether the refinement-thread heuristic is converging or diverging from its target.

#### Open questions / upstream concerns

1. **Debug-level source** — same justification applies as for `jdk.G1ConcurrentRefinementSweep`: the data is in the product build, JFR access is independent of `-Xlog` level, and `jdk.G1AdaptiveIHOP`/`jdk.G1BasicIHOP` establish precedent for JFR events from `log_debug(gc,ergo)` sites. The key additional argument for Policy: `threadsWanted` is the primary output of a control loop that directly affects GC pause time — making it invisible at `log_info` level while explicitly documenting it as a tuning control (`-XX:G1ConcRefinementThreads`) is an inconsistency in the existing observability design.
2. **Resolved**: keep `predictedPendingCards`. Source: `_predicted_cards_at_next_gc = num_cards + incoming_rate × predicted_time_until_next_gc` at [`g1ConcurrentRefineThreadsNeeded.cpp:64`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1ConcurrentRefineThreadsNeeded.cpp#L64). This is the **projected backlog at the next GC** — the number the `adjust_threads_wanted()` algorithm is trying to get below `pendingCardsTarget`. It is actionable: if `predictedPendingCards` consistently exceeds `pendingCardsTarget` even when `threadsWanted` is at max, the refinement system cannot keep up regardless of thread count, and the only fix is workload reduction or write-barrier profile change.
3. **Resolved: emit from the periodic `adjust_threads_wanted()` path only.** The GC-pause path (`record_young_collection_end()`) provides `exceededGoal`, `pendingCards`, `goalMs`, and `pendingCardsTimeMs` but lacks `threadsWanted`, `pendingCardsFromGC`, `predictedRefineRate`, and `dirtiedCardRate` — the four fields that make the event actionable. Emitting from the periodic path (every inter-GC interval) captures all fields in a single, consistent shape. The GC-pause-aligned data (`pendingCardsTimeMs`) can be derived by correlating with `jdk.GarbageCollection` if needed. Emitting from both paths with different nullable field sets creates a confusing event with two modes — avoid this.

---

### 11. jdk.G1CollectionSetCandidates

#### Verdict

**Propose with caveats.** The debug-level source is the primary concern. The `stopReason` field requires synthesis from multiple stop-condition log lines, which upstream may push back on. Consider a simpler version without `stopReason` (or with `stopReason` as a string enum synthesized at a single call site).

#### The question it answers

"How many old-gen regions did G1 select for this mixed GC, and why did selection stop when it did?"

Mixed GC selection is currently observable only via `-Xlog:gc+ergo+cset=debug`. The selection decision — how many candidate regions were available, how many were selected, and whether the pause-time budget or a region cap caused early termination — is invisible in JFR. Without it, an operator cannot tell whether mixed GC reclamation is bounded by the pause budget (`"Predicted time too high"`), the region cap (`"Maximum number of regions reached"`), or candidate exhaustion.

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

**Stop reason source** ([`g1CollectionSet.cpp:399-518`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1CollectionSet.cpp#L399)):

```cpp
// g1CollectionSet.cpp:399
static void print_finish_message(const char* reason, bool from_marking) {
  log_debug(gc, ergo, cset)("Finish adding %s candidates to collection set (%s).",
                            from_marking ? "marking" : "retained", reason);
}

// In select_candidates_from_marking():
// per-group loop:
if (num_regions_added >= max_old_cset_length) {
  print_finish_message("Maximum number of regions reached", true);   // stopReason #1
  break;
}
if (num_regions_added >= min_old_cset_length && time_remaining_ms == 0) {
  print_finish_message("Region amount reached min", true);           // stopReason #2
  break;
}
if (time_remaining_ms == 0) {
  print_finish_message("Predicted time too high", true);             // stopReason #3
  break;
}
// (after loop if no break triggered:)
log_debug(gc, ergo, cset)("Marking candidates exhausted.");         // stopReason #4
```

`num_expensive_regions` counts groups added when `time_remaining_ms == 0` but below `min_old_cset_length` — these are the `overBudgetRegions`.

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
| `startTime` | Standard JFR | No | Timestamp of CSet selection (inside the GC pause, before evacuation). Two events fire per mixed GC pause — one for `"Marking"`, one for `"Retained"` — both with the same `gcId`. Correlate the pair with `jdk.GarbageCollection` on the same `gcId` to see total pause duration alongside region selection details. |
| `candidateType` | `"Marking"` or `"Retained"` — two passes per mixed GC; marking candidates come from completed marking, retained from previous mixed GCs where optional regions were not evacuated | No | **Marking**: primary old-gen reclaim path, driven by completed concurrent marking; the pool of new candidates identified since the last mixed-GC cycle. **Retained**: secondary path for optional regions deferred from prior pauses; if these accumulate across cycles (`availableRegions` for the Retained event grows over multiple GCs), optional evacuation is not keeping pace with deferral. Use as a split key: analyze `selectedRegions / availableRegions` and `stopReason` separately per `candidateType` — a time-constrained Marking pass and an exhausted Retained pass mean different things and need different tuning. |
| `minRegions` | `min_old_cset_length` / `min_retained_old_cset_length` — minimum regions added regardless of time budget; if the time budget is exhausted before `minRegions` is reached, G1 continues adding until this floor is met (these over-budget additions are counted in `overBudgetRegions`) | No | **Budget-floor gauge**: `minRegions > 0` and `overBudgetRegions > 0` = G1 intentionally violated the pause budget to ensure at least `minRegions` regions are reclaimed per pause — the floor is binding. If `overBudgetRegions` is consistently non-zero, the minimum guarantee is conflicting with the pause goal; raising `G1MixedGCCountTarget` spreads work across more pauses (smaller `minRegions` per pause) to reduce the over-budget additions while still making progress. |
| `maxRegions` | `max_old_cset_length` — maximum regions the policy will add; derived from `G1OldCSetRegionThresholdPercent` (default 10%) × available old-gen regions | No | **Selection ceiling**: if `selectedRegions == maxRegions` AND `timeRemainingMs > 0` → the region cap, not the time budget, was the binding constraint. This is signaled by `stopReason = "Maximum number of regions reached"`. To allow more old-gen work per pause, raise `-XX:G1OldCSetRegionThresholdPercent`; each increase gives G1 more regions to select before hitting the cap. Conversely, if over-budget additions are frequent (`overBudgetRegions > 0`), a lower cap would help constrain per-pause cost — decrease the threshold. The cap is a rate-of-reclamation vs. pause-time trade-off; values above 10% accelerate old-gen reclamation but lengthen pauses. |
| `availableRegions` | Candidate regions count at selection start — for Marking: old-gen regions above `G1MixedGCLiveThresholdPercent` (default 85%) liveness that completed marking; for Retained: optional regions deferred from the prior mixed pause | No | **Reclamation opportunity gauge**: high `availableRegions` means old gen has many reclaimable regions; if `selectedRegions / availableRegions` is consistently low (< 0.3), the pause budget or `maxRegions` cap is the bottleneck — not lack of candidates. If `availableRegions` is low, the live set is dense: few regions have enough garbage to exceed `G1MixedGCLiveThresholdPercent`; either lower this threshold (default 85% → e.g. 75%) to include more regions as candidates, or accept that old gen has very few reclaimable regions and marking is working correctly but old-gen reclamation rate is limited by live-object density. |
| `availableGroups` | **DROPPED** — internal card-set optimization structure; `availableRegions` is the actionable metric (see open question 4). | — | Dropped |
| `selectedRegions` | Initial (`num_inital_regions`) + normal regions actually selected | No | **Constraint disambiguation using sibling fields**: (1) `selectedRegions < availableRegions` AND `timeRemainingMs == 0` AND `stopReason = "Predicted time too high"` → pause time budget was the binding constraint; (2) `selectedRegions < availableRegions` AND `timeRemainingMs > 0` AND `stopReason = "Maximum number of regions reached"` → hard region cap (`G1OldCSetRegionThresholdPercent`) was the binding constraint despite remaining time budget; (3) `selectedRegions ≈ availableRegions` AND `stopReason ends with "exhausted"` → healthy: all candidates consumed, reclamation is not externally constrained. The ratio `selectedRegions / availableRegions` alone is ambiguous — it cannot distinguish between these cases. Always read it alongside `stopReason` and `timeRemainingMs`. |
| `optionalRegions` | Optional regions selected (deferred to optional evacuation step) | No | Non-zero = time budget was not exhausted by initial selection; additional regions were queued for optional evacuation (attempted if time permits after initial CSet is evacuated). **If `optionalRegions` is always 0**: either the initial selection consumed the entire pause budget (`timeRemainingMs == 0`) or the candidate pool was exhausted — no regions were left for optional treatment. `optionalRegions` always 0 with `timeRemainingMs == 0` = time-constrained; `optionalRegions` always 0 with `timeRemainingMs > 0` = candidate pool exhausted before optional threshold. **If `optionalRegions` is consistently non-zero and `stopReason` is time-based**: optional regions exist but may never be evacuated if pauses are short — they accumulate in the Retained list, which is why `candidateType="Retained"` events appear. |
| `overBudgetRegions` | Regions added despite `time_remaining_ms == 0` — forced because below `minRegions` | No | Non-zero = pause risk: GC is adding regions whose predicted time exceeds remaining budget to meet the minimum. **Follow-up query**: cross-reference `predictedInitialTimeMs` from this event against the actual `jdk.GarbageCollection` duration for the same `gcId` — if actual duration exceeds `predictedInitialTimeMs`, the over-budget regions are indeed extending the pause. If actual ≈ predicted, the model's time estimates are conservative and the over-budget additions are not causing real overruns. Frequent `overBudgetRegions > 0` with confirmed pause extension: decrease `-XX:G1MixedGCCountTarget` to spread old-gen work over more pauses, reducing per-pause required `minRegions`. |
| `predictedInitialTimeMs` | Sum of predicted evacuation times for initial regions | No | Expected pause contribution from old-gen regions. **Calibration check**: compare to actual `jdk.GarbageCollection` duration on the same `gcId` — if consistently under by > 20%, the G1 prediction model is underestimating region evacuation time (possibly due to JIT transitions or promotion rate variance); if consistently over, the model is conservative and `maxRegions` could be increased. For mixed GC budget health: `predictedInitialTimeMs` should typically be < `MaxGCPauseMillis × (1 - 1/G1MixedGCCountTarget)` — if it exceeds this fraction, old-gen work is consuming too much pause budget per cycle relative to the total cycle count target. |
| `predictedOptionalTimeMs` | **DROPPED** — planning estimate for optional regions; infer optionality from `optionalRegions > 0` (see open question 4). | — | Dropped |
| `timeRemainingMs` | Remaining pause time budget at end of selection — 0 means time budget was exhausted during selection; positive means selection stopped for another reason | No | **Constraint classifier**: `timeRemainingMs == 0` → time was the binding constraint (see `stopReason = "Predicted time too high"` or over-budget additions). `timeRemainingMs > 0` → something else stopped selection — check `stopReason`: `"Maximum number of regions reached"` = cap was hit, `"exhausted"` = all candidates consumed (healthy). Cross-reference with `overBudgetRegions`: if `timeRemainingMs == 0` but `overBudgetRegions > 0`, the policy exhausted the budget and then continued past it to meet `minRegions`. |
| `stopReason` | Synthesis from `print_finish_message()` calls and exhaustion logs in [`g1CollectionSet.cpp`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1CollectionSet.cpp). Marking-path values ([`g1CollectionSet.cpp:446-513`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1CollectionSet.cpp#L446)): `"Maximum number of regions reached"` / `"Region amount reached min"` / `"Predicted time too high"` / `"Marking candidates exhausted"`. Retained-path value ([`g1CollectionSet.cpp:613`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1CollectionSet.cpp#L613)): `"Retained candidates exhausted"` — logged only when all retained groups were processed; if the loop exits early (region didn't fit initial or optional budget), there is no explicit stop-reason log, but `timeRemainingMs == 0` will indicate budget exhaustion. | No | **Constraint classifier**: identifies which limit caused selection to stop — each value maps to a different flag. `"Predicted time too high"` = pause budget exhausted; selection was time-limited (GC is respecting its pause goal). If old gen is still growing despite mixed GC, increase `-XX:MaxGCPauseMillis` or add old-gen work via `-XX:G1MixedGCCountTarget`. `"Maximum number of regions reached"` = region-count cap hit (`G1OldCSetRegionThresholdPercent`, default 10% of regions); increase this flag if available region count is also high. `"*exhausted"` = all candidates consumed — this is the **healthy terminal state**; if old gen is still growing despite exhaustion, the problem is that the candidate pool is too small (few regions above liveness threshold), not selection stopping early. Check `-XX:G1MixedGCLiveThresholdPercent`. `"Predicted time too high"` is preferable to `"Maximum number of regions reached"` — it means GC is obeying its pause goal rather than being limited by a hard region cap. |

**DROPPED field**: `continueMixed` — from `G1Policy::decide_on_concurrent_start_pause()`, a different call site; cannot be safely attached to this event without reading state from a separate code location. If needed, file as a separate event or add to an existing `jdk.G1HeapSummary` extension.

#### What it is used for

Mixed GC is G1's mechanism for reclaiming old-gen space. If mixed GC is not selecting enough regions per pause, old-gen occupancy grows until Full GC is triggered. This event answers: "Is G1 selecting as many old-gen regions as it could, and what is stopping it from selecting more?"

**`stopReason` → tuning action mapping** (the most direct use of this event):

| `stopReason` value | Meaning | Tuning action |
|---|---|---|
| `"Predicted time too high"` | Pause time budget exhausted before `maxRegions`; region was predicted to exceed remaining budget | Confirm `timeRemainingMs == 0` (or near 0) — if `timeRemainingMs` is small, the budget was genuinely tight. **Primary action**: increase `-XX:MaxGCPauseMillis` to allow more old-gen work per pause; note that this WILL extend pause times. **Alternative**: reduce region liveness threshold via `-XX:G1MixedGCLiveThresholdPercent` (default 85%) to exclude dense regions from candidates — this reduces per-region evacuation cost at the price of leaving more garbage behind per cycle, requiring more mixed-GC cycles. |
| `"Maximum number of regions reached"` | Hard cap on old-gen regions per pause hit; `availableRegions` still > 0 — time budget was not the constraint | Increase `-XX:G1OldCSetRegionThresholdPercent` (default 10% of heap regions) to allow more regions per mixed pause. **Tradeoff**: increasing it makes each mixed-GC pause longer (more old-gen work) but reduces the number of mixed-GC cycles needed to drain the candidate set. If `MaxGCPauseMillis` is strict, increase it before raising `G1OldCSetRegionThresholdPercent`, otherwise the region cap will immediately be replaced by `"Predicted time too high"`. Check `timeRemainingMs` to confirm how much unused pause budget was left — a large `timeRemainingMs` with this stop reason means the cap is very conservative relative to available budget. |
| `"Region amount reached min"` | `minRegions` met exactly; time budget was 0 but forced inclusion complete | Check `overBudgetRegions` > 0 — these forced additions will extend pause beyond `MaxGCPauseMillis`. If `overBudgetRegions > 0` appears consistently (≥ 3 consecutive mixed-GC cycles), old-gen reclamation is chronically behind its accumulation rate. Decrease `-XX:G1MixedGCCountTarget` (default 8) to spread over more pauses, reducing forced additions per pause; this makes each individual pause more predictable at the cost of requiring more mixed-GC cycles to drain the candidate set. |
| `"Marking candidates exhausted"` | All marked old-gen candidates were consumed | Healthy state if occupancy trend is flat — this is the ideal stop reason: every old-gen region above `G1MixedGCLiveThresholdPercent` was processed. If old gen still grows despite this stop reason, concurrent marking is not completing fast enough to generate sufficient candidates before the candidate list is drained; check `jdk.G1AdaptiveIHOP` — if IHOP threshold is high, marking starts late, reducing the window for candidate discovery. Primary action: lower `InitiatingHeapOccupancyPercent` (or let `jdk.G1AdaptiveIHOP` reduce it adaptively) to start marking earlier. |
| `"Retained candidates exhausted"` | All retained (deferred optional) candidates from prior mixed pauses were consumed this cycle | Healthy state — the retained backlog was fully drained. If this stop reason appears consistently alongside a growing `availableRegions` from the Marking-path event, the Marking path is generating more candidates than optional evacuation can process in the retention budget; raise `-XX:G1OldCSetRegionThresholdPercent` to drain more per pause (tradeoff: longer individual mixed pauses). |

**Additional patterns**:
- `overBudgetRegions > 0` frequently → the GC is forced to add over-budget regions to meet its minimum (`minRegions`); pause times will exceed model predictions by the evacuation time of those extra regions. Sustained `overBudgetRegions > 0` across ≥ 3 consecutive mixed GC cycles means old-gen backlog is accumulating faster than the per-pause region cap allows. Primary action: decrease `-XX:G1MixedGCCountTarget` (default 8) to spread work over more pauses, reducing the forced-addition count per pause; secondary action: increase `MaxGCPauseMillis` to allow more regions per pause before over-budget additions are needed.
- `Retained` type appearing → regions were deferred from prior mixed pauses as optional and are now being collected as a separate Retained pass. If `optionalRegions` from the Marking event is always 0 but Retained events appear, the GC deferred optional regions from previous cycles but is not generating new optional candidates from current marking — the Retained pool is being drained down; once exhausted, Retained events stop appearing. If `optionalRegions` on the Marking event is non-zero but Retained events have `stopReason="Retained candidates exhausted"` quickly, the retention budget is too small relative to accumulation rate — raise `-XX:G1OldCSetRegionThresholdPercent`.
- `selectedRegions / availableRegions` ratio < 0.3 consistently → less than 30% of candidates are being collected per mixed-GC pass; at this rate it takes more than 3 passes to drain the candidate set, meaning old-gen reclamation is behind accumulation rate. Disambiguate the cause: `stopReason="Predicted time too high"` → increase `MaxGCPauseMillis` (more time per pause); `stopReason="Maximum number of regions reached"` → increase `G1OldCSetRegionThresholdPercent` (more regions per pause); `stopReason="Marking candidates exhausted"` → ratio below 0.3 despite exhausting the candidate list means `availableRegions` is very small — IHOP is too late and marking isn't discovering enough candidates.

**Cross-event correlation**: join `jdk.G1CollectionSetCandidates` with `jdk.GarbageCollection` on `gcId` to compare `selectedRegions` against `duration` — when `stopReason="Predicted time too high"` and the corresponding GC duration was still shorter than `MaxGCPauseMillis`, the pause prediction model was too conservative. If `duration` frequently finishes well under `MaxGCPauseMillis` despite `stopReason="Predicted time too high"`, the region evacuation time estimates are over-predicted; there is headroom to increase `MaxGCPauseMillis` without actually extending pauses. Join with `jdk.EvacuationInformation` on `gcId` to check `pinnedInQueue`: pinned regions that could not be evacuated reduce the effective `selectedRegions` and account for `overBudgetRegions` being forced into the CSet. Join with `jdk.G1AdaptiveIHOP` by time proximity: if IHOP threshold is rising (old gen is filling faster than marking keeps up) and `stopReason="Marking candidates exhausted"` appears repeatedly, the problem is insufficient concurrent marking throughput — old-gen candidates are being drained per-pause faster than new ones are being discovered, which means lowering IHOP threshold (earlier marking start) is the primary fix.

#### Why existing events don't cover this

- `jdk.EvacuationInformation`: records per-pause evacuation outcome — `cSetRegions`, `cSetUsedBefore`, `cSetUsedAfter`, `pinnedInQueue`. These are aggregate result metrics; they do not carry the candidate count before selection, the predicted time per candidate, the `minRegions`/`maxRegions` bounds, or why selection terminated early.
- `jdk.G1AdaptiveIHOP` / `jdk.G1BasicIHOP`: cover the initiating-heap-occupancy threshold for starting concurrent marking — a separate policy entirely. They say nothing about which old-gen regions were selected for mixed GC or how many candidates were available.
- `jdk.G1HeapSummary`: records `edenUsedSize`, `edenTotalSize`, `survivorUsedSize`, `metaspaceUsedSize` at GC boundaries — heap-accounting fields only; no region selection reasoning, no `stopReason`, no `availableRegions`.
- `jdk.GarbageCollection`: records GC cause and duration; the cause `g1_mixed` tells you that mixed GC ran but carries none of the selection-decision data — no `availableRegions`, `selectedRegions`, `stopReason`, `minRegions`, `maxRegions`, or predicted time per candidate. The `duration` field covers the total pause but does not decompose into the region-selection overhead vs. actual evacuation.
- No existing JFR event exposes `availableRegions`, `selectedRegions`, `stopReason`, or the `minRegions`/`maxRegions` bounds that determine how many old-gen regions G1 will collect per mixed pause. Without these, an operator seeing short mixed GC pauses cannot tell whether mixed GC is completing its full selection budget (healthy) or stopping early due to time pressure (`"Predicted time too high"`) — the two scenarios call for opposite responses (leave `-XX:MaxGCPauseMillis` alone vs. raise it).

#### External references

Oracle JDK 26 G1 GC Tuning Guide — [Garbage-First Garbage Collector Tuning](https://docs.oracle.com/en/java/javase/26/gctuning/garbage-first-garbage-collector-tuning.html):

> "You can obtain information about how much time evacuation of either young or old generation regions contribute to the pause-time by enabling the `gc+ergo+cset=debug` log output."

> "Spread the old generation region reclamation across more garbage collections by increasing `-XX:G1MixedGCCountTarget`."

> "Avoid collecting regions that take a proportionally large amount of time to collect by not putting them into the candidate collection set by using `-XX:G1MixedGCLiveThresholdPercent`."

> "Stop old generation space reclamation earlier so that G1 won't collect as many highly occupied regions. In this case, increase `-XX:G1HeapWastePercent`."

Oracle explicitly tells operators to enable `gc+ergo+cset=debug` to diagnose mixed-GC timing — `jdk.G1CollectionSetCandidates` makes this information JFR-accessible without enabling debug logging. The `stopReason` field directly explains which of these three tuning knobs (`G1MixedGCCountTarget`, `G1MixedGCLiveThresholdPercent`, `G1HeapWastePercent`) is the binding constraint.

#### Open questions / upstream concerns

1. **Debug-level source**: same justification as for `jdk.G1ConcurrentRefinementSweep` and same recommended approach — promote the finish-message log calls from `log_debug(gc,ergo,cset)` to `log_info(gc,ergo,cset)` in the same PR. The Oracle Tuning Guide explicitly directs operators to enable `gc+ergo+cset=debug` to diagnose mixed-GC timing; promoting those log sites to info makes the guidance consistent with production observability practice.
2. **`stopReason` synthesis — concrete implementation**: replace `print_finish_message(reason, from_marking)` calls with a `stop_reason` local enum that is set at each break point and read at the JFR emission site. The four string literals in `print_finish_message()` map to a clean `StopReason` enum: `REGION_CAP_REACHED`, `MIN_REGIONS_MET`, `TIME_BUDGET_EXHAUSTED`, `CANDIDATES_EXHAUSTED`. The enum is resolved to a string in the JFR event. This avoids string duplication and is idiomatic C++ for this pattern. The implementation adds ~10 lines to `finalize_old_part()` and is not complex; upstream's concern would be the field itself (is this too implementation-specific?) not the mechanics.
3. **Resolved: keep two events per mixed GC** (Marking + Retained as separate emissions). A single event with both passes merged would require nullable fields for Retained-only data or a fixed-size array of pass results — both are more complex than emitting twice. The two-event design allows independent analysis: `stopReason` on the Marking pass vs. Retained pass often differs (Marking typically stops on time or region cap; Retained stops on exhaustion), which is the key diagnostic. Upstream should be told that the pair of events represents one logical "mixed GC CSet selection" and tools should correlate them by `gcId`.
4. **Resolved**: drop `availableGroups` and `predictedOptionalTimeMs`. `availableGroups` is an internal card-set optimization structure; `availableRegions` is the actionable metric. `predictedOptionalTimeMs` is a planning estimate for optional regions that may not be attempted — operators can infer optionality from `optionalRegions > 0`. Dropping both reduces the schema from 14 to 12 fields without losing diagnostic value.

---

### 12. jdk.G1HeapResize

#### Verdict

**Propose with caveats.** Debug-level source. Shrink-path-only nullable fields. Consider gating emission on `resizeBytes != 0` to avoid emitting events when nothing changed.

#### The question it answers

"Why did G1 decide to expand or shrink its heap after this pause, and was the resize gated by a capacity limit?"

`jdk.G1HeapSummary` records committed heap sizes at GC boundaries — you can compute the resize delta by diffing consecutive events. But the delta tells you nothing about the CPU-usage deviation counter, the thresholds, or the scale factor that drove the decision. Was the resize triggered because GC CPU exceeded the target? Or suppressed because the heap is already at `-Xmx`? These questions require the policy internals this event exposes.

#### Emission point

**Function**: `G1HeapSizingPolicy::young_collection_resize_amount()`  
[`g1HeapSizingPolicy.cpp:216`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1HeapSizingPolicy.cpp#L216)  
Three `log_resize()` calls at lines 302, 319, 337.  
Also: `young_collection_shrink_amount()` at [`g1HeapSizingPolicy.cpp:172`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1HeapSizingPolicy.cpp#L172).

**Sigmoid scaling function** ([`g1HeapSizingPolicy.cpp:97-135`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1HeapSizingPolicy.cpp#L97)):

```cpp
// g1HeapSizingPolicy.cpp:97
// Logistic function, returns values in the range [0,1]
static double sigmoid_function(double value) {
  double inflection_point = 1.0; // 100% deviation from target
  double steepness = 6.0;
  return 1.0 / (1.0 + exp(-steepness * (value - inflection_point)));
}

double G1HeapSizingPolicy::scale_cpu_usage_delta(
    double cpu_usage_delta, double min_scale_factor, double max_scale_factor) const {
  double sigmoid = sigmoid_function(cpu_usage_delta);
  double scale_factor = min_scale_factor + (max_scale_factor - min_scale_factor) * sigmoid;
  return scale_factor;
}

// For shrink: min_scale_factor from G1ShrinkByPercentOfAvailable, max from 2x that.
// scaleFactorPct = scale_cpu_usage_delta(cpu_usage_delta, min, max) * 100
```

The sigmoid inflection at `cpu_usage_delta=1.0` (100% deviation from target) means: small deviations produce near-minimum scaling (conservative), deviations at 100%+ produce near-maximum scaling (aggressive). At steepness=6.0, the transition is sharp near 1.0 but not a step function.

**Deviation counter update logic** ([`g1HeapSizingPolicy.cpp:226-244`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1HeapSizingPolicy.cpp#L226)):

```cpp
// Thresholds: target ± G1CPUUsageDeviationPercent (default 25%)
const double upper_threshold = gc_cpu_usage_target * (1 + G1CPUUsageDeviationPercent/100.0);
const double lower_threshold = gc_cpu_usage_target * (1 - G1CPUUsageDeviationPercent/100.0);

// Counter update per GC pause:
if (short_term_gc_cpu_usage > upper_threshold) {
  _gc_cpu_usage_deviation_counter++;   // → expand when counter >= G1CPUUsageExpandThreshold (4)
} else if (short_term_gc_cpu_usage < lower_threshold) {
  _gc_cpu_usage_deviation_counter--;   // → shrink when counter <= -G1CPUUsageShrinkThreshold (-8)
}
// Reset to 0 after each successful resize. Halved (not zeroed) on soft reset.
```

The `deviationCounter` field captures this accumulated state: positive = N consecutive above-upper-threshold pauses; negative = N consecutive below-lower-threshold pauses; 0 = within tolerance band or just resized.

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
| `startTime` | Standard JFR | No | Timestamp of the young GC pause during which this resize decision was made. Because `resizeBytes != 0` is the emission gate, events are sparse — most pauses produce no event. Correlate with the preceding `jdk.GarbageCollection` on the same `gcId` to see the pause that triggered the resize. |
| `shortTermGcCpuUsagePct` | `_analytics->short_term_gc_time_ratio() * 100` — exponentially-weighted recent average; primary input to `deviationCounter`; increments when above `upperThresholdPct`, decrements when below `lowerThresholdPct` | No | **Primary resize driver**: watch trend across consecutive events. `shortTermGcCpuUsagePct > upperThresholdPct` for 4+ consecutive events = expansion triggered. `shortTermGcCpuUsagePct < lowerThresholdPct` for 8+ consecutive events = shrink triggered. If the value oscillates above and below the thresholds without sustained direction, the workload is bursty and no resize fires — check `deviationCounter` to see how close it gets to the trigger threshold. Compare against `longTermGcCpuUsagePct` to detect transient vs. sustained shifts: `shortTerm >> longTerm` = recent GC spike, may be transient; `shortTerm ≈ longTerm` = sustained load change. |
| `longTermGcCpuUsagePct` | `_analytics->long_term_gc_time_ratio() * 100` — slow-moving average; checked every `long_term_count_limit()` pauses (a larger window than short-term) | No | **Sustained trend indicator**: unlike `shortTermGcCpuUsagePct` which reacts quickly, this lags by design. If `longTermGcCpuUsagePct > upperThresholdPct` at the long-term check interval, expansion fires regardless of the short-term deviation counter — this is the "persistently overloaded" path. **Cross-field diagnosis**: `longTermGcCpuUsagePct > upperThresholdPct` but `shortTermGcCpuUsagePct < upperThresholdPct` = old sustained overload that recently eased — heap may have already expanded and GC CPU dropped; if no expansion happened yet, it will fire on the long-term path. `longTerm < lowerThresholdPct` and `shortTerm < lowerThresholdPct` = consistently oversized heap; shrink is expected. |
| `deviationCounter` | `_gc_cpu_usage_deviation_counter` — positive → consecutive above-upper-threshold samples; negative → consecutive below-lower-threshold; reset to 0 after each resize | No | Threshold for expansion: counter **≥** `G1CPUUsageExpandThreshold` (default 4); threshold for shrink: counter **≤** `-G1CPUUsageShrinkThreshold` (default -8). Counter = 0 means heap is in tolerance band. **Direction of travel**: counter approaching +4 across consecutive events = heap is about to expand; monitor `atLimit` — if it reaches +4 but `resizeBytes=0`, `atLimit=true` is blocking expansion and `-Xmx` must be raised. Counter approaching −8 = heap is about to shrink; if followed by `survivorOverflow=true` or `promotedBytesEstimate` spike in subsequent events, the shrink will trigger a promotion overflow. **Oscillation**: counter alternating between +3/+4 and −7/−8 across multiple events = the heap is resizing repeatedly (expand → shrink → expand); typically caused by highly variable GC CPU loads. Widen the tolerance band by increasing `G1CPUUsageDeviationPercent` (default 25%) to suppress oscillation. |
| `lowerThresholdPct` | `gc_cpu_usage_target * (1 - G1CPUUsageDeviationPercent/100)` where `gc_cpu_usage_target = 1/(1+GCTimeRatio)` (scaled by heap fill ratio) | No | Below this → shrink candidate. Example: `GCTimeRatio=24` → target=4%; `G1CPUUsageDeviationPercent=25` → lower=3%. If `shortTermGcCpuUsagePct` consistently stays below `lowerThresholdPct`, the heap is oversized for this workload and memory is being held unnecessarily. **Action**: either accept the shrink (G1 will shrink automatically) or raise `GCTimeRatio` to reduce the target fraction and widen the lower threshold — useful if the heap must stay large to handle burst allocation. If `shortTermGcCpuUsagePct` is below `lowerThresholdPct` but `atLimit=true` on shrink, `-Xms` is preventing the release; reduce `-Xms` if OS-level memory pressure is a concern. |
| `upperThresholdPct` | `gc_cpu_usage_target * (1 + G1CPUUsageDeviationPercent/100)` | No | Above this → expand candidate. Same example: upper=5%. If `shortTermGcCpuUsagePct` persistently exceeds `upperThresholdPct` across 4+ consecutive events (`deviationCounter >= G1CPUUsageExpandThreshold`) and `atLimit=false`, the heap will expand automatically. **Action when `atLimit=true`**: `-Xmx` is preventing the needed expansion — increase it. **Action when oscillating around `upperThresholdPct`**: the workload has variable GC load; widen the band with `G1CPUUsageDeviationPercent` (default 25% — increase to e.g. 35%) to prevent the deviationCounter from reaching +4 on transient spikes. **Action when consistently high but `resizeBytes=0` for many events**: `deviationCounter` is not accumulating to +4, likely because occasional low-GC-CPU pauses reset it — diagnose by tracking `deviationCounter` trend directly. |
| `gcCpuUsageTargetPct` | `1.0 / (1.0 + GCTimeRatio)` × heap-scale factor; steady-state desired GC CPU fraction | No | The target the policy is aiming for. With `GCTimeRatio=24` (G1 default) this is 4% before heap scaling. `scale_with_heap()` reduces the target when committed heap ≤ half of max — meaning a small heap is allowed to run GC harder before expanding. **Use as a reference**: compare `shortTermGcCpuUsagePct` against `gcCpuUsageTargetPct` to see how far actual GC load is from the policy's desired state. If actual is persistently 2× the target, either allocation rate is high for the heap size or `GCTimeRatio` is too high (set too permissive — lower it to set a tighter GCU% ceiling, causing earlier expansion). If actual is consistently below half the target, the heap is oversized for the workload — lower `GCTimeRatio` to shrink the target and allow earlier shrink, or accept the oversized heap. |
| `expand` | `true`=expand, `false`=shrink; only valid when `resizeBytes != 0` — `expand` is a reference parameter in `young_collection_resize_amount()` that is only assigned inside the expand (line 298) or shrink (line 316) branches; when neither fires it retains a stale value | Yes (null if `resizeBytes=0`) | **Direction of resize**: `expand=true` = GC CPU usage was persistently above `upperThresholdPct`; heap is growing to lower GC overhead per pause. `expand=false` = GC CPU has been consistently below `lowerThresholdPct`; heap is shrinking to release pages. Always read alongside `atLimit` — if `expand=true + atLimit=true`, the expansion was requested but blocked by `-Xmx`; if `expand=false + atLimit=true`, shrink was requested but blocked by `-Xms`. An alternating pattern (`true` then `false` on successive events within a few pauses) = heap oscillation — widen the deviation band with `G1CPUUsageDeviationPercent`. |
| `resizeBytes` | `young_collection_resize_amount()` return value; 0 = no resize triggered this pause | No | **Magnitude of resize**: 0 on most pauses (heap inside tolerance band). Non-zero = a resize fired; divide by `G1HeapRegionSize` to get region count. Large `resizeBytes` on expansion (e.g., > 10% of current heap) = the deviation counter hit the threshold after being compressed for several pauses — the heap will jump rather than grow gradually. Large `resizeBytes` on shrink with `scaleFactorPct > 80%` = aggressive sigmoid scaling is releasing many regions at once, risking a subsequent promotion overflow. Tracking the running sum of `resizeBytes` (sign-adjusted: `+` for expand, `−` for shrink) gives the net committed-heap change over a recording window. |
| `atLimit` | Boolean: heap already at min/max capacity, so resize was requested but not possible | No | Two distinct cases: **(1) `expand=true` + `atLimit=true`**: heap needs to grow (GC CPU above `upperThresholdPct` for 4+ consecutive pauses) but `-Xmx` is the ceiling — increase max heap. **(2) `expand=false` + `atLimit=true`**: heap needs to shrink (GC CPU below `lowerThresholdPct` for 8+ consecutive pauses) but committed size is already at the minimum (`-Xms` or system allocation granularity). The heap footprint cannot be reduced further — common causes: `-Xms` equals `-Xmx` (no headroom for shrink), OS huge-page backing that prevents partial uncommit, or `InitialHeapSize` was set equal to `MaxHeapSize`. In this case, the shrink signal is structural and will continue to fire — no action is needed unless OS-level memory pressure exists, in which case reducing `-Xms` allows the JVM to release pages when GC CPU is low. |
| `scaleFactorPct` | From `young_collection_shrink_amount()` sigmoid scaling — accounts for how far GC CPU usage deviated | Yes (null on expansion path) | Sigmoid-based shrink aggressiveness: applied to `free_regions × regionSizeBytes` to produce `shrinkBytes`. Near `min_scale_factor` (conservative) when deviation is small; near `max_scale_factor` (aggressive) when `|deviationCounter|` is at the shrink threshold (−8). At 100%+ scale, GC shrinks a large fraction of available free regions in one cycle. **Risk pattern**: `scaleFactorPct > 80%` followed by a `promotedBytesEstimate` spike in the next 2–3 cycles = aggressive shrink followed by promotion burst may overflow the now-smaller old gen. **Action if this pattern appears**: reduce `|deviationCounter|` by raising `G1CPUUsageShrinkThreshold` (default −8) to require more consecutive below-threshold samples before shrinking; this dampens oscillation. Alternatively, verify that GC CPU is genuinely low (check `longTermGcCpuUsagePct`) — if it's still near the target, `shortTermGcCpuUsagePct` may be transiently low due to a quiet period and the shrink is premature. |
| `freeRegions` | Free region count at shrink evaluation time | Yes (null on expansion path) | Constrains the maximum possible shrink: `maxShrinkBytes = (freeRegions - regionsNeededForAlloc) × regionSizeBytes`. **Low `freeRegions` despite apparent free space** = severe region fragmentation — many regions have sparse free space but no fully-free region exists. In this state, shrink opportunities are structurally limited; increasing `-XX:G1HeapWastePercent` may surface more reclaimable regions. |
| `regionsNeededForAlloc` | Regions needed for allocation headroom at shrink time | Yes (null on expansion path) | **Shrink headroom floor**: `shrinkBytes` will never reduce `freeRegions` below this floor — the policy preserves enough free regions to satisfy the next allocation burst. If `freeRegions ≈ regionsNeededForAlloc` consistently, the heap cannot shrink even when GC CPU usage is low (expansion needed to get any shrink headroom, which is a contradiction unless the workload genuinely needs the space). **Actionability**: when `shrinkBytes` is consistently small despite a persistent negative `deviationCounter`, compare `freeRegions` to `regionsNeededForAlloc` — if the difference is near zero, allocation headroom is preventing the shrink, not the deviation threshold. The fix is reducing allocation pressure (lowering `NewRatio` to reduce old-gen promotion or tuning eden size via `G1MaxNewSizePercent`) rather than changing resize policy parameters. |

#### What it is used for

G1 adjusts the committed heap between pauses based on GC CPU usage vs. a target derived from `GCTimeRatio`. The existing `jdk.G1HeapSummary` shows you the result (heap size before and after) but not **why** the resize happened or whether the policy's threshold was met. This event answers:

- **Is G1 expanding or shrinking, and is the heap at a capacity limit?** `expand=true` + `atLimit=false` = heap is actively growing; `expand=true` + `atLimit=true` = GC CPU is high but `-Xmx` is blocking expansion — increase max heap. `expand=false` + `atLimit=true` = GC CPU is low but `-Xms` prevents releasing pages — reduce `-Xms` if OS memory pressure is a concern.
- **Is `GCTimeRatio` configured to match the workload?** If `shortTermGcCpuUsagePct` consistently exceeds `upperThresholdPct` across multiple events but no resize fires (`resizeBytes=0`, `atLimit=false`), the `deviationCounter` is not accumulating to `G1CPUUsageExpandThreshold` (4) because occasional low-GC-CPU pauses reset it — lower `G1CPUUsageDeviationPercent` (widen the band) or accept that the workload is bursty. If `shortTermGcCpuUsagePct` consistently stays below `lowerThresholdPct`, the heap is oversized for the workload; G1 will shrink automatically once the counter reaches `-G1CPUUsageShrinkThreshold` (−8).
- **Is sigmoid scaling producing oscillation?** If `scaleFactorPct > 80%` on a shrink event is followed by `expand=true` within 2–3 subsequent events, the sigmoid applied an aggressive shrink that released too many free regions, forcing an immediate re-expansion. **Action**: increase `G1CPUUsageShrinkThreshold` (default 8) to require more consecutive below-threshold samples before a shrink fires, dampening the oscillation.

**Key diagnosis**: `resizeBytes=0` on every pause means `deviationCounter` has not reached `G1CPUUsageExpandThreshold` (≥4) or `-G1CPUUsageShrinkThreshold` (≤-8). If `shortTermGcCpuUsagePct` oscillates around `upperThresholdPct` but `deviationCounter` never reaches 4, the thresholds are too high. If `deviationCounter` reaches the threshold but `resizeBytes=0`, then `atLimit=true` — the heap cannot expand further.

**Cross-event correlation**: join `jdk.G1HeapResize` with `jdk.G1HeapSummary` on `gcId` to validate the resize outcome — `jdk.G1HeapSummary.heapSpace.committedSize` after the GC should reflect the `resizeBytes` delta from the corresponding `jdk.G1HeapResize` event. If the committed size in `jdk.G1HeapSummary` does not change despite `resizeBytes > 0`, the OS rejected the resize (e.g., container memory limit), which `atLimit=true` should also reflect. Join with `jdk.GarbageCollection` on `gcId`: `expand=true` events should correlate with shorter subsequent GC durations (more heap → less frequent GC → lower per-cycle pressure); if `expand=true` events do not reduce duration, the bottleneck is not heap size but live-set density or GC throughput. Track `deviationCounter` as a time series across consecutive events: a deviationCounter that reaches ≥4 but then resets immediately after the resize (due to `resizeBytes > 0`) in a repeating pattern indicates the policy is continuously at the expand-threshold boundary — the heap is perpetually undersized for the workload, and a permanent `-Xmx` increase is a better solution than relying on the adaptive policy to expand repeatedly.

#### Why existing events don't cover this

- `jdk.G1AdaptiveIHOP`: covers old-gen occupancy threshold for initiating concurrent marking; carries `threshold`, `thresholdPercent`, `ihopPercent`, `recentMutatorAllocationSize` — none of these are CPU-usage deviation fields. Does not record committed heap resize.
- `jdk.G1HeapSummary`: carries `heapSpace` (reserved/committed/used) and `edenUsedSize`/`edenTotalSize`/`survivorUsedSize`/`metaspaceUsedSize` — size outcomes. By diffing consecutive events you can compute the resize delta, but you cannot determine whether the resize was driven by GC CPU usage exceeding `upperThresholdPct`, by the long-term check, or why it was suppressed (`atLimit=true`). The `deviationCounter`, `scaleFactorPct`, and `gcCpuUsageTargetPct` fields are absent entirely.
- `jdk.GCHeapSummary`: records `heapSpace` (reserved/committed/used) — the same size-outcome limitation as `jdk.G1HeapSummary`. Does not carry any of: `deviationCounter`, `shortTermGcCpuUsagePct`, `upperThresholdPct`, `lowerThresholdPct`, `gcCpuUsageTargetPct`, `scaleFactorPct`, `expand`, `atLimit`, or `resizeBytes`.
- `jdk.GCConfiguration`: records `gcTimeRatio` at JVM startup (`GCTimeRatio` flag value); does not expose the per-pause deviation counter, whether the heap reached a resize threshold this pause, or the effective scaled `gcCpuUsageTargetPct` (which differs from `1/(1+GCTimeRatio)` when heap is below half of max capacity — see `scale_with_heap()` in `g1HeapSizingPolicy.cpp:131`).
- No existing JFR event exposes `G1HeapSizingPolicy`'s `_gc_cpu_usage_deviation_counter`, `expand`, `atLimit`, `scaleFactorPct`, or `resizeBytes`. By diffing consecutive `jdk.G1HeapSummary` events you can compute the resize delta after the fact, but you cannot determine what CPU deviation triggered the resize, how close the counter was to the threshold, whether the resize was blocked by `-Xms`/`-Xmx` limits, or what scale factor was applied. The policy's internal reasoning is entirely absent from the JFR event stream today.

#### External references

Oracle JDK 26 G1 GC Tuning Guide — [Garbage-First Garbage Collector Tuning](https://docs.oracle.com/en/java/javase/26/gctuning/garbage-first-garbage-collector-tuning.html):

> "Like other collectors, G1 aims to size the heap so that the time spent in garbage collection is below the ratio determined by the `-XX:GCTimeRatio` option..."

> "The actual formula for determining the target fraction of time that can be spent in garbage collection before increasing the heap is `1 / (1 + GCTimeRatio)`. This default value results in a target of 4% of the time to be spent in garbage collection." (G1 default `GCTimeRatio=24` → target 1/25 = 4%)

Oracle GC Ergonomics Guide — [Ergonomics](https://docs.oracle.com/en/java/javase/26/gctuning/ergonomics.html):

> "The heap grows or shrinks to a size that will support the chosen throughput goal."

`jdk.G1HeapResize` exposes the exact CPU-usage deviation counter and thresholds behind this ergonomic resize — making the policy's internal state visible without debug logging. The `gcCpuUsageTargetPct` field (= `1/(1+GCTimeRatio)` × heap-scale factor) tells operators whether their `GCTimeRatio` setting matches the actual GC load.

Oracle GC Ergonomics Guide also notes:
> "If the maximum pause time goal is not being met, then the size of only one generation is shrunk at a time."

This interacts with `jdk.G1HeapResize`'s `atLimit` field: when both `-Xmx` and pause constraints are binding, `atLimit=true` confirms that the heap cannot grow despite the policy wanting it to.

#### Open questions / upstream concerns

1. **Debug-level source**: same argument as for refinement events — data is in product build, JFR access model is independent of `-Xlog`. The Oracle G1 Tuning Guide references `GCTimeRatio` as a key tuning control; the policy evaluation data that drives heap resizing should be observable without debug logging. **Recommended approach**: promote `log_resize()` calls from `log_debug(gc,ergo,heap)` to `log_info(gc,ergo,heap)` in the same PR — this is directly parallel to how `jdk.G1AdaptiveIHOP` events were justified and accepted.
2. **Resolved**: accept shrink-path nullable fields in the initial proposal. The three shrink-only fields (`scaleFactorPct`, `freeRegions`, `regionsNeededForAlloc`) are null on the expansion path because `young_collection_shrink_amount()` is only called on the shrink branch. Separating into two events (`jdk.G1HeapExpand` + `jdk.G1HeapShrink`) would be cleaner but doubles the boilerplate for a relatively rare event. The nullable pattern is acceptable here because: (a) `resizeBytes > 0` is required to emit at all, so null fields always co-occur with meaningful `expand=false`; (b) all three fields are from the same function call and have a clear, consistent null condition. Note in the schema: these three fields are populated only when `expand=false`.
3. **Resolved**: the event should be gated on `resizeBytes != 0`. Source analysis: `young_collection_resize_amount()` uses a `bool& expand` reference parameter that is only assigned inside the expand (line 298) or shrink (line 316) branches. When neither branch fires, `expand` retains whatever stale value it had from a previous call — and the caller at [`g1CollectedHeap.cpp:988`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1CollectedHeap.cpp#L988) already checks `if (resize_bytes != 0)` before using `expand`. Emitting the event only on `resizeBytes != 0` keeps `expand` well-defined and avoids per-pause noise.
4. **Resolved**: keep `gcCpuUsageTargetPct`. The `scale_with_heap()` function modifies the target when committed heap ≤ half of max capacity (`target *= capacity / (max_capacity/2)`, floored at 1%) — the effective target is *not* simply `1/(1+GCTimeRatio)` in that case. Without emitting the scaled value, operators cannot reason about why expansion triggered at a non-standard threshold. `jdk.GCConfiguration.gcTimeRatio` gives the configured ratio but not the effective scaled target.

---

### 13. jdk.ZDirectorRule

#### Verdict

**Propose with caveats.** The 22-field sparse original design was the blocker; that has been replaced by the 6-field per-tick summary event documented below. The redesign is complete. Remaining caveats: (1) all source sites are `log_debug(gc,director)` — the upstream submission should include log-level promotion of the `timeUntilMinorOOM` log to `log_info` as part of the same PR; (2) `timeUntilMinorOOM` and `minorFreeBytes` require the small `ZDirectorResult` struct accumulation described in OQ3; (3) the emission gate (OQ2) must suppress idle-tick noise. With these three addressed, the event is upstreamable.

#### The question it answers

"Why did ZGC trigger (or not trigger) a collection this tick?"

`jdk.ZYoungGarbageCollection` and `jdk.ZOldGarbageCollection` fire after GC is chosen and record outcomes. Director decisions — especially ticks where no GC is triggered — produce no event at all today. The director runs every ~1s, evaluating all rules on every tick. When no rule fires, there is complete silence in JFR: an operator cannot tell whether the heap was genuinely idle, whether allocation pressure was building but not yet past the threshold, or whether a GC was already running and the director skipped triggering a new one.

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

**Source** ([`zDirector.cpp:820-841`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zDirector.cpp#L820)):

```cpp
static bool start_gc(const ZDirectorStats& stats) {
  // Try start major collections first as they include a minor collection
  const GCCause::Cause major_cause = make_major_gc_decision(stats);
  if (major_cause != GCCause::_no_gc) {
    start_major_gc(stats, major_cause);
    return true;   // Minor rules never evaluated
  }

  const GCCause::Cause minor_cause = make_minor_gc_decision(stats);
  if (minor_cause != GCCause::_no_gc) {
    if (!ZDriver::major()->is_busy() && rule_major_allocation_rate(stats)) {
      start_major_gc(stats, GCCause::_z_allocation_rate);  // Minor pressure escalated to major
    } else {
      start_minor_gc(stats, minor_cause);
    }
    return true;
  }

  return false;   // No rule triggered this tick
}
```

The `triggeredMajorRule` and `triggeredMinorRule` fields in the recommended redesign correspond directly to `major_cause` and `minor_cause` here. Both are available in `start_gc()` — a clean single emission point.

Log tag: `log_debug(gc,director)` — ALL rule log sites in `zDirector.cpp`. There is no `log_info` in the entire file.

**Cadence**: Every director tick (~1s default).

**Thread**: ZGC director thread.

#### Design concern with the current 22-field design

The proposed event has 22 fields. Each rule populates only 3–5 of them; most fields are null for most firings. This creates a pathologically sparse event that is hard to query and will receive upstream pushback.

#### Recommended redesign: per-tick summary event

Emit one event per director tick with 6 fields. The `start_gc()` function at [`zDirector.cpp:820`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zDirector.cpp#L820) calls both `make_major_gc_decision()` (line 822) and `make_minor_gc_decision()` (line 828) and receives their `GCCause::Cause` return values — both results are available at a single point, making it a clean single-emission-point for the summary. The `heapFreePercent` field is computed from `stats._heap` which is in scope at `start_gc()`. The `timeUntilMinorOOM` and `minorFreeBytes` fields require the small struct accumulation described in OQ3.

| Field | Source | Nullable? | Tuning use |
|---|---|---|---|
| `startTime` | Standard JFR | No | Director tick timestamp. Consecutive `startTime` gaps should be approximately `1/ZDirectorPeriod` seconds (default ~1s). A gap significantly longer than 1s means the director thread was blocked or the JVM was paused (e.g., Full GC). Used as the time reference when `triggeredMinorRule` or `triggeredMajorRule` is non-null to timestamp the trigger decision. |
| `triggeredMinorRule` | `GCCause::Cause` name from `make_minor_gc_decision()` return — null if `_no_gc` **OR** if major triggered (major preempts minor evaluation entirely — minor is never evaluated when major fires). **Disambiguation**: null means either "evaluated, nothing triggered" or "not evaluated because major fired first" — these cases are indistinguishable from the minor field alone; use `triggeredMajorRule != null` to detect the preemption case. | Yes | Which pressure caused the minor GC: `"_z_timer"` = periodic minor timer elapsed (normal cadence, no allocation pressure — if this is the predominant trigger, ZGC is running proactively on schedule with no pressure building; healthy; compare `heapFreePercent` trend to confirm). `"_z_allocation_rate"` = rate model predicts OOM within `timeUntilMinorOOM` seconds — `minorFreeBytes` and `timeUntilMinorOOM` fields are populated; this is the key pressure signal. `"_z_high_usage"` = heap occupancy passed 95% free threshold (`heapFreePercent < 5%`) — the rate model was not the trigger so `timeUntilMinorOOM` is null; occupancy-based safety net fired. Repeated `"_z_high_usage"` with null `timeUntilMinorOOM` means allocation rate was not detectable or too bursty for the model — see `heapFreePercent` trend. |
| `triggeredMajorRule` | `GCCause::Cause` name from `make_major_gc_decision()` return — null if `_no_gc`; evaluated first; if non-null, minor was never evaluated | Yes | **Per-value interpretation**: `"_z_warmup"` = early-startup heap fill (normal during first few dozen collections); seeing this in steady state means the JVM restarted or the warmup heuristic is miscalibrated. `"_z_proactive"` = the heap has been idle long enough that ZGC decided to compact proactively (no allocation pressure, just opportunistic cleanup) — harmless; if it fires too frequently, increase `ZProactiveGCInverseGoodness`. `"_z_allocation_rate"` = allocation rate escalated past the young-gen threshold; a major collection was needed without a prior minor (the young gen couldn't absorb the load) — if this fires frequently, the young gen is undersized; check `-XX:ZYoungGenerationSizePercent`. `"_z_timer"` = periodic major timer elapsed (safety net to ensure old gen is eventually collected); not a pressure signal, just interval-based reclaim. Frequently null = major collections are triggered by minor escalation rather than direct major rules (healthy). |
| `timeUntilMinorOOM` | From alloc-rate rule (`rule_minor_allocation_rate_dynamic`): `time_until_oom` computed from allocation rate model | Yes | Projected seconds until young-gen exhaustion at current allocation rate. **ZGC's primary OOM-prevention metric** — this is what the proactive director uses to start GC before allocation stalls. **Interpretation**: > 10s = safe; 5–10s = monitor closely; 2–5s = pressure building, minor GC should fire soon; < 2s = imminent stalls. If `timeUntilMinorOOM < estimated_young_gc_duration` (typically 0.1–1s for ZGC minor), allocation stalls are likely before GC can finish. **Trend**: if `timeUntilMinorOOM` is declining across consecutive ticks without a minor GC triggering, the allocation rate model is conservative or GC concurrency is lagging. Null if the dynamic alloc-rate rule was not the firing rule (major GC preempted minor evaluation, or a different minor rule — e.g., `_z_timer` — fired instead). |
| `minorFreeBytes` | Available young-gen free bytes from `rule_minor_allocation_rate_dynamic` evaluation: `free = soft_max_capacity - used - relocation_headroom` from `stats._heap` (line 159 of `zDirector.cpp`). Populated only when the dynamic alloc-rate rule path was evaluated; null if major triggered first (preempting minor evaluation) or if only the timer/static rule fired. **Note**: `rule_minor_high_usage` does not expose a separate free-bytes variable — it uses the total-heap `heapFreePercent` via `is_high_usage()`, not a per-minor-generation metric. | Yes | Young-gen remaining headroom at tick time. `timeUntilMinorOOM` is computed as `minorFreeBytes / maxAllocRate` — so a low `minorFreeBytes` directly drives a low `timeUntilMinorOOM`. If `minorFreeBytes` is declining across ticks while `triggeredMinorRule` is still null, allocation rate is building pressure but has not yet crossed the GC trigger threshold. A sustained decline of > 10% per tick suggests GC will trigger within the next few ticks. Null when `rule_minor_allocation_rate_dynamic` was not evaluated (major rule fired first, or timer/static rule fired instead). |
| `heapFreePercent` | Total heap free fraction (0–100%) from `is_high_usage()` at [`zDirector.cpp:309`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zDirector.cpp#L309): `free_percent = percent_of(free, soft_max_capacity)` where `free = (soft_max_capacity - used) - relocation_headroom`. This is the same value evaluated by both `rule_minor_high_usage` (triggers below 5%) and `is_major_urgent()` (combines with `is_young_small()` to assess escalation urgency). Available from `stats._heap` at the `start_gc()` emission point on every tick. | No | **Global heap free headroom at tick time**. 5% is the `rule_minor_high_usage` trigger threshold — if `heapFreePercent` drops below 5%, a minor high-usage collection fires. **Interpretation**: > 30% = healthy; 15–30% = filling; 5–15% = approaching trigger threshold; < 5% = `rule_minor_high_usage` will fire or already fired this tick. **Declining trend**: `heapFreePercent` dropping > 3% per tick means the heap is filling faster than GC is reclaiming — investigate whether tenuring threshold is too low (causing premature promotions that fill old gen) or GC frequency is too low. **Combined pressure**: if `heapFreePercent` is declining while `timeUntilMinorOOM` is also declining, both the rate-based and occupancy-based pressure signals are active simultaneously — increasing `-Xmx` is the primary remedy. NOTE: this is the total-heap free percent, not an old-gen-specific metric; it reflects the unified allocation headroom available to both young and old generations. |

#### What it is used for

ZGC runs a director thread that evaluates rules every `~1/DecisionHz` seconds (default 1s) and decides whether to start a young or old collection. Unlike G1's reactive model, ZGC is proactively managed: it starts GC **before** allocation stalls by predicting time-until-OOM. Without this event, you have no visibility into ticks where the director evaluated rules but decided not to collect — leaving you unable to distinguish "no pressure" from "pressure but another GC was already running" from "timer not due yet."

**Key diagnostic patterns**:
- `triggeredMinorRule="_z_allocation_rate"` with decreasing `timeUntilMinorOOM` → allocation rate is increasing cycle-over-cycle; if `timeUntilMinorOOM` drops below estimated GC duration (typically 0.1–0.5s for ZGC minor), allocation stalls are imminent before GC can complete. **Action**: increase `-XX:ZYoungGenerationSizePercent` to give the young gen more capacity, increasing `timeUntilMinorOOM` at the current allocation rate. If already at the maximum, increase `-Xmx`.
- `triggeredMinorRule="_z_high_usage"` → `heapFreePercent` dropped below 5%; the director triggered a minor GC based on occupancy rather than rate. `timeUntilMinorOOM` is null in this case (rate rule was not the trigger).
- `triggeredMajorRule="_z_allocation_rate"` → allocation rate exceeded the young-gen capacity threshold; ZGC triggered a major collection directly (minor was never evaluated — `triggeredMinorRule=null` here means preempted, not idle). This should be rare — frequent occurrence means the young gen is too small relative to allocation rate.
- Both rules null → ZGC evaluated all rules this tick and none fired; heap is not under sufficient pressure to warrant collection. Expected during low-load periods. Distinguish from the major-preempts-minor case by checking `triggeredMajorRule` first.
- `triggeredMajorRule="_z_warmup"` in steady state (> 500 young collections after JVM start) → ZGC still in warmup mode; the threshold for leaving warmup (`ZProactiveGCInverseGoodness` × full-heap occupancy time) was not met. This fires when the heap is very under-utilized (GC runs are short, pauses rarely happen) — typically in low-traffic applications or after a cold restart where heap never fully filled. **Action**: none required; warmup-triggered GCs do not indicate a problem. But if `triggeredMajorRule="_z_warmup"` is the dominant rule in production load, the JVM's heap is too large for the workload — it never fills enough to complete warmup. Consider lowering `-Xmx`.
- `heapFreePercent` declining > 3% per tick without a GC triggering → the occupancy-based threshold (5%) has not been reached yet, but pressure is building. This is an early-warning signal to watch, especially when `timeUntilMinorOOM` is also declining.

**Cross-event correlation**: join `jdk.ZDirectorRule` with `jdk.ZYoungGarbageCollection` or `jdk.ZOldGarbageCollection` by time proximity — every event where `triggeredMinorRule` or `triggeredMajorRule` is non-null should be followed (within `timeUntilMinorOOM` seconds) by a corresponding GC event. If a triggered-rule event is NOT followed by a GC event within the predicted window, the director intended to start a GC but something blocked it (e.g., a concurrent GC was already running). Join with `jdk.ZAllocationStall` by time window: if `jdk.ZAllocationStall` events appear within seconds of a `jdk.ZDirectorRule` tick where `timeUntilMinorOOM` was already near zero, the director's prediction was accurate but the GC did not start in time — this identifies cases where the 1-second tick interval is too coarse for the allocation rate. If `jdk.ZAllocationStall` events appear on ticks where `timeUntilMinorOOM` was large (> 5s), the allocation rate calculation is under-predicting actual consumption rate — check `heapFreePercent` decline rate against `timeUntilMinorOOM` across consecutive ticks for calibration accuracy.

`rule`, `generation`, `interval`, `maxAllocRate`, `allocRateVariancePct`, `freeBytes`, `freePercent`, `timeUntilGC`, `timeUntilOOM`, `gcDuration`, `gcCPUTime`, `gcWorkers`, `usedBytes`, `usedThreshold`, `proactiveEnabled`, `acceptableGCInterval`, `timeSinceLastGC`, `usedUntilEnabled`, `timeUntilEnabled`, `extraYoungGCTime`, `oldGCTime`, `lookahead`, `extraYoungGCTimeForLookahead`.

#### Why existing events don't cover this

- `jdk.ZYoungGarbageCollection`: fires after a GC is chosen and completed; records `tenuringThreshold`, `pause` duration, and cause. Does not capture ticks where no GC triggered — the most important case for proactive diagnosis. No `timeUntilMinorOOM`, no rule name, no heap-free fraction at decision time.
- `jdk.ZOldGarbageCollection`: same limitation — outcome event after an old collection completes; records `pause`, cause, and GC ID. No director rule fields, no `heapFreePercent`, no `timeUntilMinorOOM`, and no non-triggering ticks.
- `jdk.ZAllocationStall`: fires when an allocating thread had to stall waiting for memory — this is the **failure case** that ZGC's proactive director is supposed to prevent. `jdk.ZDirectorRule` is complementary: it shows the prevention-side decisions; `jdk.ZAllocationStall` shows when prevention failed. If `jdk.ZAllocationStall` events appear despite `jdk.ZDirectorRule` showing `timeUntilMinorOOM > 2s`, the rate model is under-predicting actual consumption.
- `jdk.GarbageCollection` (base): records GC completion with cause, duration, and GC ID — no director rule fields, no non-triggering ticks. The `cause` string is `"ZAllocationRate"` when the alloc-rate rule fires, but does not distinguish `_z_allocation_rate_static` from `_z_allocation_rate_dynamic`, and carries no `timeUntilMinorOOM` or `heapFreePercent` at decision time.
- `jdk.ZStatisticsCounter` and `jdk.ZStatisticsSampler`: **experimental** events (`experimental="true"` in `metadata.xml` — not enabled by default, not stable API). They expose internal ZGC metric counters/samplers by opaque enum ID, not structured director rule evaluations. They do not provide per-tick trigger reasoning or `timeUntilMinorOOM`.
- No existing JFR event captures ZGC director rule evaluation or non-triggering ticks — the complete silence on idle or below-threshold ticks is the fundamental gap this event fills. Every tick where `triggeredMinorRule=null` and `triggeredMajorRule=null` currently produces no JFR record; the only way to distinguish "heap is genuinely idle" from "allocation pressure is building toward the trigger threshold" is with this event's `heapFreePercent` and `timeUntilMinorOOM` fields.

#### External references

[JEP 439: Generational ZGC](https://openjdk.org/jeps/439) (production default since JDK 24):

> "ZGC uses a director thread that continuously evaluates a set of heuristic rules to decide when to start young and old collections. The rules consider allocation rate, heap occupancy, timer intervals, and warmup phase."

Oracle ZGC Tuning Guide — [ZGC](https://docs.oracle.com/en/java/javase/26/gctuning/z-garbage-collector1.html):

> "ZGC starts garbage collection proactively, before allocation stalls occur, by predicting when the heap will fill based on the current allocation rate."

`jdk.ZDirectorRule` directly exposes the director tick data that drives this proactive triggering — currently only visible via `-Xlog:gc+director=debug`. The `timeUntilMinorOOM` field is the director's prediction of heap exhaustion, the core value behind ZGC's proactive model.

#### Open questions / upstream concerns

1. **All-debug source**: `zDirector.cpp` has zero `log_info` sites. This is the hardest case to justify to upstream. The argument must combine three points: (a) the director tick data is production-relevant and there is no other way to observe non-triggering ticks; (b) JFR's access model is independent of `-Xlog` level — the code executes unconditionally in production builds, and JFR only gates on the JFR-enabled flag; (c) the event can be gated (see OQ2) to emit only on trigger ticks and near-OOM ticks, dramatically reducing recording volume. The best approach for the upstream submission: propose the log-level promotion of the most relevant director log messages from `log_debug` to `log_info` as part of the same PR — this addresses the root concern while adding JFR coverage simultaneously. The `timeUntilMinorOOM` field in particular deserves `log_info` promotion: it is ZGC's primary OOM-prevention metric and should be visible without enabling debug logging.
2. **Recommendation**: gate the event on "at least one rule fired OR `timeUntilMinorOOM < threshold` OR `heapFreePercent < 10%`". Emitting every second (~86,400/day) even when idle generates significant recording overhead with no diagnostic value. The recommended filter: emit when `triggeredMinorRule != null || triggeredMajorRule != null || (timeUntilMinorOOM != null && timeUntilMinorOOM < 30.0) || heapFreePercent < 10.0`. This captures all trigger decisions, early-warning ticks where the heap is approaching exhaustion, AND ticks where the occupancy is building toward the 5% `_z_high_usage` threshold — the precise gap that ZGC's proactive model is designed to detect. The `heapFreePercent < 10.0` condition fires when occupancy passes 90% free-to-capacity — twice the trigger threshold — providing two ticks of warning before `rule_minor_high_usage` fires at 5%. Since `heapFreePercent` is computed from `stats._heap` (always available at `start_gc()`), this gate requires no additional struct accumulation.
3. **`timeUntilMinorOOM` and `minorFreeBytes` struct accumulation — concrete design**: `timeUntilMinorOOM` is computed as a local variable inside `rule_minor_allocation_rate_dynamic()` and does not flow up to `start_gc()`. `minorFreeBytes` is also local to the alloc-rate rule. The implementation requires a small output struct:

```cpp
struct ZDirectorResult {
  double time_until_minor_oom = -1.0;   // -1 = not evaluated
  size_t minor_free_bytes = 0;
};
```

`make_minor_gc_decision()` returns `ZDirectorResult` alongside the `GCCause::Cause`. `rule_minor_allocation_rate_dynamic()` populates `time_until_oom` into the struct before returning. The `heapFreePercent` field is independently computable from `stats._heap._used` and `stats._heap._soft_max_heap_size` (both in scope at `start_gc()`) and does NOT require the struct. The struct change is ~15 lines across 3 functions — non-trivial but well-bounded. This is the correct implementation approach; the alternative (emitting without `timeUntilMinorOOM`) loses the most diagnostic value of the event.

---

### 14. jdk.PSAdaptiveSizePolicy

#### Verdict

**Propose with caveats.** Debug-level source. The three-source coordination is simpler than it appears: `compute_desired_sizes()` and `compute_old_gen_shrink_bytes()` both execute within `ParallelScavengeHeap::resize_after_young_gc()` and the throughput/pause fields from `print_stats()` are accessible as policy accessor methods at the same call site. A single JFR event at the end of `resize_after_young_gc()` captures all fields without struct accumulation.

#### The question it answers

"Why did Parallel GC resize eden, survivor, or old-gen this cycle, and is the adaptive policy converging or fighting itself?"

`jdk.PSHeapSummary` and `jdk.GCHeapSummary` carry the resulting sizes. They do not carry the throughput and pause goals, the promotion model estimates, or the old-gen shrink calculation inputs that drove the sizing decision. This information is entirely invisible in JFR today. Critically, you cannot detect the most problematic pattern — a policy that oscillates: eden grows to meet throughput, pauses exceed the goal, eden shrinks, throughput drops, repeat. Without the per-cycle decision inputs, this feedback loop looks identical to "heap is correctly sized" in existing JFR data.

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

**Exact log message** ([`psYoungGen.cpp:367`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/psYoungGen.cpp#L367)):
```
log_debug(gc, ergo)("Desired size eden: %zu K, survivor: %zu K",
    eden_size / K, survivor_size / K);
```

Log tag: `log_debug(gc,ergo)` — ALL sites are debug level.

**Eden sizing decision tree** ([`psAdaptiveSizePolicy.cpp:86-149`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/psAdaptiveSizePolicy.cpp#L86)):

```cpp
// psAdaptiveSizePolicy.cpp:86
size_t PSAdaptiveSizePolicy::compute_desired_eden_size(bool is_survivor_overflowing, size_t cur_eden) {
  const double throughput_goal = 1.0 - (1.0 / (1.0 + GCTimeRatio));  // e.g. GCTimeRatio=4 → goal=0.80

  if (mutator_time_percent() < throughput_goal) {
    // Branch 1: THROUGHPUT BELOW GOAL → grow eden
    // new_eden = min(expected_gc_distance/gc_distance * cur_eden, increase_eden(cur_eden))
    log_debug(gc, ergo)("Adaptive: throughput (actual vs goal): %.3f vs %.3f ; eden delta: + %zu K", ...);
    return new_eden;  // larger than cur_eden
  }

  if (minor_gc_time_estimate() > gc_pause_goal_sec()) {
    // Branch 2: PAUSE EXCEEDS GOAL → shrink eden to reduce GC pause time
    log_debug(gc, ergo)("Adaptive: pause (ms) (actual vs goal): %.1f vs %.1f", ...);
    return decrease_eden_for_minor_pause_time(cur_eden);  // smaller than cur_eden
  }

  if (gc_distance < min_gc_distance) {
    // Branch 3: GC FREQUENCY TOO HIGH → grow eden (less frequent GC needed)
    log_debug(gc, ergo)("Adaptive: gc-distance (predicted vs goal): %.3f vs %.3f", ...);
    return new_eden;  // larger than cur_eden
  }

  if (!is_survivor_overflowing && promoted_bytes_estimate() < 1*K) {
    if (predicted_gc_distance > gc_distance_target) {
      // Branch 4: SHRINK GC DISTANCE → shrink eden slightly to prevent GC from becoming too rare
      log_debug(gc, ergo)("Adaptive: shrinking gc-distance (predicted vs threshold): %.3f vs %.3f", ...);
      return cur_eden - delta;  // slightly smaller
    }
  }

  log_debug(gc, ergo)("Adaptive: eden unchanged");
  return cur_eden;  // no change
}
```

The first branch that matches wins. The `edenSizingBranch` field (see Fields table) captures which branch fired: `"throughput_grow"` for Branch 1, `"pause_shrink"` for Branch 2, `"distance_grow"` for Branch 3, `"distance_shrink"` for Branch 4, `"unchanged"` when none triggered.
```
GC pause thread (within PSScavenge::invoke)
  → PSScavenge::invoke()   [psScavenge.cpp:305](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/psScavenge.cpp#L305)
    → size_policy->print_stats(_survivor_overflow)   [psScavenge.cpp:431](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/psScavenge.cpp#L431)
    → heap->resize_after_young_gc()   [psScavenge.cpp:432](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/psScavenge.cpp#L432)
      → ParallelScavengeHeap::resize_after_young_gc()   [parallelScavengeHeap.cpp:889](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/parallelScavengeHeap.cpp#L889)
        → PSYoungGen::resize_after_young_gc()   [psYoungGen.cpp:476](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/psYoungGen.cpp#L476)
          → compute_desired_sizes()   [psYoungGen.cpp:337](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/psYoungGen.cpp#L337)
        → size_policy->compute_old_gen_shrink_bytes()   [parallelScavengeHeap.cpp:906](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/parallelScavengeHeap.cpp#L906)
```

**All three emission points are within the same `ParallelScavengeHeap::resize_after_young_gc()` call** (plus `print_stats` which is called immediately before it). A JFR event can be emitted at the end of `resize_after_young_gc()` with all fields in scope or passed down via struct.

**Cadence**: Once per young GC collection.

**Thread**: GC pause thread (within `PSScavenge::invoke`).

#### Fields

| Field | Source | Nullable? | Tuning use |
|---|---|---|---|
| `startTime` | Standard JFR | No | Timestamp of young GC pause end (fires at the end of `resize_after_young_gc()`). Correlate with `jdk.GarbageCollection` on `gcId` to join sizing decision with pause outcome. Consecutive `startTime` gaps show the inter-GC interval; if consistently short (< 0.5s) despite `edenSizingBranch="throughput_grow"`, the policy wants to grow but heap constraints prevent it. |
| `throughput` | `mutator_time_percent()` — `(total_time - gc_time) / total_time`, windowed average | No | **Primary goal metric**: the fraction of time NOT spent in GC. Goal = `1 - 1/(1+GCTimeRatio)`. With `GCTimeRatio=4` (Parallel default when `-XX:MaxGCPauseMillis` is unset), goal = 80% mutator time. If `throughput < goal`, Branch 1 fires and eden grows. |
| `minorPauseMs` | `minor_gc_time_estimate() * 1000` — smoothed minor GC time; minor only, does NOT include major pauses | No | **Pause goal input**: if this exceeds `pauseGoalMs` → algorithm enters pause-reduction branch and shrinks eden. Note: `pauseGoalMs` is essentially unlimited by default in Parallel GC — set `-XX:MaxGCPauseMillis` to activate pause control. |
| `pauseGoalMs` | `_gc_pause_goal_sec * 1000` from `MaxGCPauseMillis` (default `max_uintx-1` ≈ unlimited) | No | **Pause control activation flag**: if this equals `max_uintx` (or very large), pause control is disabled and the `pause_shrink` branch of `edenSizingBranch` can never fire — throughput goal is the only active driver. When set to a finite value, pause control has absolute priority over throughput: if `minorPauseMs > pauseGoalMs`, eden shrinks regardless of throughput state. **Action if goal is persistently unmet** (`minorPauseMs > pauseGoalMs` every cycle): either the goal is too aggressive for this heap size (increase it), the live set is too dense (increase `-Xmx`), or the goal conflicts with the throughput target (causing oscillation — see `edenSizingBranch`). Unset `-XX:MaxGCPauseMillis` to disable pause control and let throughput drive sizing. |
| `gcDistanceSec` | `_gc_distance_seconds_seq.davg()` — exponentially-weighted average of inter-GC wall-clock intervals | No | **GC frequency indicator**: how far apart young GCs are on average — the policy uses this to keep GC neither too rare nor too frequent. `gcDistanceSec < 0.3s` = GC running more than 3× per second; eden is undersized for the current allocation rate. **Actions**: check `edenSizingBranch` — if it is `throughput_grow`, the policy already knows eden is too small and is trying to grow it; if `MaxNewSize` is blocking growth, raise it. If `gcDistanceSec < 0.3s` AND `edenSizingBranch` is NOT `throughput_grow`, either `MaxGCPauseMillis` is too tight (preventing eden growth) or the allocation rate is genuinely too high for any reasonable eden size — the only remedy is increasing `-Xmx` so old gen can absorb more promotions while eden grows. |
| `gcDistanceSecLast` | `_gc_distance_seconds_seq.last()` — raw last inter-GC interval (no smoothing); this is the actual branching variable in Branches 3 and 4 of `compute_desired_eden_size()` | No | Branch input: the policy uses `.last()` (not the average) to decide whether to grow or shrink eden for GC distance control. **Spike detection**: if `gcDistanceSecLast` suddenly drops to < 0.1s while `gcDistanceSec` (the smoothed average) is still > 0.5s, one very fast GC fired — likely a small allocation surge that exhausted eden unusually quickly. If sustained (`gcDistanceSecLast < gcDistanceSec / 3` for ≥ 3 consecutive events), the workload has a persistent bimodal allocation pattern (fast bursts followed by quiet periods) — the smoothed `gcDistanceSec` is masking real pressure. Action: cross-reference `promotedBytesLast` on those fast-GC events — if it's elevated, the burst included a promotion wave. |
| `promotedBytesEstimate` | `promoted_bytes_estimate()` = `_promoted_bytes.davg() + _promoted_bytes.dsd()` — weighted average plus one standard deviation of promoted bytes; this is the base class `AdaptiveSizePolicy::promoted_bytes_estimate()` at [`adaptiveSizePolicy.hpp:203`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shared/adaptiveSizePolicy.hpp#L203). Adding one SD creates a conservative upper estimate that is the input to `minFreeBytes` for old-gen shrink gating. | No | **Old-gen pressure predictor**: monotonically growing across cycles = promotions are accelerating; divide by `gcDistanceSec` to get promotion rate in bytes/s. If promotion rate exceeds the old GC reclaim rate, old-gen will fill between major GCs. Sudden spike (e.g., 10× relative to prior value) = a large allocation burst was promoted directly to old gen — investigate survivor overflow (`survivorOverflow=true` on the same or adjacent event) or a humongous allocation that bypassed survivor altogether. **Threshold**: if `promotedBytesEstimate > oldGenFree`, the old-gen size estimator predicts a future overflow without a major GC — increase `-Xmx` or reduce `NewRatio` to give old gen more capacity. |
| `promotedBytesLast` | `_promoted_bytes.last()` — actual bytes promoted last cycle (no smoothing) | No | **Burst detector**: compare against `promotedBytesEstimate` (the smoothed estimate). If `promotedBytesLast >> promotedBytesEstimate` (e.g., 3× or more), a single GC cycle promoted far more than the rolling average predicted — this is a promotion burst, typically from a large object allocation or survivor overflow. Cross-reference with `survivorOverflow=true` on the same event — if both fire together, the burst came from survivor being full. If `survivorOverflow=false` but `promotedBytesLast` is still large, the burst came from direct old-gen allocation (humongous object or very long-lived object that bypassed survivor). A single outlier is usually transient; if `promotedBytesLast` remains elevated across 3+ cycles, the allocation pattern has shifted. |
| `survivorOverflow` | Boolean: survivor space was full, forcing premature promotion to old gen | No | `true` → objects that are still young were forced into old gen, increasing old-gen pressure. Indicates survivor too small for the live young set. **Action**: decrease `-XX:SurvivorRatio` (default 8 = eden 8× survivor; lower value = larger survivor space) to give survivor more capacity, or reduce `-XX:MaxTenuringThreshold` so objects promote earlier and stop filling survivor. Note the direction: `-XX:SurvivorRatio` is the eden-to-survivor ratio, so a *lower* value gives survivor *more* space (not less). |
| `desiredEden` | Captured at `PSYoungGen::compute_desired_sizes()` — policy's desired eden size this cycle | No | **Policy intent vs. actual size**: compare to actual eden size from `jdk.PSHeapSummary.edenSpace.size` — if `desiredEden > actual eden`, heap size or `-XX:NewSize`/`-XX:MaxNewSize` constraints are preventing the policy from allocating the eden it wants. `desiredEden` growing over many cycles = throughput pressure is driving larger eden; if it plateaus at `MaxNewSize`, the new-gen ceiling is the bottleneck. `desiredEden` shrinking = pause-time pressure is winning (`edenSizingBranch="pause_shrink"`). Tracking `desiredEden` alongside `edenSizingBranch` gives the full policy trajectory — what the policy wants and why it changed. |
| `desiredSurvivor` | Captured at `PSYoungGen::compute_desired_sizes()` — policy's desired survivor space size this cycle | No | Compare to `desiredEden`: if `desiredSurvivor` grows while `desiredEden` shrinks, the policy is shifting capacity toward survivor to absorb `survivorOverflow`. If `desiredSurvivor` is stable and small while `survivorOverflow=true` fires, the survivor space is genuinely too small for the promotion rate — increase `-XX:SurvivorRatio` |
| `edenSizingBranch` | Which branch of `compute_desired_eden_size()` fired: `"throughput_grow"` (Branch 1: `mutator_time_percent() < throughput_goal`, eden grows), `"pause_shrink"` (Branch 2: `minor_gc_time_estimate() > gc_pause_goal_sec()`, eden shrinks), `"distance_grow"` (Branch 3: GC too frequent vs. distance goal, eden grows), `"distance_shrink"` (Branch 4: GC too rare vs. distance threshold, eden shrinks slightly), `"unchanged"` (no condition triggered). Replaces `throughputEdenIncrease` — non-null, carries the branch label, more readable than the raw delta. | No | **Policy state label**. `"unchanged"` majority (> 90% of events) = policy has converged to a stable eden size — healthy. `"throughput_grow"` repeatedly = mutator time below goal; eden growing; normal during warmup or after heap shrink. `"pause_shrink"` repeatedly = pauses exceed goal; eden shrinking; expect reduced throughput. **Oscillation** (`throughput_grow` → `pause_shrink` on consecutive events): throughput and pause goals are in conflict — the pause goal is too tight for this eden size. Action: raise `-XX:MaxGCPauseMillis` or disable it entirely; alternatively, verify `-XX:GCTimeRatio` and ensure the throughput goal is realistic. `"distance_grow"` = GC frequency too high; eden growing to space out collections — normal in high-allocation-rate workloads. `"distance_shrink"` = GC too rare; rare in practice; means the policy is tightening frequency slightly to avoid eden becoming so large that a single GC is unexpectedly long. |
| `oldGenFree` | From `compute_old_gen_shrink_bytes()` — current old gen free bytes at shrink evaluation time | No | How much headroom exists in old gen. If `oldGenFree < minFreeBytes`, the policy will not shrink old gen regardless of how long the heap has been oversized. `oldGenFree` growing steadily = live set is shrinking (e.g., after a large cache eviction) and the policy may eventually start returning heap. |
| `minFreeBytes` | `max(padded_average_promoted_in_bytes(), promotion_rate_estimate × 600s)` — 10-minute promotion lookahead floor from [`psAdaptiveSizePolicy.cpp:165`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/psAdaptiveSizePolicy.cpp#L165): `static constexpr double lookahead_sec = 10 * 60` | No | Old gen will not be shrunk below `minFreeBytes`; if `oldGenFree < minFreeBytes`, no shrink occurs. High `minFreeBytes` relative to `oldGenFree` → policy won't shrink old gen even if it looks underused (promotion rate is too high). `minFreeBytes` decreasing over time = promotion rate is falling — old gen shrink will eventually activate. |
| `shrinkBytes` | Old gen shrink amount this cycle; 0 if no shrink triggered | No | Non-zero → policy is actively shrinking old gen. **Risk pattern**: `shrinkBytes > 0` followed within 2–3 cycles by `promotedBytesEstimate` exceeding the new `(oldGenFree - shrinkBytes)` remaining capacity = the shrink removed headroom that promotions then immediately filled. This usually manifests as a Full GC within ~5 cycles of the shrink. Correlate across consecutive events: if `shrinkBytes > 0` on event N and `survivorOverflow=true` or `promotedBytesEstimate > (oldGenFree of event N) - shrinkBytes` on event N+2, the shrink was too aggressive — the 10-minute lookahead (`minFreeBytes` computation) underestimated the actual promotion rate. Consider reducing `GCTimeRatio` to make the policy less aggressively sized. |

**DROPPED fields**:
- `throughputGoal`: equals `1 - 1/(1+GCTimeRatio)` — derivable from `jdk.GCConfiguration.gcTimeRatio` without needing a new field.
- `promotionRateEstimate`, `promotionRateLast`: derivable as `promotedBytes / gcDistance` from existing fields.

#### What it is used for

Parallel GC's adaptive size policy implements a feedback control loop that resizes eden, survivor, and old gen each young collection to meet two competing goals: throughput (mutator time fraction) and pause time (`MaxGCPauseMillis`). Without this event, `jdk.PSHeapSummary` shows you the resulting sizes but not the reasoning — you cannot tell whether the policy is throughput-limited or pause-limited, or why the old gen is expanding.

**Diagnosis patterns**:
- `survivorOverflow=true` repeatedly → survivor is too small; objects are bypassing it and aging into old gen prematurely. Decrease `-XX:SurvivorRatio` (lower = larger survivor space) or reduce `-XX:MaxTenuringThreshold` to promote earlier.
- `promotedBytesEstimate` growing monotonically across 3+ consecutive events → old-gen promotions are accelerating; the policy's model predicts progressively more bytes will survive each young collection. **Two root causes to distinguish**: (a) `survivorOverflow=true` on any of those events = objects are bypassing survivor and going directly to old gen because survivor space is full — reduce `-XX:SurvivorRatio` to make survivor larger, which is the primary fix; (b) `survivorOverflow=false` and `promotedBytesEstimate` is growing = the application's live set is genuinely expanding (more long-lived objects being created per cycle) — check for allocation pattern changes in the application (e.g., growing caches, session state accumulation). In case (b), no GC tuning prevents the growth; the object graph size must be bounded at the application level. In both cases, a growing `promotedBytesEstimate` eventually triggers `shrinkBytes > 0` to resize old gen upward — if old gen cannot expand due to `-Xmx`, a Full GC is imminent.
- `minorPauseMs > pauseGoalMs` and `desiredEden < currentEden` → policy is actively shrinking eden to reduce pause time; if throughput also degrades, `MaxGCPauseMillis` is set too low.
- `gcDistanceSec` very short (< 0.5s) → GC running more than twice per second; eden is undersized for the current allocation rate. Cross-reference `edenSizingBranch`: if it is `throughput_grow`, the policy is already growing eden but is constrained by `MaxNewSize` — raise it. If `edenSizingBranch` is `pause_shrink` or `distance_shrink` despite short inter-GC intervals, a conflicting goal is preventing eden growth — `MaxGCPauseMillis` is too tight for this workload's allocation rate; raise or remove it.
- `shrinkBytes > 0` frequently → policy is repeatedly shrinking old gen; if `promotedBytesEstimate` exceeds `(oldGenFree - shrinkBytes)` within 2–3 cycles, the shrink triggered a promotion overflow and a Full GC is likely. Reduce aggressiveness by increasing `GCTimeRatio` or disabling automatic shrink via `-XX:-UseAdaptiveSizePolicy`.
- **Oscillating policy** (`throughput < goal` → eden grows → `minorPauseMs > pauseGoalMs` → eden shrinks → `throughput < goal` again): the policy is fighting itself. Visible as alternating `edenSizingBranch="throughput_grow"` and `edenSizingBranch="pause_shrink"` in successive events. Resolution: raise `-XX:MaxGCPauseMillis` to give the throughput goal more room, or unset it entirely if pause control is not needed.

**Cross-event correlation**: join `jdk.PSAdaptiveSizePolicy` with `jdk.GarbageCollection` on `gcId` to validate whether the policy's `minorPauseMs` measurement matches the actual pause duration in `jdk.GarbageCollection.duration` — if they diverge significantly, the policy is using a stale or smoothed pause estimate (`.davg()`) that doesn't reflect the last cycle accurately. Join with `jdk.PSHeapSummary` on `gcId` to compare `desiredEden` (policy intent) against `edenSpace.size` (actual resulting eden size) — a persistent `desiredEden > edenSpace.size` indicates `MaxNewSize` or `-Xmn` constraints are preventing the policy from achieving its desired configuration, and the constraint rather than the policy is determining the heap layout. Join with `jdk.GCOverheadLimitExceeded` (proposed) by time proximity: if a `jdk.PSAdaptiveSizePolicy` event with `shrinkBytes > 0` and `promotedBytesEstimate` near old-gen free space is immediately followed by a `jdk.GCOverheadLimitExceeded` event, the shrink decision directly contributed to the OOM by reducing old-gen capacity below the promotion demand. Track `edenSizingBranch` as a time series: three or more consecutive alternating `throughput_grow`/`pause_shrink` events is the oscillation signal — the policy has no stable equilibrium at the current `MaxGCPauseMillis` setting for this workload's allocation rate.

#### Why existing events don't cover this

- `jdk.PSHeapSummary`: records resulting sizes — `edenSpace`, `fromSpace`, `toSpace`, `oldSpace` (used/size/start). These are the *outputs* of the sizing policy. They do not carry `mutator_time_percent()`, `minor_gc_time_estimate()`, `_gc_distance_seconds_seq`, `promoted_bytes_estimate()`, or any field from `compute_desired_eden_size()` or `compute_old_gen_shrink_bytes()`.
- `jdk.GCHeapSummary`: records `heapSpace` (reserved/committed/used) as a GC-boundary snapshot — the same limitation as `jdk.PSHeapSummary`. Does not carry any of: `throughput`, `minorPauseMs`, `pauseGoalMs`, `edenSizingBranch`, `desiredEden`, `gcDistanceSec`, `survivorOverflow`, `promotedBytesEstimate`, `shrinkBytes`, or `oldGenFree`.
- `jdk.TenuringDistribution` (Parallel): records per-age-bucket counts; shows the age distribution that *results from* the current tenuring threshold, not the `promoted_bytes_estimate()` model or the `survivorOverflow` signal that drives policy adjustments.
- `jdk.GCConfiguration`: records `gcTimeRatio`, `newRatio` etc. at startup; does not expose the per-cycle `mutator_time_percent()` measurement or whether the throughput goal was currently met.
- No existing JFR event exposes the `PSAdaptiveSizePolicy` per-cycle decision inputs, branch taken (`throughput_grow`/`pause_shrink`/`distance_grow`/`distance_shrink`/`unchanged`), or the old-gen shrink calculation. Specifically: `mutator_time_percent()`, `minor_gc_time_estimate()`, `_gc_distance_seconds_seq.davg()`, `promoted_bytes_estimate()`, and `compute_old_gen_shrink_bytes()` output are absent from all existing JFR events. The `edenSizingBranch` which-path-fired discriminator has no analogue in any other JFR event.

#### External references

Oracle JDK 26 Parallel GC Tuning Guide — [Parallel Collector](https://docs.oracle.com/en/java/javase/26/gctuning/parallel-collector1.html):

> "The throughput goal is measured in terms of the time spent doing garbage collection versus the time spent outside of garbage collection... The goal is specified by the command-line option `-XX:GCTimeRatio=<N>`, which sets the ratio of garbage collection time to application time to `1 / (1 + <N>)`."

> "Maximum garbage collection pause time: The maximum pause time goal is specified with the command-line option `-XX:MaxGCPauseMillis=<N>`. This is interpreted as a hint that pause times of <N> milliseconds or less are desired; by default, no maximum pause-time goal."

> "The goals are maximum pause-time goal, throughput goal, and minimum footprint goal, and goals are addressed in that order."

> "Statistics such as average pause time kept by the collector are updated at the end of each collection. The tests to determine if the goals have been met are then made and any needed adjustments to the size of a generation is made."

Oracle GC Ergonomics Guide — [Ergonomics](https://docs.oracle.com/en/java/javase/26/gctuning/ergonomics.html):

> "The heap grows or shrinks to a size that will support the chosen throughput goal."

These Oracle descriptions map directly to the event fields: `throughput` (mutator time fraction) vs. `pauseGoalMs` (`MaxGCPauseMillis`), and the priority order (pause > throughput > footprint) determines which branch of `compute_desired_eden_size()` fires. `jdk.PSAdaptiveSizePolicy` makes these real-time policy decisions observable in JFR for the first time.

#### Open questions / upstream concerns

1. **Debug-level source**: all three emission points are `log_debug(gc,ergo)`. Same justification applies: the data is in the product build, and JFR provides production access without requiring debug log activation. **Recommended approach**: promote `print_stats()` from `log_debug(gc,ergo)` to `log_info(gc,ergo)` in the same PR. This is justified by the same Oracle documentation that describes adaptive sizing goals — the per-cycle sizing decision output should be observable at a production log level. The `psAdaptiveSizePolicy.cpp:63` log message is the primary tuning-relevant output; promoting just that line (not the per-branch logs inside `compute_desired_eden_size`) keeps the info-level output concise while giving JFR access to all fields.
2. **Three-source coordination — simpler than it looks**: `print_stats()` fires at `psScavenge.cpp:431`, then `resize_after_young_gc()` is called at line 432 and contains both `compute_desired_sizes()` and `compute_old_gen_shrink_bytes()` calls. A single JFR event emission at the end of `ParallelScavengeHeap::resize_after_young_gc()` can capture all fields from old-gen shrink and young-gen sizing in one place. The only field from `print_stats()` that needs to be read is the `throughput`/`minorPauseMs` from the policy object — those are available as accessor methods (`size_policy->mutator_time_percent()`, `size_policy->minor_gc_time_estimate()`) and can be called from within `resize_after_young_gc()` at emit time without any struct accumulation.
3. **Resolved**: replace `throughputEdenIncrease` (nullable, branch-specific) with a non-null `edenSizingBranch` string field: `"throughput_grow"` / `"pause_shrink"` / `"distance_grow"` / `"distance_shrink"` / `"unchanged"` — see fields table. This eliminates the nullable field, captures which branch fired, and is more informative than the raw eden-delta (which is computable from `jdk.PSHeapSummary` diffs anyway). The branch name is the first matching condition in the priority-ordered `if`/`else if` chain at [`psAdaptiveSizePolicy.cpp:86-149`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/psAdaptiveSizePolicy.cpp#L86).
4. **Resolved**: both `gcDistanceSec` and `gcDistanceSecLast` are needed. Source: `compute_desired_eden_size()` at [`psAdaptiveSizePolicy.cpp:88`](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/psAdaptiveSizePolicy.cpp#L88) uses `_gc_distance_seconds_seq.last()` (raw last value) as the decision variable `gc_distance` in Branches 3 and 4. The `.davg()` (exponentially-weighted average) is used only in the log statement at line 69. Both are needed: `.last()` is the actual branching input; `.davg()` shows the trend for detecting oscillation patterns.

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
