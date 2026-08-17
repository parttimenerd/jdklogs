# JFR Proposed Events — Research Index

Research documents supporting the proposed JFR events in `data/jfr-proposed-events.json`.

## Documents

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

## Event Status Summary (as of 2026-08-17)

| Event | Priority | Status |
|---|---|---|
| `jdk.NativeHeapTrim` | high | Upstream PR closed; narrow re-proposal recommended |
| `jdk.GCOverheadLimitExceeded` | high | G1 support added JDK 26; no JFR event yet |
| `jdk.G1ConcurrentRefinementSweep` | high | Zero coverage; strong production case |
| `jdk.G1ConcurrentRefinementPolicy` | high | Zero coverage; per-pause policy counterpart |
| `jdk.G1CollectionSetCandidates` | high | Zero coverage; two-path event (marking + retained) |
| `jdk.ZDirectorRule` | high | Zero coverage; sparse-field design needs upstream discussion |
| `jdk.PSAdaptiveSizePolicy` | high | Zero coverage |
| `jdk.ShenandoahMMU` | high | Zero coverage; needs gcId for correlation |
| `jdk.ShenandoahCollectionDecision` | high | Zero coverage; spans multiple code sites |
| `jdk.ShenandoahCardStatistics` | high | Zero coverage; #ifndef PRODUCT guard needs resolution |
| `jdk.G1HeapResize` | medium | Zero coverage; shrink-path fields need label annotation |
| `jdk.ShenandoahReclaimProgress` | medium | Zero coverage; nullable fields for early-exit paths |
| `jdk.ZNMethodRegistration` | low | Weak production motivation; tableRebuilt needs new instrumentation |
| `jdk.StringDeduplicationStatistics` | low | **REDUNDANT** — jdk.StringDeduplication shipped in JDK 26 |

## Critique History

- **Critique pass 1** (2026-08-17): Initial 5 events added (NativeHeapTrim, G1ConcurrentRefinement, ZDirectorRule, PSAdaptiveSizePolicy, ShenandoahCollectionDecision)
- **Critique pass 2** (2026-08-17): G1ConcurrentRefinement split into Sweep+Policy; PSAdaptiveSizePolicy averaged/last fields; GCOverheadLimitExceeded diagnostic fields; ZDirectorRule early-exit semantics; ShenandoahMMU priority elevated; ShenandoahReclaimProgress redesigned as flat event; ZNMethodRegistration tableRebuilt added; ShenandoahCardStatistics gated to cumulative-only
- **Critique pass 4** (2026-08-17): Confirmed 0 of 18 proposals covered by JDK 26/27-dev; promoted G1CollectionSetCandidates (corrected from working doc — two separate selection paths: marking + retained, candidateType discriminator, groups concept, num_expensive_regions not a boolean) and G1HeapResize (CPU-usage deviation counter, shrink-only fields labeled, lowerThreshold/upperThreshold/gcCpuUsageTarget added, reason field removed — not a source variable); added marginOfError to ShenandoahCollectionDecision (zScore belongs to post-cycle path, not decision point); ZForwardingRemembered rejected (log lines print address pairs not counts, no aggregation infrastructure); wrote g1-collection-set-candidates.md and g1-heap-resize.md research docs
