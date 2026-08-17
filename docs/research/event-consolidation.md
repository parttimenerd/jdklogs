# Event Consolidation & Emission-Point Analysis

**Critique pass 8 (2026-08-17)**

Two questions for each proposed event:

1. **Where does it fire?** — exact function, call chain, and cadence.
2. **Should it be merged, split, or trimmed?** — field overlap, co-emission, and signal clarity.

---

## Emission Points by Event

### `jdk.NativeHeapTrim` — `log_info(trimnative)`

**Fires in:** `NativeHeapTrimmer::Trimmer::execute_trim_and_log()`  
**Called from:** `NativeHeapTrimmer` background thread, periodic wakeup at `TrimNativeHeapInterval` ms  
**Cadence:** Once per trim operation; rate controlled by `-XX:TrimNativeHeapInterval`  
**Thread:** Dedicated `NativeHeapTrimmer` thread (not GC thread)

No merge candidate. Fires on a completely independent thread from all GC events.

---

### `jdk.GCOverheadLimitExceeded` — `log_info(gc)`

**Fires in:**
- `G1CollectedHeap::satisfy_failed_allocation()` at line ~1110  
- `ParallelScavengeHeap::satisfy_failed_allocation()` at line ~507  

**Called from:** Allocation fast-path failure → `attempt_allocation_humongous()` / `expand_heap_and_attempt_allocation()` → `satisfy_failed_allocation()`  
**Cadence:** Once per OOM throw; fires at most once per JVM lifetime (unless -XX:-ExitOnOutOfMemoryError)  
**Thread:** Allocating application thread

No merge candidate. This is a one-shot pre-OOM event. The two `replaces` entries are its only emission points.

---

### `jdk.G1ConcurrentRefinementSweep` — `log_debug(gc,refine)`

**Fires in:**
- `G1ConcurrentRefineSweepState::handle_ongoing_refinement_at_safepoint()` — sweep interrupted at safepoint
- `G1ConcurrentRefineSweepState::complete_refinement()` — sweep completed normally

**Called from:** Concurrent refinement control loop (`G1ConcurrentRefineThread`)  
**Cadence:** Once per refinement sweep; can fire multiple times between GC pauses  
**Thread:** G1 concurrent refinement thread (not GC pause)

**Merge analysis with `jdk.G1ConcurrentRefinementPolicy`:**

These two events fire at **different cadences** from **different threads**:
- `Sweep`: concurrent thread, potentially many per GC pause interval
- `Policy`: `G1Policy::record_young_collection_end()` at end of young GC pause + `G1ConcurrentRefine::adjust_num_threads_periodically()` (control thread, periodic)

Merging them into one event would create an awkward multi-cadence design — most Sweep events would have null policy fields, and the Policy event (once per GC pause) would occasionally co-occur with a Sweep. **Keep separate.**

**Field trimming candidates:**

- `cardsNotParsable` — regions mid-transition; useful for diagnosing G1 region state races but low production value. Consider dropping.
- `cardsNoCrossRegion` — high `= good locality` is useful signal for card filtering efficiency. Keep.
- `cardsRefersToCset` vs `cardsStillRefersToCset` — the delta between these two is the "CSet churn indicator". If only one can be kept, `cardsStillRefersToCset` (surviving cset-references after refinement = ongoing work) is more actionable. Consider dropping `cardsRefersToCset`.

---

### `jdk.G1ConcurrentRefinementPolicy` — `log_debug(gc,refine)` + `log_debug(gc,ergo,refine)`

**Fires in:**
- `G1Policy::record_young_collection_end()` — at end of each young GC pause
- `G1ConcurrentRefine::adjust_threads_wanted()` — called from `adjust_num_threads_periodically()` on concurrent refinement control thread

**Called from:** Two separate call paths:
1. `G1YoungCollector::post_evacuate_collection_set()` → `G1Policy::record_young_collection_end()`
2. `G1ConcurrentRefine::adjust_num_threads_periodically()` (periodic, not at safepoint)

