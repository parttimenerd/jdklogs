# G1 Collection Set Candidates — Observability Research

## What Collection Set Candidate Selection Does

After each G1 concurrent marking cycle, the GC identifies old-generation regions worth collecting: regions with high garbage ratios whose reclamation would take less time than the current GC pause budget. These are **collection set candidates** — a pool of old-gen regions that G1 draws from during **mixed GC** pauses (young + selected old regions).

G1 maintains **two distinct candidate pools**:
- **Marking candidates** — regions identified by the last concurrent marking cycle (high-garbage old regions)
- **Retained candidates** — regions that were part of a previous mixed GC's optional set but couldn't be evacuated due to time constraints (pinned or budgetarily excluded)

G1 processes these pools in separate functions at different points in the pause. The `jdk.G1CollectionSetCandidates` event would fire **once per pool per pause**, capturing the selection decision for each path.

## Two Separate Selection Functions

### `select_candidates_from_marking()`

Called at the start of mixed GC to pull from marking candidates. This is the primary path — regions identified by recent concurrent marking sorted by garbage ratio (highest first).

**Log format strings** from `g1CollectionSet.cpp`:

Start:
```
Start adding marking candidates to collection set. Min %u regions, max %u regions, available %u regions (%u groups), time remaining %1.2fms, optional threshold %1.2fms
```

Finish:
```
Finish adding marking candidates to collection set. Initial: %u regions (%u groups), optional: %u regions (%u groups), predicted initial time: %1.2fms, predicted optional time: %1.2fms, time remaining: %1.2fms
```

Additional:
```
Marking candidates exhausted.
Added %u marking candidates to collection set although the predicted time was too high.
```

**Stop conditions** (logged via `print_finish_message`):
1. **`"Maximum number of regions reached"`** — `selectedRegions >= maxRegions`
2. **`"Region amount reached min"`** — minimum met and adaptive sizing not active
3. **`"Predicted time too high"`** — predicted time > remaining budget after meeting minimum

**Selection loop logic:**
1. If `selectedInitial < minRegions`: add to initial set regardless of time
2. If adaptive sizing off (`!check_time_remaining`): stop at minimum
3. If `timeRemaining > optionalThreshold`: add to initial set
4. If `timeRemaining > 0`: add to optional set (collected only if initial finishes early)
5. Else: stop (time exhausted)

### `select_candidates_from_retained()`

Called to include previously-deferred old-gen regions. Retained candidates are regions that survived from a previous collection's optional set (they had pinned objects or were over-budget at the time).

**Log format strings**:

Start:
```
Start adding retained candidates to collection set. Min %u regions, available %u regions (%u groups), time remaining %1.2fms, optional remaining %1.2fms
```

Finish:
```
Finish adding retained candidates to collection set. Initial: %u, optional: %u, pinned: %u, predicted initial time: %1.2fms, predicted optional time: %1.2fms, time remaining: %1.2fms optional time remaining %1.2fms
```

Additional:
```
Retained candidates exhausted.
Added %u retained candidates to collection set although the predicted time was too high.
```
Trace-level:
```
Retained candidate %u can not be reclaimed currently. Skipping.
Retained candidate %u can not be reclaimed currently. Dropping.
```

**Stop conditions:**
1. **Pinned region + retry limit** — region has pinned objects and `update_num_unreclaimed()` fails; region is dropped from retained list, loop continues
2. **Neither time fits** — `predicted_time_ms > optional_time_remaining_ms` AND `predicted_time_ms > time_remaining_ms` AND `num_expensive_regions >= min_regions`; loop breaks explicitly

The `pinnedRegions` count is retained-path-specific — marking candidates don't track pinned regions.

## The Groups Concept

G1 batches candidate regions into **groups** (`G1CSetCandidateGroup`). Each group is a logical unit for selection:
- For **marking candidates**: groups are created during candidate list construction; multiple regions can be in one group (sorted by garbage ratio)
- For **retained candidates**: typically 1 region per group

