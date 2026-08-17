# JFR Proposed Events — Research Index

Research documents supporting the proposed JFR events in `data/jfr-proposed-events.json`.

## Documents

### [Shenandoah Tenuring Threshold](shenandoah-tenuring-threshold.md)
How Shenandoah generational mode dynamically computes the tenuring threshold using mortality rate analysis. Covers the age census mechanism, the `compute_tenuring_threshold()` algorithm, `ShenandoahGenerationalCensusIgnoreOlderCohorts`, dark matter handling, and why this differs from G1/Parallel's static `MaxTenuringThreshold`. Supports `jdk.ShenandoahTenuringThreshold`.

### [G1 Concurrent Refinement](g1-concurrent-refinement.md)
How G1's dirty-card queue and concurrent refinement threads work. Covers the two distinct log sites (`print_refinement_stats` vs `adjust_threads_wanted`), card categories, the JDK 25 write barrier redesign (JEP 522), and why `jdk.G1ConcurrentRefinementSweep` + `jdk.G1ConcurrentRefinementPolicy` are needed.

### [ZGC Director Rules](zgc-director-rules.md)
How ZGC decides when to trigger Young and Old collections. Covers all rule types (Timer, AllocationRate dynamic/static, HighUsage, Warmup, Proactive), the early-exit evaluation model, the Major AllocationRate escalation path, and why the `jdk.ZDirectorRule` event is needed despite experimental `ZStatisticsCounter/Sampler` events.

### [Shenandoah Generational GC](shenandoah-generational.md)
How Shenandoah's generational mode (production-ready JDK 25, JEP 521) works. Covers collection types (young/old/global/mixed/degenerated/full), the regulator thread, remembered-set card statistics, MMU tracking, reclaim progress early-exit semantics, and the collection decision FSM. Supports `jdk.ShenandoahCardStatistics`, `jdk.ShenandoahMMU`, `jdk.ShenandoahReclaimProgress`, `jdk.ShenandoahCollectionDecision`.

### [Parallel GC Adaptive Sizing](parallel-gc-adaptive-sizing.md)
How `PSAdaptiveSizePolicy` implements the feedback loop for eden/survivor/old-gen sizing. Covers the throughput vs pause-time goal trade-off, gc-distance semantics, promoted bytes (averaged vs last), old-gen shrink, survivor overflow, and GCOverheadLimitExceeded in Parallel GC. Supports `jdk.PSAdaptiveSizePolicy` and `jdk.GCOverheadLimitExceeded`.

### [G1 Collection Set Candidates](g1-collection-set-candidates.md)
How G1 selects old-gen regions for mixed GC pauses. Covers the two separate selection paths (`select_candidates_from_marking()` and `select_candidates_from_retained()`), the groups concept, stop reasons, the optional evacuation threshold, and mixed-GC continuation decisions. Supports `jdk.G1CollectionSetCandidates`.

### [G1 Heap Resize Policy](g1-heap-resize.md)
How G1 resizes the committed heap between GC pauses using a CPU-usage deviation counter. Covers the `_gc_cpu_usage_deviation_counter` mechanism, upper/lower threshold derivation from `GCTimeRatio`, the shrink-path-only fields (`scaleFactorPct`, `freeRegions`, `regionsNeededForAlloc`), `atLimit` semantics, and the distinction from full-collection resizing. Supports `jdk.G1HeapResize`.

### [Native Heap Trimming](native-heap-trim.md)
Why native heap trimming matters for containerised JVMs (RSS bloat from glibc malloc arenas). Covers the `NativeHeapTrimmer` thread, trim operation mechanics, upstream PR history (JDK-8365306 closed), relationship to `jdk.ResidentSetSize`, and corrected `deltaBytes` sign semantics. Supports `jdk.NativeHeapTrim`.

### [ZGC Generational Mode](zgc-generational.md)
How ZGC selects a tenuring threshold each young collection. Covers the three selection paths (Promote All / ZTenuringThreshold config / Computed), the `compute_tenuring_threshold()` algorithm (life decay factor × log residency, scaled by allocation pressure), why `jdk.ZUncommit` already exists (EventZUncommit::commit() fires in update_statistics()), and why only the info-level result fields belong in the proposed event. Supports `jdk.ZGCTenuringThreshold`.

