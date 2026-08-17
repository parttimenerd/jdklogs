# Proposed new JFR events for GC log coverage (G1, ZGC, Parallel, Shenandoah, Serial, shared)

**Working analysis for upstreaming. Last critique: pass 7 (2026-08-17)**

## Critique Pass 7 Verdicts (2026-08-17) — Log Level Audit

All 16 proposed events audited against JDK source at `/experiments/jdk`. Key finding: 6 high-priority events target `log_debug` code paths (not `log_info`), requiring priority adjustments. JFR events targeting debug-tier code are still valid proposals — they expose data currently inaccessible in production without debug logging — but they should not be classified as high priority.

| Event | Priority Change | Log Level | Action |
|---|---|---|---|
| `jdk.G1ConcurrentRefinementSweep` | high → **medium** | `log_debug(gc,refine)` | Priority adjusted; `logLevel`+`logLevelNote` fields added |
| `jdk.G1ConcurrentRefinementPolicy` | high → **medium** | `log_debug(gc,refine)` | Priority adjusted; `logLevel`+`logLevelNote` fields added |
| `jdk.G1CollectionSetCandidates` | high → **medium** | `log_debug(gc,ergo,cset)` | Priority adjusted; `logLevel`+`logLevelNote` fields added |
| `jdk.G1HeapResize` | medium (unchanged) | `log_debug(gc,ergo,heap)` | Confirmed; `logLevel`+`logLevelNote` fields added |
| `jdk.ZDirectorRule` | high → **medium** | `log_debug(gc,director)` | Priority adjusted; `logLevel`+`logLevelNote` fields added |
| `jdk.PSAdaptiveSizePolicy` | high → **medium** | `log_debug(gc,ergo)` | Priority adjusted; `logLevel`+`logLevelNote` fields added |
| `jdk.GCOverheadLimitExceeded` | high (unchanged) | mixed (`log_debug` counter update; `log_info` throw) | **REDESIGNED**: now fires only at OOM throw (the only `log_info` site); removed per-GC counter-update entries from replaces |
| `jdk.NativeHeapTrim` | high (unchanged) | `log_info(trimnative)` | `logLevel` added; RSS conditional collection constraint documented |
| `jdk.ShenandoahCollectionDecision` | high (unchanged) | mixed | `logLevel: mixed` + `logLevelNote` added; CRITICAL: regulator thread entries (`shenandoahRegulatorThread.cpp`) are `log_debug` — annotated; primary anchor is `shenandoahGenerationalControlThread.cpp:374 log_info(gc,ergo)` + `log_trigger()` sites |
| All others (`jdk.ShenandoahMMU`, `jdk.ShenandoahReclaimProgress`, `jdk.ShenandoahTenuringThreshold`, `jdk.ZGCTenuringThreshold`, `jdk.ZNMethodRegistration`, `jdk.ShenandoahCardStatistics`, `jdk.StringDeduplicationStatistics`) | unchanged | — | No changes needed (already correctly assessed) |

### OpenJDK upstream research (pass 7, 2026-08-17)

Web research via background agent confirmed the following upstream activity:

- **JDK-8365306 / PR #26756** (`NativeHeapTrim` JFR event by tstuefe): abandoned December 2025 due to inactivity. Design disagreement with reviewer egahlin (per-platform normalized events vs. grouped event). No re-proposal found. `jdk.NativeHeapTrim` remains a valid narrow proposal.
- **PR #30638** ("Shenandoah: Emit AllocationRequiringGC jfr events", merged April 2026): fills a gap where Shenandoah didn't emit `jdk.AllocationRequiringGC` events. **Does NOT affect any of our 16 proposals** — `jdk.AllocationRequiringGC` already existed for G1.
- **PR #28015** (`jdk.StringDeduplication`, merged November 2025): confirms `jdk.StringDeduplicationStatistics` in our proposals is **REDUNDANT** — event shipped in JDK 26. Status already `REDUNDANT` in the JSON; no change needed.
- **G1 concurrent refinement, ZGC director, Parallel adaptive sizing JFR events**: no proposals found in the upstream tracker. All three gaps remain open.

---

## Critique Pass 6 Verdicts (2026-08-17)

| Event | Verdict | Action |
|---|---|---|
| `jdk.ZGCTenuringThreshold` | **PROMOTED** | New event added to `jfr-proposed-events.json`; `zGeneration.cpp:716 log_info(gc,reloc)` confirmed production code, no JFR coverage |
| `jdk.ZUncommit` | **REJECTED** (already exists) | `jdk.ZUncommit` is already in `metadata.xml:1248`; `EventZUncommit::commit()` fires in `update_statistics()`; no new event needed |
| `jdk.ShenandoahCollectionDecision` trigger fields | **AUGMENTED** | Added `triggerType` + 6 nullable fields to existing proposed event; all from `log_trigger()` which is `log_info(gc)` in production |

### ZGCTenuringThreshold details:
- **Source:** `ZGenerationYoung::select_tenuring_threshold()` at `zGeneration.cpp:716`
- **Log:** `log_info(gc, reloc)("Using tenuring threshold: %d (%s)", _tenuring_threshold, reason)`
- **Reason values:** `"Promote All"` (forced) | `"ZTenuringThreshold"` (user-pinned flag) | `"Computed"` (dynamic algorithm)
- **Algorithm (Computed path):** `young_life_decay_factor × young_log_residency`; clamped to `[1, min(last_populated_age+1, MaxTenuringThreshold)]`
- **Debug-only inputs** (`log_debug`): `allocatedGarbageRatio`, `youngLogResidency`, `lifeDecayFactor` — NOT included in event (debug level)

### ShenandoahCollectionDecision trigger augmentation:
- **`log_trigger()` is `log_info(gc)`** in production — confirmed `shenandoahHeuristics.cpp:248`
- **Young trigger fields:** `anticipatedGcDurationMs` + `baselineConsumptionBytes` (rate_average); `anticipatedGcDurationMs` only (rate_momentary/rate_accelerated)
- **Old fragmentation trigger:** `fragmentationDensityPct` (density × 100) + `fragmentedFreeBytes`
- **Old growth trigger:** `liveAtPrevMarkBytes` (baseline) + `currentUsageBytes`
- **Old expansion failure trigger:** `currentUsageBytes` only
- All trigger fields are **nullable** — only populated for the matching `triggerType`