**Cadence:** Once per young GC pause (record_young_collection_end path) + periodically between pauses (adjust_threads_wanted path)  
**Thread:** GC pause thread + concurrent refinement control thread

**Field trimming candidates:**

- `predictedPendingCards` — is the predicted value at next GC, derived from rates. Already partially redundant with `pendingCardsTarget` and the rates. Consider dropping.
- `timeUntilNextGC` — useful for correlating with refinement time budget. Keep.
- Both `predictedRefineRate` and `dirtiedCardRate` together are the refinement capacity vs. demand pair. Keep both — the ratio is the key signal.

---

### `jdk.G1CollectionSetCandidates` — `log_debug(gc,ergo,cset)`

**Fires in:**
- `G1CollectionSet::select_candidates_from_marking()` — marking candidate selection
- `G1CollectionSet::select_candidates_from_retained()` — retained candidate selection

**Called from:** `G1CollectionSet::finalize_old_part()` → called from `G1CollectionSet::finalize_initial_collection_set()` during young GC pause preparation  
**Cadence:** Twice per mixed GC pause (once for Marking path, once for Retained path); zero times during non-mixed pauses  
**Thread:** GC pause thread (during collection set finalization, before evacuation)

**Field trimming candidates:**

- `minRegions` and `maxRegions` — policy inputs that rarely change; derivable from G1 flags. Consider dropping to slim the event.
- `availableGroups` — groups are card-set groups (not region count); low actionability vs `availableRegions`. Consider dropping.
- `predictedOptionalTimeMs` — niche; only nonzero when optional regions were selected. Consider dropping.
- `timeRemainingMs` — useful for diagnosing time budget exhaustion. Keep.
- `continueMixed` — this field is from `G1Policy::decide_on_concurrent_start_pause()`, a **different call site** from the two candidate selection functions. Emitting it would require capturing state from a different code location than the event's primary anchor. Consider dropping or moving to a separate `jdk.G1MixedGCDecision` micro-event.
- `overBudgetRegions` — key signal: nonzero means G1 added regions despite predicted time exceeded, increasing pause risk. Keep.

---

### `jdk.G1HeapResize` — `log_debug(gc,ergo,heap)`

**Fires in:** `G1HeapSizingPolicy::young_collection_resize_amount()` (line ~302, ~319, ~337) — three `log_resize()` calls within the function for different paths (expand, shrink, no-resize)  
**Also:** `G1HeapSizingPolicy::young_collection_shrink_amount()` — separate log call for shrink-path details  
**Called from:** `G1CollectedHeap::resize_heap_after_young_collection()` — called at end of every young GC pause  
**Cadence:** Once per young GC pause (even when no resize occurs — resize_bytes may be 0)  
**Thread:** GC pause thread

**Field trimming candidates:**

- `shortTermGcCpuUsagePct` + `longTermGcCpuUsagePct` — the core signal; both needed (short-term drives the decision, long-term provides context). Keep both.
- `lowerThresholdPct` + `upperThresholdPct` + `gcCpuUsageTargetPct` — these are derived from `GCTimeRatio` and rarely change. Borderline; drop if event is too wide.
- `scaleFactorPct`, `freeRegions`, `regionsNeededForAlloc` — shrink-path-only; null on expand. If upstream reviewers object to nullable fields, consider emitting a second event type or dropping these three.
- `atLimit` — compact boolean signal for "heap is at min/max and can't be resized further". Keep.

---

### `jdk.ZDirectorRule` — `log_debug(gc,director)`

**Fires in:** All rule functions in `zDirector.cpp` — `rule_minor_timer`, `rule_minor_allocation_rate_dynamic`, `rule_minor_allocation_rate_static`, `rule_minor_high_usage`, `rule_major_timer`, `rule_major_warmup`, `rule_major_proactive`, `rule_major_allocation_rate`  
**Called from:** `make_minor_gc_decision()` and `make_major_gc_decision()` → `start_gc()` → director tick loop  
**Cadence:** Every director tick (default ~1s); early-exit means at most ONE Minor rule and ONE Major rule fire per tick (the first rule that triggers GC exits the decision)  
**Thread:** ZGC director thread

