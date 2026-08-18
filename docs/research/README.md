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

## Event Status Summary (as of 2026-08-18, pass 20)

| Event | Priority | Status |
|---|---|---|
| `jdk.NativeHeapTrim` | high | Upstream PR (JDK-8365306) closed Dec 2025; narrow re-proposal recommended; `log_info(trimnative)` ✓; RSS collection gated on logging enabled — JFR impl must decouple |
| `jdk.GCOverheadLimitExceeded` | high | G1 support added JDK 26; no JFR event; fires at OOM throw only (`log_info(gc)` in `satisfy_failed_allocation()`); `GCOverheadLimitThreshold=5` is a `develop` flag (fixed in prod) |
| `jdk.ShenandoahMMU` | high | Zero coverage; `log_info(gc,ergo)` in `shenandoahMmuTracker.cpp:107,134` ✓; phase strings confirmed: "Concurrent Young GC", "Degenerated Young GC", etc. |
| `jdk.ShenandoahCollectionDecision` | high | Zero coverage; `decision` field confirmed from `gc_mode_name()` (line 765); trigger fields from `log_trigger()` (`log_info(gc)`); prepare_for_old_collections log_info at lines 567-572 confirmed |
| `jdk.G1ConcurrentRefinementSweep` | **medium** (↓ from high) | Zero coverage; **`log_debug(gc,refine)`** — below =info threshold; strong production case but debug-tier data |
| `jdk.G1ConcurrentRefinementPolicy` | **medium** (↓ from high) | Zero coverage; **`log_debug(gc,refine)`**; GC-pause path (g1Policy.cpp:1022) and periodic path (g1ConcurrentRefine.cpp:598) have different field shapes; threadsWanted not available on GC-pause path |
| `jdk.G1CollectionSetCandidates` | **medium** (↓ from high) | Zero coverage; **`log_debug(gc,ergo,cset)`** — ALL candidate selection logs are debug level |
| `jdk.ZDirectorRule` | **medium** (↓ from high) | Zero coverage; **`log_debug(gc,director)`**; start_gc() tries major first — if major fires, minor never evaluated; struct accumulation required for per-rule fields |
| `jdk.PSAdaptiveSizePolicy` | **medium** (↓ from high) | Zero coverage; **`log_debug(gc,ergo)`**; MaxGCPauseMillis default is unlimited (G1 overrides to 200ms); PSScavenge::invoke() at line 305 |
| `jdk.G1HeapResize` | medium (unchanged) | Zero coverage; **`log_debug(gc,ergo,heap)`**; deviationCounter field added; sigmoid scaling (steepness=6.0, inflection=1.0) confirmed |
| `jdk.ShenandoahReclaimProgress` | medium | Zero coverage; `log_info(gc,ergo)` in `shenandoahMetrics.cpp:47,58,69,81` ✓; free_space is hard gate (immediate false); ShenandoahCriticalFreeThreshold default = 1% |
| `jdk.ShenandoahTenuringThreshold` | medium | Zero coverage; `log_info(gc,age)` in `shenandoahAgeCensus.cpp:258` ✓ |
| `jdk.ZGCTenuringThreshold` | medium | Zero coverage; `log_info(gc,reloc)` in `zGeneration.cpp:716` ✓; reason field distinguishes Promote All/ZTenuringThreshold/Computed |
| `jdk.ZNMethodRegistration` | low | Weak production motivation; `log_info(gc,nmethod)` in `zStat.cpp:1621` ✓; jdk.NMethodSweep does not exist — removed incorrect reference |
| `jdk.StringDeduplicationStatistics` | low | **REDUNDANT** — `jdk.StringDeduplication` shipped in JDK 26 (PR #28015, merged Nov 2025) |
| `jdk.ShenandoahCardStatistics` | **blocked** | **BLOCKED** — data source is `#ifndef PRODUCT` guarded in `shenandoahCardStats.cpp`; requires moving stats collection to product build first |

## Critique History

- **Critique pass 1** (2026-08-17): Initial 5 events added (NativeHeapTrim, G1ConcurrentRefinement, ZDirectorRule, PSAdaptiveSizePolicy, ShenandoahCollectionDecision)
- **Critique pass 2** (2026-08-17): G1ConcurrentRefinement split into Sweep+Policy; PSAdaptiveSizePolicy averaged/last fields; GCOverheadLimitExceeded diagnostic fields; ZDirectorRule early-exit semantics; ShenandoahMMU priority elevated; ShenandoahReclaimProgress redesigned as flat event; ZNMethodRegistration tableRebuilt added; ShenandoahCardStatistics gated to cumulative-only
- **Critique pass 5** (2026-08-17): Local JDK source audit — function names corrected in G1CollectionSet and G1HeapSizingPolicy; ShenandoahCardStatistics demoted to 'blocked'; jdk.ShenandoahTenuringThreshold promoted (shenandoahAgeCensus.cpp:258 log_info confirmed)
- **Critique pass 6** (2026-08-17): ZGC generational source audit — jdk.ZGCTenuringThreshold promoted; ShenandoahCollectionDecision augmented with trigger fields; wrote zgc-generational.md and shenandoah-heuristics.md
- **Critique pass 7** (2026-08-17): Systematic log level audit — 5 events downgraded from high to medium; GCOverheadLimitExceeded redesigned to OOM throw point only; upstream research confirmed NativeHeapTrim PR closed, StringDeduplication shipped
- **Critique passes 8–9** (2026-08-17): Deep field sourcing — exact variable names, escalation thresholds, G1HeapSizingPolicy sigmoid, G1CollectionSet stopReason strings, PSAdaptiveSizePolicy three-source coordination, ShenandoahReclaimProgress CONSECUTIVE_BAD_DEGEN_PROGRESS_THRESHOLD=2
- **Critique pass 10** (2026-08-17): Links and quotes — all [file.cpp:N] references hyperlinked; exact log message quotes for all 14 events; PSAdaptiveSizePolicy call chain line numbers corrected
- **Critique passes 11–15** (2026-08-17): Source corrections — GCId::peek() semantics fixed (returns _next_id not last id); ShenandoahMMU degenerated phase strings corrected; G1ConcurrentRefinementPolicy two-path field asymmetry documented; ZDirectorRule major-preempts-minor semantics corrected; ShenandoahCollectionDecision decision field corrected to gc_mode_name() values; GCOverheadLimitThreshold=5 is develop flag (fixed in production); ShenandoahCriticalFreeThreshold default=1%; MaxGCPauseMillis default unlimited for Parallel GC; G1RefinementThresholdStep→G1RSetUpdatingPauseTimePercent; jdk.NMethodSweep removed (does not exist); G1ConcRefinementThreads (not G1ConcurrentRefinementThreads)
- **Critique pass 16** (2026-08-18): PSAdaptiveSizePolicy call chain correction — compute_desired_sizes() and compute_old_gen_shrink_bytes() confirmed in same ParallelScavengeHeap::resize_after_young_gc() scope; exact eden/survivor log quote added (psYoungGen.cpp:367)
- **Critique passes 17–20** (2026-08-18): Source code snippets added — is_good_progress() full source (shenandoahMetrics.cpp:38), compute_tenuring_threshold() loop (shenandoahAgeCensus.cpp:264), ZGC select/compute_tenuring_threshold() (zGeneration.cpp:704-816), sigmoid_function() (g1HeapSizingPolicy.cpp:97), stopReason from print_finish_message() (g1CollectionSet.cpp:399), start_gc() early-exit (zDirector.cpp:820), compute_desired_eden_size() 4-branch decision tree (psAdaptiveSizePolicy.cpp:86), execute_trim_and_log() RSS gate (trimNativeHeap.cpp:135), G1 GCOverheadLimitExceeded throw point (g1CollectedHeap.cpp:995-1111), update_utilization() GCU% formula (shenandoahMmuTracker.cpp:86), gc_mode_name() enum mapping (shenandoahGenerationalControlThread.cpp:765)