---

## Critique Pass 4 Verdicts (2026-08-17)

| Event | Verdict | Action |
|---|---|---|
| `jdk.G1ConcurrentRefinement` | **SPLIT** → `jdk.G1ConcurrentRefinementSweep` + `jdk.G1ConcurrentRefinementPolicy` | Split promoted to `jfr-proposed-events.json`; `print_refinement_stats` and `adjust_threads_wanted` are different cadences |
| `jdk.G1CollectionSetCandidates` | **PROMOTED** (corrected) | In `jfr-proposed-events.json`; see corrections below |
| `jdk.G1ConcurrentMarkTaskStats` | NOT promoted | Medium value; per-task volume; specialist use |
| `jdk.G1HeapResize` | **PROMOTED** (corrected) | In `jfr-proposed-events.json`; see corrections below |
| `jdk.G1PeriodicGCCheck` | NOT promoted | Niche (`G1PeriodicGCInterval` rarely enabled in production) |
| `jdk.G1RegionLivenessUpdate` | NOT promoted | Near-derivable from existing events; low value |
| `jdk.GCWorkerConfiguration` | NOT promoted yet | Emission frequency unsettled; "Adjusting Workers" format unverified; needs upstream design discussion |
| `jdk.ZForwardingRemembered` | **REJECTED** | Log lines print `PTR_FORMAT " " PTR_FORMAT` (address pairs), NOT counts. `accepted` field has no source. No aggregation infrastructure exists. See rejection note. |

### G1CollectionSetCandidates corrections from working doc:
- **Working doc claimed** format string `"Finish adding %s candidates..."` with `%s` placeholder — this doesn't exist
- **Actual source**: `select_candidates_from_marking()` and `select_candidates_from_retained()` are SEPARATE functions with different log strings; no `%s` discriminator in a single finish string
- **`predictedTimeExceeded` boolean** doesn't exist — source has `num_expensive_regions` (count of regions added despite time budget exceeded); promoted as `overBudgetRegions int`
- **Groups concept was missing**: `availableGroups` and `selectedGroups` are separate from region counts; added to promoted event
- **`candidateType` discriminator**: event fires twice per mixed pause (once for `"Marking"`, once for `"Retained"`)
- **`pinnedRegions`**: retained-path-only field (regions with pinned objects encountered)

### G1HeapResize corrections from working doc:
- **`reason` field removed**: doesn't exist as a source variable — decision driven by `_gc_cpu_usage_deviation_counter` thresholds
- **Missing fields added**: `lowerThresholdPct`, `upperThresholdPct`, `gcCpuUsageTargetPct` — all present in actual format string
- **Shrink-path-only fields labeled**: `scaleFactorPct`, `freeRegions`, `regionsNeededForAlloc` are only computed on shrink path; labeled as `SHRINK PATH ONLY` in event schema
- **"Heap resize triggers" log** is at TRACE level and not in the primary resize log

### ZForwardingRemembered rejection:
The working doc proposed fields `published`, `discarded`, `eager`, `eagerRejected`, `redundant`, `accepted` (counts). Source audit shows:
- The `gc+remset` log lines in `zForwarding.cpp` print address pairs (`PTR_FORMAT " " PTR_FORMAT`), not counts
- `accepted` has no source variable in the log
- No existing aggregation infrastructure to convert per-forwarding entries into the count-based fields proposed
- Kept as a lower-priority note only, not promoted to `jfr-proposed-events.json`

---

## Method

For every GC log site in `src/hotspot/share/gc/` (starting with G1, then ZGC, Parallel, Shenandoah,
and Serial), I asked: (1) is it important telemetry, and (2) is it already recoverable from an
existing JFR event? Classification via `site/src/coverage.ts` (`classifySite`) against
`jfr-mappings.json` + `jfr-coverage.json`. The G1 verdict counts (**248 sites** in `data/head.json`):

| verdict | count | meaning |
|---|---|---|
| covered (1:1) | 16 | a JFR event already carries this line's data |
| partial | 161 | same-subsystem event exists; **116 of those are broad tag-rule matches, not verified** |
| uncovered | 71 | no event at all |