**The sparse-field problem is severe.** This event has 22 fields but each rule populates only 3-5. Most fields are null for most firings. This is the event most likely to receive upstream pushback on design.

**Consolidation option — two-event split:**
1. `jdk.ZGCTrigger` — fires only when a rule *triggers* GC (boolean `triggered=true`); captures the winning rule name + the 3-5 relevant fields for that rule. One event per GC cycle max.
2. Keep current `jdk.ZDirectorRule` for the non-triggering evaluations (currently all fields null for losing rules — very low signal).

**Better option — per-tick summary event:**  
Single `jdk.ZDirectorStats` emitted once per tick with: `generation`, `triggeredMinorRule` (String, null if no GC), `triggeredMajorRule` (String, null if no GC), `timeUntilMinorOOM` (from alloc-rate rule), `minorFreeBytes`, `majorFreePercent`. The per-rule field explosion is avoided by collapsing to the tick result.

**Field trimming (if keeping per-rule design):**
- `proactiveEnabled`, `usedUntilEnabled`, `timeUntilEnabled` — Proactive disabled-branch fields; low production relevance (Proactive rarely fires). Consider dropping disabled-branch fields.
- `lookahead`, `extraYoungGCTimeForLookahead` — Major AllocationRate escalation detail; keep `extraYoungGCTime` and `oldGCTime`, drop lookahead.
- Worker selection fields (`Select Minor GC Workers` logs) — these are separate from the rule evaluation and could be a separate event or dropped entirely.

---

### `jdk.PSAdaptiveSizePolicy` — `log_debug(gc,ergo)`

**Fires in:**
- `PSAdaptiveSizePolicy::print_stats()` — after every young GC
- `PSAdaptiveSizePolicy::compute_old_gen_shrink_bytes()` — when old gen is eligible to shrink
- `PSYoungGen::compute_desired_sizes()` — at end of young-gen sizing evaluation

**Called from:** `PSScavenge::invoke()` (young collection) → `size_policy->print_stats(_survivor_overflow)`  
**Cadence:** Once per young GC collection  
**Thread:** GC pause thread (within PSScavenge::invoke)

**Merge analysis:** All three source functions fire within the same `PSScavenge::invoke()` call, so they can be combined into one event with one emission point. No split needed. The current design already merges them.

**Field trimming candidates:**

- `gcDistanceSec` + `gcDistanceSecLast` — keeping both (average + last) is verbose but the divergence between average and last indicates GC frequency instability. Keep both.
- `promotedBytesEstimate` + `promotedBytesLast` — same pattern; keep both for the same reason.
- `promotionRateEstimate` + `promotionRateLast` — redundant with the above; derivable as `promotedBytes / gcDistance`. **Drop both** — they add width without independent signal.
- `throughputEdenIncrease` — only nonzero on throughput-improvement branch. Nullable. Low value.
- `throughputGoal` — re-derived from `GCTimeRatio` flag; rarely changes; available from `jdk.GCConfiguration`. Consider dropping.
- `minFreeBytes` — the old-gen shrink threshold based on a 10-minute promotion forecast. Keep as it answers "why didn't old gen shrink?".

---

### `jdk.ShenandoahMMU` — `log_info(gc,ergo)` ✓

**Fires in:**
- `ShenandoahMmuTracker::update_utilization()` — line 107 (end-of-cycle path, major collection types)
- `ShenandoahMmuTracker::record_old_marking_increment()` — line 134 (old marking increment, subsumed by next gc report)
- `ShenandoahMmuTracker::report()` — called from `ShenandoahMmuTask::task()` which is a `PeriodicTask` at `GCPauseIntervalMillis` (default ~200ms)

**Called from:**
- `update_utilization()`: called from Shenandoah generational control thread at end of each collection phase
- `report()`: called from dedicated `ShenandoahMmuTask` periodic timer thread