**Why groups matter for observability:** The log reports both `num_regions` (total regions selected) and `length()` (number of groups). These can differ significantly. A high group count with low region count means many isolated old regions; a low group count with high region count means clustered old regions (usually better for evacuation efficiency).

The `G1CSetCandidateGroupList` struct:
```cpp
length()       // count of G1CSetCandidateGroup objects
num_regions()  // total regions across all groups (atomic counter)
```

## Mixed GC Continuation (`continueMixed`)

After each mixed GC pause, `g1Policy.cpp` decides whether to run another mixed GC or switch back to young-only:

```cpp
if (!next_gc_should_be_mixed()) {
  log_debug(gc, ergo)("do not continue mixed GCs (candidate old regions not available)");
  next_state.set_in_normal_young_gc();
}
```

`next_gc_should_be_mixed()` returns false when all marking candidates have been processed:
```cpp
assert(!candidates()->has_more_marking_candidates(),
    "only end mixed if all candidates from marking were processed");
```

`continueMixed = false` means this was the last mixed GC of the current mixed cycle — the GC will return to young-only until the next concurrent marking completes.

## JFR Coverage Gap

| Area | JFR Event | Coverage |
|---|---|---|
| Mixed GC summary | `jdk.GarbageCollection` | Yes (high-level) |
| Heap regions | `jdk.G1HeapRegionInformation` | Yes (per-region) |
| Evacuation stats | `jdk.G1EvacuationYoungStatistics` | Yes |
| **Collection set selection logic** | **None** | **ZERO COVERAGE** |

Without the JFR event, there is no way to observe:
- How many marking vs retained candidates were available
- Whether the pause budget was the binding constraint (time too high) or supply was exhausted
- Whether optional evacuation is happening or always getting cut
- Whether `continueMixed = false` is firing prematurely (marking candidates wasted)

## Production Diagnostic Value

**Mixed GC pause time oscillation:** When mixed GC pauses spike, `predictedInitialTimeMs` vs `timeRemainingMs` shows whether G1 was adding regions it predicted would exceed budget (the "although the predicted time was too high" path). This means the prediction model is miscalibrated.

**Mixed cycle not completing:** When `continueMixed = false` fires early and marking candidates are still available, it means the mixed GC policy is being too conservative. `availableRegions` vs `selectedRegions` reveals how many candidates were left unused.

**Retained candidate accumulation:** High `availableRegions` count for retained candidates over successive pauses means regions keep getting deferred. `pinnedRegions` identifies the reason.

**Optional evacuation effectiveness:** If `optionalRegions` is always 0, G1 never has spare pause time — the initial collection set already consumes the full budget. This predicts future promotion failures as old gen fills.

## Event Design Notes

The event fires **twice per mixed GC pause** (once for marking path, once for retained path), with `candidateType` as the discriminator. The two events have slightly different field sets — `pinnedRegions` is retained-path-only, `maxRegions` is marking-path-only. These are captured with labels in the proposed event.

The `stopReason` field maps to the three explicit finish messages plus two derived states:
- `"exhausted"` — `"Marking/Retained candidates exhausted."`
- `"max_regions_reached"` — `"Maximum number of regions reached"`
- `"min_regions_reached"` — `"Region amount reached min"`
- `"time_too_high"` — `"Predicted time too high"`
- `"none_available"` — no candidates existed at function entry

## References

- [g1CollectionSet.cpp](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1CollectionSet.cpp)
- [g1CollectionSet.hpp](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1CollectionSet.hpp)
- [g1CollectionSetCandidates.hpp](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1CollectionSetCandidates.hpp)
- [g1Policy.cpp](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1Policy.cpp)
- [G1 Mixed GC explained (Redhat blog)](https://developers.redhat.com/articles/2021/09/16/g1-garbage-collector-details-and-tuning)