The other four collectors are counted in their own table under [Other collectors](#other-collectors-zgc-parallel-shenandoah-serial) below.

**"Covered" is tested two ways** (per the brief): is the datum *directly present* in an existing
event, **or computable** from a combination of existing events? A line is only a new-event candidate
if it fails *both*. The per-proposal "computable?" notes below record that second check — e.g. a
heap-size *delta* is computable from `jdk.G1HeapSummary` before/after, but the *CPU-usage trigger*
that drove the resize is not, so only the trigger justifies a new event.

The importance filter drops two categories that are **not** event candidates:
- **error/warning-level** uncovered (26 sites): assertion failures, corruption dumps, one-shot
  diagnostics (`Marking state`, `Roots`, verifier section headers). These are failure breadcrumbs,
  not periodic telemetry. `jdk.GCOverheadLimitExceeded` (already in `jfr-proposed-events.json`)
  covers the one exception here — the "GC Overhead Limit exceeded too often" family — so it is *not*
  re-proposed below.
- **construction/address dumps** (trace, `gc+bot`/`gc+barrier`): `G1BlockOffsetTable::...`,
  `&_byte_map[0]...`. Pointer prints for HotSpot devs; no operator value.

What remains is real, periodic, currently-invisible G1 telemetry. It clusters into **6 proposed
events**, ordered by value. Each cites the exact source file + verbatim format string, with fields
taken from the actual `log_*` call arguments.

---

## G1

### 1. `jdk.G1ConcurrentRefinement` — **highest value** ✅ SPLIT → promoted to jfr-proposed-events.json as `jdk.G1ConcurrentRefinementSweep` + `jdk.G1ConcurrentRefinementPolicy`

**Why:** Concurrent refinement is G1's mechanism for keeping the dirty-card backlog bounded between
pauses. It has essentially **zero JFR visibility** today — the tag-rule maps these lines to
`jdk.EvacuationInformation`/`jdk.GCPhaseConcurrent`, neither of which carries a single refinement
number. When refinement can't keep up, pause times climb (longer `ScanHR`), and an operator has no
JFR signal for *why*. This is the biggest genuine gap in G1 coverage.

**Replaces (all `src/hotspot/share/gc/g1/g1ConcurrentRefine.cpp` + `g1Policy.cpp`):**
- `Refinement took %.2fms (pre-sweep %.2fms card refine %.2fms) (scanned %zu clean %zu (%.2f%%) not_clean %zu (%.2f%%) not_parsable %zu refers_to_cset %zu (%.2f%%) still_refers_to_cset %zu (%.2f%%) no_cross_region %zu pending %zu)`
- `Concurrent refinement: wanted %u, pending cards: %zu (pending-from-gc %zu), predicted: %zu, goal %zu, time-until-next-gc: %1.2fms pred-refine-rate %1.2fc/ms log-rate %1.2fc/ms`
- `New pending cards target: %zu` / `Unchanged pending cards target: %zu (processed %zu minimum %zu time %1.2f)`
- `GC refinement: goal: %zu / %1.2fms, actual: %zu / %1.2fms, %s` (g1Policy.cpp, per-GC accuracy)

**Fields:**
| field | type | source |
|---|---|---|
| `startTime`, `duration` | — | sweep total (`total_duration`) |
| `preSweepDuration` | long (ns) | `pre_sweep_duration` |
| `cardRefineDuration` | long (ns) | total − pre-sweep |
| `cardsScanned` | long | `scanned` |
| `cardsClean` / `cardsNotClean` / `cardsNotParsable` | long | scan breakdown |
| `cardsRefersToCset` / `cardsStillRefersToCset` | long | cset-referencing counts |
| `cardsPending` | long | `pending` (backlog left) |
| `threadsWanted` | int | `new_wanted` |
| `pendingCardsTarget` | long | `_pending_cards_target` |
| `predictedRefineRate` / `dirtiedCardRate` | double (cards/ms) | analytics predictions |
| `goalMs` | double | refinement time goal |
| `exceededGoal` | boolean | per-GC accuracy line |

Emit once per concurrent-refine sweep (the "Refinement took" cadence). Debug/trace today.

**Computable from existing events?** No. `ScanHR` phase times (`jdk.GCPhaseParallel`) measure card
scanning *inside a pause*; concurrent refinement runs *between* pauses and is sampled by nothing. The
card-state breakdown (clean / refers_to_cset / still_refers_to_cset) and the thread-wanting
prediction exist in no event and cannot be back-derived from pause-time telemetry.

---

### 2. `jdk.G1CollectionSetCandidates` — **high value** ✅ PROMOTED to jfr-proposed-events.json (corrected)

**Why:** These lines are the *ergonomic reasoning* behind mixed-GC region selection — currently the
tag-rule dumps them onto `jdk.EvacuationInformation`, which only records the *result* (regions
evacuated), never the decision (why mixed GCs started/stopped, how many candidates were available vs
selected, predicted-time overruns). This is the classic "why isn't G1 reclaiming my old regions?"
question with no JFR answer.

**Replaces (`g1CollectionSet.cpp`, `g1Policy.cpp`; 25 `gc+ergo+cset` sites, currently weak-partial):**
- `Start adding marking candidates to collection set. Min %u regions, max %u regions, available %u regions...`
- `Finish adding %s candidates to collection set (%s).`
- `Added %u marking candidates to collection set although the predicted time was too high...`
- `Marking candidates exhausted.` / `No candidates to reclaim.`
- `do not continue mixed GCs (candidate old regions not available)` (g1Policy)
- `request young-only gcs (candidate old regions not available)` (g1Policy)

**Fields:** `minRegions` int, `maxRegions` int, `availableRegions` int, `selectedRegions` int,
`markingCandidatesAdded` int, `predictedTimeExceeded` boolean, `reason` String
(exhausted / time-too-high / none-available), `continueMixed` boolean.
Emit once per candidate-selection phase.

**Computable from existing events?** No. `jdk.EvacuationInformation` records the *outcome* (sets
evacuated, bytes) after the fact. The available-candidate pool, how many were selected vs skipped,
and the reason (exhausted / predicted-time-too-high / none-available) are inputs to the decision that
leave no trace in any outcome event.

---

### 3. `jdk.G1ConcurrentMarkTaskStats` — **medium value**

**Why:** Per-task concurrent-mark timing/termination stats. Diagnoses mark-worker imbalance and
termination spin — invisible in JFR today (tag-rule → `jdk.GCPhaseConcurrent`, which is just the
phase wall-clock). Useful when concurrent mark is the pause-driver on large heaps.

**Replaces (`g1ConcurrentMark.cpp`, `G1CMTask::print_stats`):**
- `Marking Stats, task = %u, calls = %u`
- `  Elapsed time = %1.2lfms, Termination time = %1.2lfms`
- `  Step Times (cum): num = %d, avg = %1.2lfms, sd = %1.2lfms max = %1.2lfms, total = %1.2lfms`
- `  Mark Stats Cache: hits %zu misses %zu ratio %.3f`
- `Mark stats cache hits %zu misses %zu ratio %1.3lf` (aggregate)

**Fields:** `taskId` int, `calls` int, `elapsedTime` long(ns), `terminationTime` long(ns),
`stepCount` int, `stepTimeAvg`/`stepTimeMax`/`stepTimeSd`/`stepTimeTotal` long(ns),
`cacheHits` long, `cacheMisses` long. Per-task, at mark end. (Also folds in the mark-stack
capacity lines `Initialize/Expanded/Can not expand ... mark stack ... %zu chunks` if a
`markStackChunks`/`maxChunks` pair is added.)

**Computable from existing events?** No. `jdk.GCPhaseConcurrent` gives the mark phase wall-clock
only. Per-`G1CMTask` termination time, step-time distribution, and mark-cache hit ratio are internal
worker metrics recorded nowhere.

---

### 4. `jdk.G1HeapResize` — **medium value** ✅ PROMOTED to jfr-proposed-events.json (corrected)

**Why:** The adaptive heap-resize (expand/shrink) ergonomics. Tag-rule → `jdk.G1HeapSummary`, which
carries the resulting sizes but *not* the CPU-usage triggers or scale factors that drove the resize
decision. Answers "why did my heap grow/shrink?" — a frequent tuning question.

**Replaces (`g1CollectedHeap.cpp` / `g1HeapSizingPolicy`; `gc+ergo+heap`, currently weak-partial):**
- `Heap resize: short term GC CPU usage %1.2f%% long term GC CPU usage %1.2f%% ...`
- `Heap resize triggers: long term count: %u long term count limit: %u short term ...`
- `expand deltas long %1.2f short %1.2f use long term %u delta %1.2f`
- `Shrink log: scale factor %1.2f%% total free regions %u needed for alloc %u ...`
- `Heap resize. Attempt heap expansion (capacity lower than min desired capacity).`

**Fields:** `shortTermGcCpuUsage` double(%), `longTermGcCpuUsage` double(%), `scaleFactor` double,
`resizeDelta` long(bytes), `direction` String (expand/shrink/none), `reason` String,
`freeRegions` int, `regionsNeededForAlloc` int. Emit on each resize evaluation.

**Computable from existing events?** Partially — the *size delta* is computable from
`jdk.G1HeapSummary` before/after a resize. But the **drivers** (short/long-term GC-CPU-usage %, the
scale factor, which trigger fired) are not in any event and are the actual tuning signal. The event
is justified by the drivers, not the delta.

---

### 5. `jdk.G1PeriodicGCCheck` — **low/medium value**

**Why:** G1's proactive periodic-GC decision (drives `G1PeriodicGCInterval`). Tag-rule → `jdk.SystemGC`,
which fires only when a GC *happens*, never when the periodic check *declines* — so the "why didn't
proactive GC run?" case is invisible. Small but self-contained.

**Replaces (`g1YoungCollector`/periodic path; `gc+periodic`):**
- `Checking for periodic GC.`
- `GC request denied. Skipping.`
- `System loadavg() call failed, disabling G1PeriodicGCSystemLoadThreshold check.` (warning)

**Fields:** `requested` boolean, `denialReason` String, `systemLoad` double,
`loadThreshold` double, `loadavgAvailable` boolean. Emit once per periodic check.

**Computable from existing events?** No. `jdk.SystemGC` fires only when a GC actually runs; the
*declined* checks (and the system-load reading behind the decision) produce no event, so the
"proactive GC considered but skipped" state is unobservable.

---

### 6. `jdk.G1RegionLivenessUpdate` — **low value**

**Why:** Post-mark region reclamation + remembered-set-tracking selection. Tag-rule scatters these
across `jdk.G1HeapRegionInformation` / `jdk.GCPhaseConcurrent`. Marginal, but the "Reclaimed N empty
regions" and remset-tracking-selection numbers are genuine mixed-GC-planning telemetry.

**Replaces:**
- `Reclaimed %u empty regions` (g1ConcurrentMarkRemarkTasks.cpp)
- `Remembered Set Tracking update regions total %u, selected %u` (g1RemSetTrackingPolicy)
- `No Remembered Sets to update after rebuild` / `Skipping Remembered Set Rebuild...`

**Fields:** `reclaimedEmptyRegions` int, `remsetRegionsTotal` int, `remsetRegionsSelected` int,
`rebuildSkipped` boolean. Emit at remark/cleanup.

**Computable from existing events?** Weakly. Region *counts* can be diffed from `jdk.G1HeapSummary`
across the mark cycle, but the remset-tracking *selection* (which/how many regions were chosen for
rebuild) is a planning input not reflected in any summary. Low value precisely because most of it is
near-derivable — listed for completeness, not urgency.

---

### Not proposed for G1 (deliberately)

- **`gc+task` worker-count lines** ("Using %u workers of %u") — genuinely useful, but *cross-collector*
  (shared free-worker logic), so belongs in a generic `jdk.GCWorkerConfiguration`, not a G1 event.
  Flag as a separate cross-cutting proposal rather than bury it in G1.
- **`gc+liveness` PHASE trace dumps** — empty/near-empty format strings, developer trace only.
- **`gc+verify` section headers** (`Roots`, `HeapRegions`) — structural log scaffolding, no data.
- **`gc+alloc` retry warnings** — already reasonably served by `jdk.AllocationRequiringGC`.

### G1 summary

6 proposed G1 events would move **~55 of the 71 uncovered + ~50 weak-partial** G1 sites into real JFR
coverage. The two that matter most — **`jdk.G1ConcurrentRefinement`** and
**`jdk.G1CollectionSetCandidates`** — close the largest operator-facing blind spots: *why refinement
falls behind* and *why mixed GCs start/stop*. Neither exists in the JDK 25 oracle (194 events).

---

## Other collectors (ZGC, Parallel, Shenandoah, Serial)

Same method: for every log site in `src/hotspot/share/gc/{z,parallel,shenandoah,serial}/`, is it
*important periodic telemetry*, and does it fail *both* the directly-present and computable tests
against the existing 194-event oracle? Classification counts (from `classifySite`):

| collector | sites | covered | partial | uncovered | strongest gap |
|---|---|---|---|---|---|
| ZGC | 123 | 9 | 84 | 30 | GC-rule / worker-selection ergonomics (`zDirector`) |
| Parallel | 44 | 7 | 16 | 21 | adaptive-sizing feedback loop (`psAdaptiveSizePolicy`) |
| Shenandoah | 200 | 12 | 65 | 123 | mixed-collection selection + control-thread FSM |
| Serial | 27 | 2 | 17 | 8 | — (nothing worth a new event; see below) |

The same importance filter applies: `gc+verify` section headers, BOT/address dumps, per-worker
compaction pointer prints (`shenandoahGenerationalFullGC`, `psParallelCompact`), and warning-level
one-shots are failure/diagnostic breadcrumbs, not telemetry. What remains clusters into **5 more
proposed events**, ordered by value.

---

### 7. `jdk.ZDirectorRule` — **highest value (ZGC)**

**Why:** `zDirector.cpp` is ZGC's entire GC-triggering brain — it evaluates a fixed set of *rules*
(Timer, Allocation Rate, High Usage, Warmup, Proactive) every director tick and picks the winning
rule + worker count. The tag-rule buries all 12 sites under `gc+director` → `jdk.ZYoungGarbageCollection`
/ `jdk.ZOldGarbageCollection`, which are **outcome** events: they fire *after* a GC is chosen and
record what it did, never *why it was triggered* or *why it wasn't*. This is the ZGC analogue of the
G1 cset-candidates gap — "why did ZGC decide to collect now (or pick N workers)?" has no JFR answer.

**Replaces (all `src/hotspot/share/gc/z/zDirector.cpp`, `gc+director`):**
- `Rule Minor: Allocation Rate (Dynamic GC Workers), MaxAllocRate: %.1fMB/s (+/-%.1f%%), Free: %zuMB, GCCPUTime: %.3f, GCDuration: %.3fs, TimeUntilOOM: %.3fs, TimeUntilGC: %.3fs, GCWorkers: %u`
- `Rule Minor: Allocation Rate (Static GC Workers), MaxAllocRate: %.1fMB/s, Free: %zuMB, GCDuration: %.3fs, TimeUntilGC: %.3fs`
- `Rule Minor: Timer, Interval: %.3fs, TimeUntilGC: %.3fs` / `Rule Minor: High Usage, Free: %zuMB(%.1f%%)`
- `Rule Major: Allocation Rate, ExtraYoungGCTime: %.3fs, OldGCTime: %.3fs, Lookahead: %u, ExtraYoungGCTimeForLookahead: %.3fs`
- `Rule Major: Warmup %.0f%%, Used: %zuMB, UsedThreshold: %zuMB`
- `Rule Major: Proactive, ...` (two lines) / `Rule Major: Timer, ...`
- `Select Minor GC Workers (Normal/Not Warm/Try Lowering), AvoidOOMGCWorkers: %.3f, LastGCWorkers: %.3f, GCWorkers: %.3f`

**Fields:**
| field | type | source |
|---|---|---|
| `startTime` | — | director tick |
| `generation` | String | Minor / Major |
| `rule` | String | Timer / AllocationRate / HighUsage / Warmup / Proactive |
| `triggered` | boolean | did this rule fire the GC |
| `maxAllocRate` | double (MB/s) | allocation-rate rules |
| `freeBytes` | long | `Free` |
| `timeUntilGc` | double (s) | `TimeUntilGC` |
| `timeUntilOom` | double (s) | `TimeUntilOOM` (alloc-rate) |
| `gcDuration` / `gcCpuTime` | double (s) | predicted pause / CPU |
| `selectedWorkers` | int | winning `GCWorkers` |
| `avoidOomWorkers` / `lastGcWorkers` | double | worker-selection inputs |

Emit once per rule evaluation (or once per director tick with the winning rule + the losing-rule
predictions folded in). Debug today.

**Computable from existing events?** No. `jdk.ZYoungGarbageCollection`/`jdk.ZOldGarbageCollection`
record the GC that *happened*; the per-rule predictions (time-until-OOM, predicted duration, the
worker-count arithmetic) are decision *inputs* that leave no trace, and the *declined* ticks (rule
evaluated, GC not triggered) produce no event at all.

---

### 8. `jdk.PSAdaptiveSizePolicy` — **highest value (Parallel)**

**Why:** Parallel's whole reason to exist over Serial is its adaptive generation-sizing feedback
loop, and it is **entirely invisible** in JFR — 7 `gc+ergo` sites in `psAdaptiveSizePolicy.cpp` +
`psYoungGen.cpp`, all *uncovered* (no tag-rule even claims them). The policy continuously compares
measured throughput/pause/promotion against `GCTimeRatio`/`MaxGCPauseMillis` goals and resizes eden /
survivor / old accordingly; today an operator tuning Parallel has zero JFR signal for *why* the
generations are the size they are.

**Replaces (`src/hotspot/share/gc/parallel/psAdaptiveSizePolicy.cpp` + `psYoungGen.cpp`, `gc+ergo`):**
- `Adaptive: throughput: %.3f, pause: %.1f ms, gc-distance: %.3f (%.3f) s, promoted: %.1f %s (%.1f %s), promotion-rate: %.1f M/s (%.1f M/s), overflowing: %s`
- `Adaptive: throughput (actual vs goal): %.3f vs %.3f ; eden delta: + %zu K`
- `Adaptive: pause (ms) (actual vs goal): %.1f vs %.1f`
- `Adaptive: gc-distance (predicted vs goal): %.3f vs %.3f` / `Adaptive: shrinking gc-distance (predicted vs threshold): %.3f vs %.3f`
- `Adaptive: old-gen free bytes: %.0f M, min-free-bytes: %.1f M, shrink-bytes: %zu K` / `Adaptive: eden unchanged`
- `Desired size eden: %zu K, survivor: %zu K` / `Trim survivor under MaxNewSize pressure (...)`

**Fields:** `throughput` double, `throughputGoal` double, `pauseMs` double, `pauseGoalMs` double,
`gcDistance` double(s), `gcDistanceGoal` double(s), `promotedBytes` long, `promotionRate` double(M/s),
`overflowing` boolean, `desiredEden` long, `desiredSurvivor` long, `edenDelta` long, `oldGenFree` long,
`shrinkBytes` long. Emit once per adaptive-sizing evaluation (per GC).

**Computable from existing events?** No. `jdk.PSHeapSummary`/`jdk.GCHeapSummary` carry the *resulting*
generation sizes, and pause times come from `jdk.GCPhasePause` — but the throughput/pause **goals**,
the predicted-vs-actual comparison, and the promotion-rate model that drive the resize decision are
policy state recorded in no event. The resulting size is derivable; the *reason* is not.

---

### 9. `jdk.ShenandoahCollectionDecision` — **high value (Shenandoah)**

**Why:** Shenandoah's control/regulator threads run a state machine that decides *which* generation to
collect and *which* old regions enter a mixed collection — spread across
`shenandoahRegulatorThread.cpp` (10 sites), `shenandoahGenerationalControlThread.cpp` (18),
`shenandoahOldHeuristics.cpp` (10), and `shenandoahAdaptiveHeuristics.cpp` (3), **almost all
uncovered**. There is no Shenandoah-decision event in the oracle at all; the tag-rule can only reach
for generic `gc+ergo` phase events. This is "why did Shenandoah pick a young/old/global/mixed cycle,
and which old regions did it choose?" — the single largest uncovered cluster across all collectors.

**Replaces:**
- `shenandoahRegulatorThread.cpp`: `Heuristics request for {young,old,global} collection accepted`, `Heuristics request to resume/interrupt old ... accepted`
- `shenandoahGenerationalControlThread.cpp`: `request.cause: %s, request.generation: %s`, `cancelled cause: %s, requested cause: %s`, `Preparation for old generation cycle was cancelled`
- `shenandoahOldHeuristics.cpp`: `Choose old regions for mixed collection: old evacuation budget: , candidates: %u`, `No regions selected for mixed collection...`, `Old regions selected for defragmentation: %zu`
- `shenandoahAdaptiveHeuristics.cpp`: `should_start_gc calculation: available: , soft_max_capacity: `, `Available: B, z-score=%.3f. Average available: B +/- B.`, `Margin of error now %.2f`

**Fields:** `decision` String (start-young / start-old / start-global / start-mixed / interrupt /
resume / cancel), `generation` String, `cause` String, `available` long, `softMaxCapacity` long,
`zScore` double, `marginOfError` double, `mixedCandidates` int, `mixedRegionsSelected` int,
`oldEvacuationBudget` long, `defragRegions` int. Emit once per control/regulator decision.

**Computable from existing events?** No. `jdk.ShenandoahHeapRegionStateChange`/`jdk.GCHeapSummary`
show region *states* after the fact; the heuristic *decision* (the should_start_gc z-score math, the
mixed-collection candidate selection, the accepted/cancelled request cause) is control-thread state
that produces no event.

---

### 10. `jdk.ShenandoahReclaimProgress` — **low/medium value (Shenandoah)**

**Why:** `shenandoahMetrics.cpp` (4 `gc+ergo` sites) reports whether the *last* cycle made enough
progress on free/used space and fragmentation to justify not escalating to a Full GC — the input to
Shenandoah's degeneration/Full-GC decision. Small and self-contained, but it's the "why did Shenandoah
degenerate to a Full GC?" signal, which today only shows up as the Full GC itself.

**Replaces (`shenandoahMetrics.cpp`, `gc+ergo`):**
- `%s progress for free space: , need ` / `%s progress for used space: , need `
- `%s progress for internal fragmentation: %.1f%%, need %.1f%%`
- `%s progress for external fragmentation: %.1f%%, need %.1f%%`

**Fields:** `phase` String, `freeProgress` long, `freeNeeded` long, `usedProgress` long,
`usedNeeded` long, `internalFragPct` double, `internalFragNeededPct` double, `externalFragPct` double,
`externalFragNeededPct` double. Emit at end of cycle.

**Computable from existing events?** Weakly. The absolute free/used numbers overlap
`jdk.GCHeapSummary`, but the *fragmentation* percentages and the per-metric "need" thresholds (the
pass/fail criterion) are computed nowhere else. Low value because most of the raw magnitudes are
near-derivable — listed for completeness.

---

### 11. `jdk.ZForwardingRemembered` — **low value (ZGC)** ❌ REJECTED (see critique pass 4 above)

**Why:** `zForwarding.cpp` (5 uncovered `gc+remset` sites) tallies how the young→old remembered-set
forwarding entries were resolved (published / discarded / eager / redundant) during relocation. It's
genuine generational-ZGC relocation telemetry with no event, but narrow.

**Replaces (`zForwarding.cpp` / `.inline.hpp`, `gc+remset`):**
- `Forwarding remset published/discarded/eager/eager and reject/redundant/accept` (counts)

**Fields:** `published` long, `discarded` long, `eager` long, `eagerRejected` long, `redundant` long,
`accepted` long. Emit once per relocation.

**Computable from existing events?** No — but low value: these are internal relocation-bookkeeping
counters with little operator-facing tuning use. Listed for completeness, not urgency.

---

### Not proposed for the other collectors (deliberately)

- **Serial** — its 8 uncovered sites are `gc+verify` headers (`Eden`, `Tenured`, `CardTable`) and BOT
  construction; no periodic telemetry worth an event. Serial's real signal (`jdk.GCPhasePause`,
  `jdk.GCHeapSummary`) is already covered. **No new Serial event proposed.**