**Cadence:**
- End-of-cycle: once per completed GC phase
- Periodic: every `GCPauseIntervalMillis` ms (~200ms default)

**Note:** The `report()` path is **`log_debug(gc)`**, not `log_info`. The event's only `log_info` anchors are in `update_utilization()` and `record_old_marking_increment()`. The periodic path should either be dropped from the event or noted as a debug-tier addition.

**Merge analysis:** No merge candidate. MMU is unique to Shenandoah and the information (GCU%, MU% over a period) is not captured in any other event.

**Field trimming candidates:**

- `isPeriodicSample` — needed to distinguish the two paths. Keep.
- `phase` — nullable for periodic path; carries the collection type ("Concurrent Young GC" etc.) for the end-of-cycle path. Essential for correlation. Keep.
- `periodSeconds` — the measurement window. Essential for interpreting GCU%/MU%. Keep.

---

### `jdk.ShenandoahReclaimProgress` — `log_info(gc,ergo)` ✓

**Fires in:** `ShenandoahMetricsSnapshot::is_good_progress()` — lines 47, 58, 69, 81  
**Called from:**
- `ShenandoahDegenGC::op_final_roots()` (line ~330) — end of degenerated GC
- `ShenandoahFullGC::op_gc()` (line ~119) — end of full GC

**Cadence:** Once per degenerated or full GC; **does NOT fire after normal concurrent cycles**  
**Thread:** GC thread (STW)

**Important cadence note:** This event only fires when the JVM runs a degenerated or full GC — not on every cycle. For an application doing only normal concurrent Shenandoah cycles, this event never fires. The `goodProgress=false` signal is what precedes a full GC escalation. This is actually *correct* framing — it's a degeneration/escalation diagnostic.

**Merge analysis with `jdk.ShenandoahCollectionDecision`:**

`ShenandoahReclaimProgress` fires at the **end** of a degenerated/full GC (post-collection assessment). `ShenandoahCollectionDecision` fires at the **start** of a collection (pre-collection decision). They are at opposite ends of the GC lifecycle. Merging them would conflate a decision-point event with an outcome-assessment event. **Do not merge.**

**Field trimming:**

Early-exit semantics mean only the first 1-2 dimensions are usually populated. The nullable-field explosion (12 fields, most null most of the time) is a legitimate upstream concern.

**Consolidation option:** Emit a simplified 4-field event instead:
- `freePercent` (actual / capacity)
- `goodProgress` (boolean)
- `failedDimension` (String: `"free_space"` | `"used_space"` | `"internal_frag"` | `"external_frag"` | null if passed)
- `badProgressCount` (from `_consecutive_degenerated_gcs_without_progress` in `ShenandoahCollectorPolicy`)

The `badProgressCount` reaching 2 triggers a Full GC — this is the single most actionable field. The exact byte counts for each dimension are useful in tooling but may be too granular for a first proposal.

---

### `jdk.ShenandoahCollectionDecision` — mixed (`log_info(gc,ergo)` + `log_trigger()` = `log_info(gc)`)

**Fires in (log_info paths):**
- `ShenandoahGenerationalControlThread::service_concurrent_normal_cycle()` line 374: `"Start GC cycle (%s)"`
- `ShenandoahHeuristics::log_trigger()` — resolves to `log_info(gc)` — called from `trigger_average_allocation_rate()`, `trigger_accelerating_allocation_rate()`, `ShenandoahOldHeuristics::should_start_gc()` (fragmentation / growth / expansion_failure branches)
- `ShenandoahOldHeuristics::prepare_for_old_collections()` line 569: `"Old-Gen Immediate Garbage..."` — `log_info(gc,ergo)` ✓

**Called from:**
- `ShenandoahGenerationalControlThread` main loop → `service_concurrent_normal_cycle()` → fires at GC cycle start
- Heuristic trigger functions called from `ShenandoahRegulatorThread::regulate_young_and_old_cycles()` (but trigger logging is inside heuristic, fired before regulator completes the decision)