### [Event Consolidation & Emission-Point Analysis](event-consolidation.md)
Where each proposed event fires (exact function, call chain, cadence, thread), analysis of which events to merge/split, and field-level trimming recommendations. Key findings: `G1ConcurrentRefinementSweep`+`Policy` stay separate (different cadences/threads); `ShenandoahCollectionDecision`+`ReclaimProgress` stay separate (start vs end of cycle); `ZDirectorRule` should be redesigned as a per-tick summary (22 mostly-null fields → 6-field event); `ZNMethodRegistration.tableRebuilt` dropped (no source); `PSAdaptiveSizePolicy` loses 3 fields; `G1CollectionSetCandidates.continueMixed` dropped (different call site). `ShenandoahMMU.report()` path confirmed `log_debug`. Full emission-point table with calling function, cadence, and thread for all 16 events.


How Shenandoah generational mode decides when to start young and old collections. Covers the `log_trigger()` macro (resolves to `log_info(gc)` in production), the three adaptive heuristic trigger types (rate_average, rate_momentary, rate_accelerated), the three old heuristic triggers (expansion_failure, fragmentation, growth), the regulator FSM, and the `_margin_of_error_sd` field. Supports `jdk.ShenandoahCollectionDecision` trigger augmentation (critique pass 6).

## Event Status Summary (as of 2026-08-17, pass 7)