- **ZGC `zRelocate.cpp` worker sync lines** (`Synchronize/Desynchronize worker ...`) — internal
  barrier bookkeeping, developer trace, no operator value.
- **ZGC `zStat.cpp` MMU / Mark-stripe lines** — the `gc+mmu` and mark-stripe stats are useful but are
  aggregate-statistics dumps that overlap `jdk.ZStatisticsCounter`/`jdk.ZStatisticsSampler`
  (already emitted); not a clean new-event candidate.
- **Shenandoah `shenandoahFreeSet.cpp` range dumps**, `shenandoahScanRemembered.cpp`,
  `shenandoahGenerationalFullGC.cpp` per-worker compaction lines — free-list internals and pointer
  prints, developer trace.
- **Parallel `GC Overhead Limit exceeded too often`** — already served by the proposed
  `jdk.GCOverheadLimitExceeded` (in `jfr-proposed-events.json`); not re-proposed.
- **`gc+task` worker-count lines** across all collectors — same cross-collector
  `jdk.GCWorkerConfiguration` note as the G1 section; belongs in one shared event, not per-collector.

---

## Generic / shared GC layer (`gc/shared/`)

The per-collector passes above scan `gc/{g1,z,parallel,shenandoah,serial}/`. But
`src/hotspot/share/gc/shared/` holds the **cross-collector** machinery every GC links against —
string dedup, worker-thread policy, TLABs, reference processing, pre-touch, oopStorage. It has **106
sites**, and it was *not* covered by the per-collector analysis. Classifying it separately:

| verdict | count |
|---|---|
| covered (1:1) | 9 |
| partial (per-site mapping) | 11 |
| partial (broad tag-rule) | 19 |
| uncovered | 67 |

Of the 67 uncovered, only **39 are info/debug telemetry** (the rest are trace/error dumps). Almost all
of that telemetry is already claimed by *existing* or *already-proposed* events — which is the key
finding: the shared layer is **not** a source of new generic events. The two things that look like
gaps are both already handled.

### 12. `jdk.GCWorkerConfiguration` — **the one genuine cross-cutting proposal** (deferred pending design discussion)

**Why:** This is the cross-collector worker-count event flagged in the G1 and other-collector "Not
proposed" notes, now formally proposed here rather than left dangling. `workerPolicy.cpp`,
`workerThread.cpp`, `pretouchTask.cpp`, and every collector's `Using %u workers of %u` /
`Adjusting Workers ... %u -> %u` line all describe the *same* datum — how many GC worker threads were
chosen and why — computed by shared free-worker logic. It is telemetry (dynamic worker counts change
per-pause under `UseDynamicNumberOfGCThreads`), quantitative, and actionable (worker count is directly
tunable via `ParallelGCThreads`/`ConcGCThreads`), yet no event carries it.

**Replaces (`src/hotspot/share/gc/shared/workerPolicy.cpp` + per-collector `gc+task` lines):**
- `WorkerPolicy::calc_default_active_workers() : active_workers(): %zu new_active_workers: %zu prev_active_workers: %zu, active_workers_by_JT: %zu active_workers_by_heap_size: %zu`
- `Using %u workers of %u for <phase>` (all collectors) / `Adjusting Workers for %s Generation: %u -> %u` (ZGC)
- `Running %s with %u workers for %zu work units pre-touching %zuB.` (`pretouchTask.cpp`)