**Cadence:** Once per GC cycle start  
**Thread:** Shenandoah generational control thread (primary anchor) + regulator thread (trigger fields)

**Merge analysis:**

This event already aggregates multiple code sites (control thread + heuristic trigger sites). It is the "decision event" for the Shenandoah GC cycle start. The trigger fields (triggerType + 6 nullable fields) represent a second embedded sub-event for the *why-it-was-triggered* question.

**Split option:** Separate `jdk.ShenandoahGCTrigger` event for the trigger-path fields (triggerType + its 6 nullable fields), fired when a trigger fires; separate from the control-thread decision event. This would make the trigger event fire earlier (at heuristic evaluation time) rather than being attached to the cycle start. But it loses the correlation with the actual cycle that resulted.

**Field trimming candidates:**

- `immediateGarbage` + `immediateRegions` — from `prepare_for_old_collections()` (mixed GC only). Useful but only populated for mixed GC path. Consider dropping `immediateGarbage` (bytes) and keeping only `immediateRegions` (count is more actionable).
- `mixedCandidates` + `mixedRegionsSelected` + `oldEvacuationBudget` + `defragRegions` — all mixed-GC-path-only, all null for young/old/global cycles. Consider condensing to just `mixedRegionsSelected` (the outcome) and dropping the inputs.
- `available` + `softMaxCapacity` — these are captured at decision time. Keep both — the ratio is the allocation pressure indicator.
- `zScore` + `marginOfError` — statistical fields from adaptive heuristic. The z-score is at trigger time; marginOfError is post-cycle accounting. If marginOfError is read from object state (not a log), it's valid at trigger time, not post-cycle. Reconsider whether this truly reflects the value that was used to make the decision.

---

### `jdk.ShenandoahTenuringThreshold` — `log_info(gc,age)` ✓

**Fires in:** `ShenandoahAgeCensus::update_tenuring_threshold()` — line 258  
**Called from:** `ShenandoahAgeCensus::update_census()` → `ShenandoahGeneration::prepare_regions_and_collection_set()` (young collection planning, after marking, before CSet finalization)  
**Cadence:** Once per young collection (when census data is updated)  
**Thread:** Shenandoah control thread (within collection preparation phase)

**Merge analysis:** No merge candidate. Algorithm is unique to Shenandoah generational mode and produces a scalar result (threshold + supporting mortality data). Firing point is early in the collection pipeline, before evacuation.

**Field trimming:** The current fields (tenuringThreshold, min, max) are already minimal. The mortality-rate algorithm inputs (computed in `compute_tenuring_threshold()`) are at `log_debug` level — they could be added as nullable debug fields but are not needed for a first proposal.

---

### `jdk.ZGCTenuringThreshold` — `log_info(gc,reloc)` ✓

**Fires in:** `ZGenerationYoung::select_tenuring_threshold()` — line 716  
**Called from:** `ZGeneration::select_relocation_set()` (line 250) → called during young collection relocation set selection, after `selector.select()` produces liveness data  
**Cadence:** Once per young ZGC collection  
**Thread:** ZGC concurrent thread (during relocation set selection)