| Event | Priority | Status |
|---|---|---|
| `jdk.NativeHeapTrim` | high | Upstream PR (JDK-8365306) closed Dec 2025; narrow re-proposal recommended; `log_info(trimnative)` ✓; RSS collection gated on logging enabled — JFR impl must decouple |
| `jdk.GCOverheadLimitExceeded` | high | G1 support added JDK 26; no JFR event; **redesigned pass 7**: fires at OOM throw only (`log_info(gc)` in `satisfy_failed_allocation()`); counter-update path is `log_debug` |
| `jdk.ShenandoahMMU` | high | Zero coverage; `log_info(gc,ergo)` in `shenandoahMmuTracker.cpp:107,134` ✓; needs gcId for correlation |
| `jdk.ShenandoahCollectionDecision` | high | Zero coverage; primary anchor `log_info(gc,ergo)` at `shenandoahGenerationalControlThread.cpp:374`; trigger fields from `log_trigger()` (`log_info(gc)`); regulator thread entries in replaces annotated as `log_debug` |
| `jdk.G1ConcurrentRefinementSweep` | **medium** (↓ from high) | Zero coverage; **`log_debug(gc,refine)`** — below =info threshold; strong production case but debug-tier data |
| `jdk.G1ConcurrentRefinementPolicy` | **medium** (↓ from high) | Zero coverage; **`log_debug(gc,refine)`** — below =info threshold; per-pause policy counterpart |
| `jdk.G1CollectionSetCandidates` | **medium** (↓ from high) | Zero coverage; **`log_debug(gc,ergo,cset)`** — ALL candidate selection logs are debug level |
| `jdk.ZDirectorRule` | **medium** (↓ from high) | Zero coverage; **`log_debug(gc,director)`** — ALL zDirector.cpp rule logs are debug level; no `log_info` in entire file |
| `jdk.PSAdaptiveSizePolicy` | **medium** (↓ from high) | Zero coverage; **`log_debug(gc,ergo)`** — ALL psAdaptiveSizePolicy.cpp + psYoungGen.cpp sites are debug level |
| `jdk.G1HeapResize` | medium (unchanged) | Zero coverage; **`log_debug(gc,ergo,heap)`**; shrink-path fields need label annotation |
| `jdk.ShenandoahReclaimProgress` | medium | Zero coverage; `log_info(gc,ergo)` in `shenandoahMetrics.cpp:47,58,69,81` ✓; nullable fields for early-exit paths |
| `jdk.ShenandoahTenuringThreshold` | medium | Zero coverage; `log_info(gc,age)` in `shenandoahAgeCensus.cpp:258` ✓ |
| `jdk.ZGCTenuringThreshold` | medium | Zero coverage; `log_info(gc,reloc)` in `zGeneration.cpp:716` ✓; reason field distinguishes Promote All/ZTenuringThreshold/Computed |
| `jdk.ZNMethodRegistration` | low | Weak production motivation; `log_info(gc,nmethod)` in `zStat.cpp:1621` ✓; tableRebuilt needs new instrumentation |
| `jdk.StringDeduplicationStatistics` | low | **REDUNDANT** — `jdk.StringDeduplication` shipped in JDK 26 (PR #28015, merged Nov 2025) |
| `jdk.ShenandoahCardStatistics` | **blocked** | **BLOCKED** — data source is `#ifndef PRODUCT` guarded in `shenandoahCardStats.cpp`; requires moving stats collection to product build first |

## Critique History

- **Critique pass 1** (2026-08-17): Initial 5 events added (NativeHeapTrim, G1ConcurrentRefinement, ZDirectorRule, PSAdaptiveSizePolicy, ShenandoahCollectionDecision)
- **Critique pass 2** (2026-08-17): G1ConcurrentRefinement split into Sweep+Policy; PSAdaptiveSizePolicy averaged/last fields; GCOverheadLimitExceeded diagnostic fields; ZDirectorRule early-exit semantics; ShenandoahMMU priority elevated; ShenandoahReclaimProgress redesigned as flat event; ZNMethodRegistration tableRebuilt added; ShenandoahCardStatistics gated to cumulative-only
- **Critique pass 5** (2026-08-17): Local JDK source audit at /experiments/jdk — function names corrected in G1CollectionSet and G1HeapSizingPolicy replaces entries; ShenandoahCardStatistics log tag corrected (gc,remset) and demoted to 'blocked' priority (#ifndef PRODUCT guard confirmed in source — data not available in production builds, requires prerequisite code change); ShenandoahCollectionDecision replaces corrected (choose_collection_set_from_regiondata() has ShouldNotReachHere() body — replaced with actual log sites); ZDirectorRule replaces expanded with worker selection logs; new event jdk.ShenandoahTenuringThreshold promoted (shenandoahAgeCensus.cpp:258 log_info confirmed in product code outside #ifndef guard); wrote shenandoah-tenuring-threshold.md research doc
- **Critique pass 6** (2026-08-17): ZGC generational source audit — jdk.ZGCTenuringThreshold promoted (zGeneration.cpp:716 log_info(gc,reloc) confirmed production code, no JFR coverage; reason field distinguishes Promote All/ZTenuringThreshold/Computed paths); jdk.ZUncommit rejected as new proposal (already exists in metadata.xml:1248, EventZUncommit::commit() fires in update_statistics()); ShenandoahCollectionDecision augmented with triggerType + 6 nullable trigger-path fields from log_trigger() sites (confirmed log_info(gc) in shenandoahHeuristics.cpp:248); Shenandoah old heuristics triggers audited (expansion_failure/fragmentation/growth paths); wrote zgc-generational.md and shenandoah-heuristics.md research docs
- **Critique pass 7** (2026-08-17): Systematic log level audit of all 16 proposed events against JDK source — 5 events downgraded from high to medium (G1ConcurrentRefinementSweep, G1ConcurrentRefinementPolicy, G1CollectionSetCandidates, ZDirectorRule, PSAdaptiveSizePolicy) because ALL their cited log sites are `log_debug`, not `log_info`; GCOverheadLimitExceeded redesigned to fire at OOM throw point only (counter-update path is `log_debug`); NativeHeapTrim RSS collection constraint documented (gated on `logging_enabled` — JFR impl must decouple); ShenandoahCollectionDecision regulator thread replaces entries annotated as `log_debug`; upstream research via background agent confirmed NativeHeapTrim PR closed (JDK-8365306), StringDeduplication shipped (PR #28015), AllocationRequiringGC merged for Shenandoah (PR #30638); all other proposed gaps remain open with no upstream proposals found