**Fields:** `phase` String (or generation), `activeWorkers` int, `maxWorkers` int,
`previousWorkers` int, `workersByJavaThreads` int, `workersByHeapSize` int, `dynamic` boolean.
Emit whenever the active worker count is (re)computed — i.e. per phase under dynamic threads.

**Computable from existing events?** No. `jdk.GCConfiguration` records the *static*
`parallelGCThreads`/`concurrentGCThreads` ceiling once at startup; the *dynamically chosen* active
count per pause (and the JT-vs-heap-size arithmetic behind it) is in no event. This is a real gap —
but a **single** shared event, not one per collector.

### Not proposed from the shared layer (deliberately)

- **String deduplication** (`stringDedupStat.cpp`, 20 uncovered sites — the largest single shared
  cluster: inspected/known/shared/new-unknown/deduplicated counts, table resize/cleanup, phase
  timings). This *looks* like a glaring gap, but **`jdk.StringDeduplication` already exists** as a
  proposed event in `jfr-proposed-events.json` (it ships in JDK 26; absent in JDK 21/25, where the fix
  is a *backport*, not a new event). So the entire stringdedup cluster is already accounted for — not
  re-proposed. *(This is the biggest shared cluster and the most likely thing to mistake for a gap.)*
- **TLAB stats** (`threadLocalAllocBuffer.cpp`: `TLAB totals: thrds ... alloc-frac ... refills ...
  waste ...`) — genuinely useful allocation telemetry, but already covered by the existing
  `jdk.ObjectAllocationSample` / `jdk.ObjectAllocationOutsideTLAB` / `jdk.ObjectAllocationInNewTLAB`
  event family; the aggregate TLAB-waste line is derivable from those. Weak-partial, not a new event.