**Merge analysis:** No merge candidate. Analogous to `jdk.ShenandoahTenuringThreshold` but for ZGC; different algorithm (`life decay × log residency` vs Shenandoah's mortality rate). Both are medium priority and both fire once per young collection.

**Merge option — `jdk.TenuringThresholdSelection`?**  
G1/Parallel already have `jdk.TenuringDistribution` (per-age-bucket sizes). A shared `jdk.TenuringThresholdSelection` event covering ZGC + Shenandoah generational mode could reduce event count. However:
- The ZGC and Shenandoah algorithms are completely different
- They fire at different points in the collection lifecycle
- Combining them with a `collector` discriminator field would create a mixed-schema event where most fields are null
- **Recommendation: keep as two separate events.** The symmetry (both have `tenuringThreshold` + `reason`) is cosmetic, not structural.

---

### `jdk.ZNMethodRegistration` — `log_info(gc,nmethod)` ✓

**Fires in:** `ZStatNMethods::print()` — line 1621  
**Called from:** `ZStatPhaseGeneration::register_end()` — at the end of each ZGC generation collection phase (both young and old)  
**Cadence:** Once per ZGC generation collection (young or old)  
**Thread:** ZGC concurrent thread (inside `ZStatPhaseGeneration::register_end`)

**Issue:** The `tableRebuilt` field has no source. `ZStatNMethods::print()` only logs the two counters (`_nregistered`, `_nunregistered`). A boolean "table was rebuilt this cycle" requires new instrumentation in `ZNMethodTable`. This is not a trivial addition.

**Recommendation:** Drop `tableRebuilt` entirely. The event without it is still useful (registered nmethod count is GC-safety-relevant — high `staleNMethodSlots` indicates zombie accumulation). The trimmed event has 3 fields: `startTime`, `registeredNMethods`, `staleNMethodSlots`.

---

### `jdk.StringDeduplicationStatistics` — `log_info` (already implemented as `jdk.StringDeduplication`)

**Status:** REDUNDANT — `jdk.StringDeduplication` shipped in JDK 26 (PR #28015). If any gap remains, the right fix is to extend the existing event with cumulative totals (`totalDedupedBytes`, `totalNewUnknownBytes`), not add a new event. Remove from proposals.

---

### `jdk.ShenandoahCardStatistics` — `log_info(gc,remset)` but BLOCKED

**Status:** BLOCKED — `ShenandoahCardStats::log()` is `#ifndef PRODUCT` guarded. This event cannot fire in production without a prerequisite code change. No emission point to document. Remove from active proposals; track as a blocked upstream prerequisite.

---

## Consolidation Recommendations Summary

| Action | Events | Rationale |
|---|---|---|
| **Keep separate** | `G1ConcurrentRefinementSweep` + `G1ConcurrentRefinementPolicy` | Different cadences, different threads |
| **Keep separate** | `ShenandoahCollectionDecision` + `ShenandoahReclaimProgress` | Start-of-cycle vs end-of-cycle; different GC types |
| **Keep separate** | `ZGCTenuringThreshold` + `ShenandoahTenuringThreshold` | Different algorithms, different lifecycles |
| **Consider per-tick summary** | `jdk.ZDirectorRule` | 22 mostly-null fields per firing; a per-tick summary with 6 fields would be cleaner |
| **Drop field** | `jdk.ZNMethodRegistration.tableRebuilt` | No source exists; requires new instrumentation |
| **Drop fields** | `jdk.PSAdaptiveSizePolicy`: `promotionRateEstimate`, `promotionRateLast`, `throughputGoal` | Derivable or rarely-changes |
| **Drop field** | `jdk.G1CollectionSetCandidates.continueMixed` | Different call site from main event anchor |
| **Drop field** | `jdk.G1CollectionSetCandidates.minRegions`, `maxRegions` | Derivable from G1 flags |
| **Simplify** | `jdk.ShenandoahReclaimProgress` | 12 nullable fields → 4-field event with `failedDimension` + `badProgressCount` |
| **Remove entirely** | `jdk.StringDeduplicationStatistics` | REDUNDANT — event shipped in JDK 26 |
| **Suspend** | `jdk.ShenandoahCardStatistics` | BLOCKED — `#ifndef PRODUCT` guard requires upstream prerequisite |
| **Reconsider** | `jdk.ShenandoahMMU.isPeriodicSample` path | `report()` is `log_debug`, not `log_info` — periodic path should be noted as debug-tier |
| **Reconsider** | `jdk.G1HeapResize` on no-resize ticks | Fires every young GC even with resizeBytes=0; consider gating emission |

---

## Priority Re-ranking After Consolidation

**High priority — `log_info` anchor, strong production case:**

| Event | Emission Point | Fires When |
|---|---|---|
| `jdk.NativeHeapTrim` | `execute_trim_and_log()` | Every trim operation |
| `jdk.GCOverheadLimitExceeded` | `satisfy_failed_allocation()` | Once at OOM throw |
| `jdk.ShenandoahMMU` | `update_utilization()` | End of each Shenandoah GC phase |
| `jdk.ShenandoahCollectionDecision` | `service_concurrent_normal_cycle()` + `log_trigger()` | Every Shenandoah GC cycle start |

**Medium priority — `log_info` anchor, narrower use case:**

| Event | Emission Point | Fires When |
|---|---|---|
| `jdk.ShenandoahReclaimProgress` | `is_good_progress()` | End of degenerated/full GC only |
| `jdk.ShenandoahTenuringThreshold` | `update_tenuring_threshold()` | Every Shenandoah young collection |
| `jdk.ZGCTenuringThreshold` | `select_tenuring_threshold()` | Every ZGC young collection |
| `jdk.ZNMethodRegistration` | `ZStatNMethods::print()` | End of every ZGC generation collection |

**Medium priority — `log_debug` anchor (JFR would expose in production for first time):**

| Event | Emission Point | Fires When |
|---|---|---|
| `jdk.G1ConcurrentRefinementSweep` | `complete_refinement()` | End of every concurrent refinement sweep |
| `jdk.G1ConcurrentRefinementPolicy` | `record_young_collection_end()` | End of every young GC pause |
| `jdk.G1CollectionSetCandidates` | `finalize_old_part()` | Every mixed GC pause (twice) |
| `jdk.G1HeapResize` | `young_collection_resize_amount()` | Every young GC pause |
| `jdk.ZDirectorRule` | `make_minor/major_gc_decision()` | Every director tick (~1s) |
| `jdk.PSAdaptiveSizePolicy` | `PSScavenge::invoke()` | Every Parallel young GC |

**Remove / suspend:**

| Event | Reason |
|---|---|
| `jdk.StringDeduplicationStatistics` | REDUNDANT — `jdk.StringDeduplication` already shipped |
| `jdk.ShenandoahCardStatistics` | BLOCKED — `#ifndef PRODUCT` guard |

---

## References

- `src/hotspot/share/runtime/trimNativeHeap.cpp:141,150,155`
- `src/hotspot/share/gc/g1/g1CollectedHeap.cpp:986,1110`
- `src/hotspot/share/gc/g1/g1ConcurrentRefine.cpp:340,377,587,598`
- `src/hotspot/share/gc/g1/g1Policy.cpp:803`
- `src/hotspot/share/gc/g1/g1CollectionSet.cpp:377,383,389,414,531,720`
- `src/hotspot/share/gc/g1/g1HeapSizingPolicy.cpp:73,172,216,302,319,328,337`
- `src/hotspot/share/gc/z/zDirector.cpp:607,631,820`
- `src/hotspot/share/gc/z/zStat.cpp:711,730,1620`
- `src/hotspot/share/gc/z/zGeneration.cpp:205,250,704,716`
- `src/hotspot/share/gc/parallel/psScavenge.cpp:431`
- `src/hotspot/share/gc/parallel/psAdaptiveSizePolicy.cpp:63`
- `src/hotspot/share/gc/shenandoah/shenandoahMmuTracker.cpp:42,107,134,156,173`
- `src/hotspot/share/gc/shenandoah/shenandoahMetrics.cpp:38,47,58,69,81`
- `src/hotspot/share/gc/shenandoah/shenandoahDegeneratedGC.cpp:330`
- `src/hotspot/share/gc/shenandoah/shenandoahFullGC.cpp:119`
- `src/hotspot/share/gc/shenandoah/shenandoahGenerationalControlThread.cpp:374`
- `src/hotspot/share/gc/shenandoah/shenandoahAgeCensus.cpp:147,167,252,258`
- `src/hotspot/share/gc/shenandoah/shenandoahGeneration.cpp:251,286`