- **Reference processing** (`referenceProcessor.cpp`, `weakProcessorTimes.cpp`) — the phase timings are
  already carried by `jdk.GCReferenceStatistics` + `jdk.GCPhaseParallel`. Weak-partial, no new event.
- **oopStorage** (`oopStorage.cpp`, 6 sites: `new block`, `expand active array`, `failed block
  allocation`) — internal data-structure block-management for JNI/weak handles. Mechanism, not
  outcome; fails "actionable". No operator value.
- **`gcArguments.cpp` coops warnings**, **`concurrentGCBreakpoints.cpp`** (whitebox-test breakpoints),
  **`gcVMOperations.cpp`** VM-op dispatch — startup validation, test scaffolding, and one-shot dispatch
  lines. Not periodic telemetry.

**Shared-layer conclusion:** exactly **one** new generic event — `jdk.GCWorkerConfiguration` — is
justified. The other apparent gaps are already covered by existing events (TLAB, reference processing)
or by an already-proposed backport (`jdk.StringDeduplication`). The shared layer is well-served by JFR
precisely because it's the oldest, most-instrumented part of the GC subsystem.

## Overall summary

Across all five collectors **plus the shared layer**, **12 proposed events** (6 G1 + 5 per-collector +
1 shared) close the operator-facing GC blind spots that no JDK-25 event covers. Ranked by value, the top
four are the *decision-reasoning* events — **`jdk.G1ConcurrentRefinement`**,
**`jdk.G1CollectionSetCandidates`**, **`jdk.ZDirectorRule`**,
and **`jdk.PSAdaptiveSizePolicy`** — each exposing *why* a collector acted (refinement backlog, mixed-GC
selection, ZGC rule triggering, Parallel adaptive sizing), which today's outcome-only events
(`jdk.EvacuationInformation`, `jdk.Z*GarbageCollection`, `jdk.*HeapSummary`) structurally cannot answer.
Shenandoah's control-thread FSM (**`jdk.ShenandoahCollectionDecision`**) is the largest single uncovered
cluster. The **shared GC layer** yields only one genuine new event
(**`jdk.GCWorkerConfiguration`**) — its other apparent gaps (string dedup, TLAB, reference processing)
are already covered by existing or already-proposed events. None of the 12 exist in the JDK 25 oracle
(194 events).

---

## Why the remaining ~250 uncovered/weak-partial sites are *not* important

Of the 303 non-covered gap sites across the five collectors, the 11 proposals above absorb ~55. The
rest were deliberately rejected. This is the *importance* half of the two-part test (the other half —
"already covered or computable?" — is what promotes a site to `covered`/`partial`). A log site is
**important telemetry** only if it is (a) *periodic* — emitted on a repeating GC cadence, not once at
startup or once at failure; (b) *quantitative* — carries a number an operator would trend or alarm on,
not a state string a developer reads while stepping through code; and (c) *actionable* — tells the
operator something they could tune or respond to, not an internal invariant only a HotSpot dev can act
on. A site failing **any** of the three is not event-worthy. The rejected sites cluster into seven
families, each failing a specific leg of that test.

### 1. Verify / assertion / corruption dumps (`gc+verify`, error/warning level) — ~24 non-G1 sites (+26 G1)
`gc+verify` section headers (`Eden`, `Tenured`, `CardTable`, `Roots`, `HeapRegions`), Shenandoah's
`Safepoint verification: ... verified usage vs recorded usage`, verifier region-stats closures, and
error-level corruption dumps. **Fails "periodic":** these fire only under `-XX:+VerifyBeforeGC`/
`VerifyAfterGC` (a debugging switch, off in production) or at the moment of a detected inconsistency.
They are *failure breadcrumbs* for a JVM engineer diagnosing a crash, not a signal an operator trends.
When they fire in production at all, the JVM is already aborting — `jdk.GCHeapSummary` and the hs_err
log carry the actionable part.

### 2. Address / offset / pointer prints (`gc+bot`, `gc+barrier`, trace) — ~9 sites
`G1BlockOffsetTable::...`, `&_byte_map[0]...`, barrier-set patching addresses, per-object
`compact_point`/`obj_size`/`region end` pointer arithmetic in the Full-GC compactors
(`shenandoahGenerationalFullGC`, `psParallelCompact`). **Fails "actionable":** a raw heap address means
nothing outside the address space that produced it — it cannot be trended, compared across runs, or
tuned against. These exist so a HotSpot dev can correlate a log line with a debugger. Zero operator value.

### 3. Control-thread / regulator state chatter (`gc+thread`, mostly debug) — ~20 sites
Shenandoah's `Reject request for concurrent gc: gc_requested: %s, gc_cancelled: %s`, `Not overwriting
gc cause %s with %s`, `Notify control (%s)`, `Stopping control thread`, `Control Thread hiccup time`.
**Fails "quantitative":** these are FSM-transition traces — mostly boolean/enum state strings emitted on
*every* control-loop iteration, the vast majority of which are no-ops ("nothing to do, go back to
sleep"). The *decisions* that matter (which generation to collect, why a request was accepted) are
already captured in the proposed `jdk.ShenandoahCollectionDecision`; what's left here is the loop's
internal bookkeeping between those decisions. Eventing every tick would be high-volume, low-signal.

### 4. Worker synchronization / join-leave barriers (`gc+reloc`, debug) — ~11 sites
ZGC's `Synchronize worker _nsynchronized %u`, `Joining/Leaving/Resize workers`,
`Desynchronize all workers`. **Fails "actionable":** these trace the internal handshake as relocation
workers enter and leave a barrier. The worker *count* that matters (how many ZGC chose) is in the
proposed `jdk.ZDirectorRule`; the per-handshake `_nsynchronized` counter is an implementation detail of
the barrier itself — an operator can neither tune it nor infer anything from it.

### 5. Statistics / aggregate re-dumps (`gc+heap`/`gc+mmu`/`gc+load` @info in `zStat.cpp`) — ~17 sites
ZGC's `Heap Statistics:`, `Min/Max/Soft Max Capacity:`, `%s Generation Statistics:`, the MMU
(`2ms/%.1f%% ...`) and Load lines. These *look* like important telemetry — and the underlying numbers
are — but they **fail "already covered / not double-counted":** they are periodic re-prints of state
already emitted as structured events (`jdk.ZStatisticsCounter`, `jdk.ZStatisticsSampler`,
`jdk.GCHeapSummary`, `jdk.ZPageAllocation`). A new event here would duplicate an existing one, which is
worse than a gap — it splits the same datum across two schemas. The right fix (if the sampler events
are judged incomplete) is to *extend* those events, not add a parallel `zStat` dump event.

### 6. Free-list / region-range internals (`gc+free`, debug/trace) — ~14 sites
Shenandoah's `mutator_leftmost/rightmost`, `Shifting region %zu from mutator_free to old_collector_free`,
`prep_to_rebuild` ranges, GCLAB-size adjustments. **Fails "actionable":** these are the internal
geometry of the free-set data structure (which contiguous region indices belong to which allocator
pool) as it is rebuilt. The *outcome* an operator cares about — how much free space, how fragmented —
is in `jdk.GCHeapSummary` / the proposed `jdk.ShenandoahReclaimProgress`. The index-range mechanics are
a data-structure implementation detail.

### 7. One-shot init / config / version lines (`gc+init`, `gc+task` startup, @info) — ~6 sites
`Initializing %s`, `Version: %s (%s)`, `Using %zu mark stripes`, `Using %u Workers for %s Generation`.
**Fails "periodic":** emitted once at collector startup, not on a GC cadence. Static configuration
belongs in `jdk.GCConfiguration`/`jdk.YoungGenerationConfiguration`/`jdk.ZGCConfiguration` (which
already exist and are one-shot by design), not a new periodic event. The one genuinely useful
*dynamic* worker-count line (`Adjusting Workers ... %u -> %u`) is the cross-collector
`jdk.GCWorkerConfiguration` note below — not a per-collector event.

### The recurring principle
Most rejected sites fail because they are **mechanism, not outcome**: they narrate *how* the collector
is doing something (which worker synchronized, which region index shifted, which pointer was compacted)
rather than *what happened* or *why a decision was made*. JFR events should capture outcomes and
decisions — the mechanism traces are what the `-Xlog` debug/trace levels are *for*, and promoting them
to events would inflate recording size with data no operator queries. The proposals above are
deliberately confined to the sites that are periodic **and** quantitative **and** actionable **and** not
already carried by an existing event.
