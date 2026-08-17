# Shenandoah Heuristics & Collection Decision — Observability Research

## Overview

In Shenandoah generational mode (JEP 521, production-ready JDK 25), the **regulator thread** (`ShenandoahRegulatorThread`) polls heuristics to decide when and what to collect. The decision involves two heuristic layers:

1. **`ShenandoahAdaptiveHeuristics`** — drives young generation collections; uses allocation rate predictions
2. **`ShenandoahOldHeuristics`** — drives old generation collections; uses three independent trigger conditions

All trigger logging uses `log_trigger()` which resolves to `log_info(gc)` in production builds (confirmed from `shenandoahHeuristics.cpp:248-263`).

## The `log_trigger()` Macro

```cpp
void ShenandoahHeuristics::log_trigger(const char* fmt, ...) {
  LogTarget(Info, gc) lt;
  if (lt.is_enabled()) {
    ResourceMark rm;
    LogStream ls(lt);
    ls.print_raw("Trigger", 7);
    if (ShenandoahHeap::heap()->mode()->is_generational()) {
      ls.print(" (%s)", _space_info->name());
    }
    ls.print_raw(": ", 2);
    // ... vprint ...
  }
}
```

**Log level:** `log_info(gc)` (confirmed production build)  
**Source:** `shenandoahHeuristics.cpp:248-263`

## Young Generation Triggers (ShenandoahAdaptiveHeuristics)

Source: `src/hotspot/share/gc/shenandoah/heuristics/shenandoahAdaptiveHeuristics.cpp`

### Trigger 1: Average Allocation Rate (`rate_average`)

```
Trigger (Young): Anticipated GC duration (%.2f ms) is above the time for average allocation rate (PROPERFMT_F/s)
                 to deplete free headroom (PROPERFMT) (margin of error = %.2f)
```

**Condition:** `rate.baseline_consumption() > allocatable_bytes`

**Fields available for JFR:**
- `anticipatedGcDurationMs` — `rate.duration_seconds() * 1000`
- `baselineConsumptionBytes` — `rate.baseline_consumption()` (= baseline_rate × duration)
- `allocatableBytes` (= available headroom, already in `available` field)
- `marginOfError` — `_margin_of_error_sd` (already in event)

### Trigger 2: Momentary Spike (`rate_momentary`)

```
Trigger (Young): Momentary spike consumption (PROPERFMT) exceeds free headroom (PROPERFMT) at
                 current rate (PROPERFMT_F/s) for anticipated GC duration (%.2f ms)
```

**Condition:** `rate.momentary_consumption() > allocatable_bytes` (with `accelerated_consumption() == 0`)

### Trigger 3: Accelerated Allocation (`rate_accelerated`)

```
Trigger (Young): Accelerated consumption (PROPERFMT) exceeds free headroom (PROPERFMT) at
                 current rate (PROPERFMT_F/s) with acceleration (PROPERFMT_F/s/s)
                 for anticipated GC duration (%.2f ms)
```

**Condition:** `rate.accelerated_consumption() > allocatable_bytes` (with `momentary_consumption() == 0`)

This trigger fires when allocation rate is not just high but **accelerating** (e.g., phase change when many threads suddenly start allocating). Uses least-squares regression on 8 samples at ~15ms interval to detect acceleration.

### Other Young Triggers

- `"GC start is already pending"` — degenerate case
- `"Free (Soft) () is below minimum threshold ()"` — min-free floor
- `"Learning %zu of %zu. Free () is below initial threshold ()"` — warm-up phase

## Old Generation Triggers (ShenandoahOldHeuristics)

Source: `src/hotspot/share/gc/shenandoah/heuristics/shenandoahOldHeuristics.cpp`

### Trigger 1: Expansion Failure (`expansion_failure`)

```
Trigger (Old): Expansion failure, current size: <size> which is %.1f%% of total heap size
```

**Condition:** `_cannot_expand_trigger` flag set (set externally when heap expansion fails)

**Fields for JFR:**
- `currentUsageBytes` — `old_gen_capacity` at trigger time
- `fragmentationDensityPct` (repurposed) — actually `percent_of(old_gen_capacity, heap_capacity)` here; but cleaner to use a separate `oldGenCapacityPercent` field

### Trigger 2: Fragmentation (`fragmentation`)

```
Trigger (Old): Old has become fragmented:
               <fragmented_free> available bytes spread between range spanned from
               <first_old_region> to <last_old_region> (<span>), density: %.1f%%
```

**Condition:** `_fragmentation_trigger` flag set (set when density = used/used_regions_size falls below threshold)

**Fields for JFR:**
- `fragmentedFreeBytes` — `used_regions_size - used` (free bytes spread across the span)
- `fragmentationDensityPct` — `density * 100` (from `get_fragmentation_trigger_reason_for_log_message()`)

The density is:
```cpp
density = used / used_regions_size   // where used_regions_size includes humongous padding
```
Low density = objects spread thinly across many regions = poor allocation efficiency.

### Trigger 3: Old Gen Growth (`growth`)

```
Trigger (Old): Old has overgrown, live at end of previous OLD marking: <live_prev>,
               current usage: <current>, percent growth: %.1f%%
```

**Condition:** `_growth_trigger` set AND `current_usage > trigger_threshold`

**Fields for JFR:**
- `liveAtPrevMarkBytes` — `get_live_bytes_at_last_mark()` (baseline: live at last old marking completion)
- `currentUsageBytes` — `used()` (current old gen usage including humongous waste)
- The `percent_growth` is derivable: `(current - live_prev) / live_prev * 100`

**Note:** There is a false-trigger guard:
```cpp
if ((current_usage < ignore_threshold) &&
    (consecutive_young_cycles < ShenandoahDoNotIgnoreGrowthAfterYoungCycles)) {
  log_debug(gc)("Ignoring Trigger: Old has overgrown: ...");
  _growth_trigger = false;
}
```
The ignored case is at `log_debug` — only the confirmed trigger (reaching `log_trigger()`) enters the JFR event.

## The `_margin_of_error_sd` Field

Source: `shenandoahAdaptiveHeuristics.cpp`

```cpp
void ShenandoahAdaptiveHeuristics::adjust_margin_of_error(double amount) {
  ...
  log_debug(gc, ergo)("Margin of error now %.2f", _margin_of_error_sd);
}
```

**This log is at `log_debug`** — but `_margin_of_error_sd` is a field on `ShenandoahAdaptiveHeuristics` that is used in `should_start_gc()` to compute `anticipated_gc_duration`. It's updated in `record_success_concurrent()` (post-cycle accounting). The value at trigger time IS the `marginOfError` field in `jdk.ShenandoahCollectionDecision` — this is read from the heuristic object state, not from the log line.

## The Regulator FSM

Source: `src/hotspot/share/gc/shenandoah/shenandoahRegulatorThread.cpp`

Simple structure:
```
while (running) {
  // check both heuristics
  if (young_heuristics->should_start_gc()) → request young GC
  if (old_heuristics->should_start_gc()) → request old GC
  // sleep with period ShenandoahRegulatorSleepMs (default: ~1ms)
  // backoff if too many cycles without GC
}
```

The regulator does NOT make "decision" in the sense of choosing young vs old — it requests both independently. The actual collection sequencing (interrupt old for young, bootstrap, etc.) happens in `ShenandoahGenerationalControlThread`.

## JFR Coverage Gap

The `jdk.ShenandoahCollectionDecision` event covers the control-thread decision path. Critique pass 6 augmented it with trigger fields:

| Log Site | Fields Added |
|---|---|
| `trigger_average_allocation_rate()` | `triggerType=rate_average`, `anticipatedGcDurationMs`, `baselineConsumptionBytes` |
| `trigger_accelerating_allocation_rate()` — momentary | `triggerType=rate_momentary`, `anticipatedGcDurationMs` |
| `trigger_accelerating_allocation_rate()` — accelerated | `triggerType=rate_accelerated`, `anticipatedGcDurationMs` |
| `should_start_gc()` — fragmentation | `triggerType=fragmentation`, `fragmentationDensityPct`, `fragmentedFreeBytes` |
| `should_start_gc()` — growth | `triggerType=growth`, `liveAtPrevMarkBytes`, `currentUsageBytes` |
| `should_start_gc()` — expansion failure | `triggerType=expansion_failure`, `currentUsageBytes` |

These fields are nullable — only the fields for the active trigger are populated.

## Production Diagnostic Value

**`triggerType=rate_accelerated` with short `anticipatedGcDurationMs`**: Young gen is racing against a spike — allocation acceleration detected early. Expected behavior for phase changes.

**`triggerType=fragmentation` with high `fragmentationDensityPct` (> 80%)**: Old gen is fragmenting despite high usage — many small holes between live objects. Consider increasing `ShenandoahOldGarbageThreshold`.

**`triggerType=growth` with `currentUsageBytes` >> `liveAtPrevMarkBytes`**: Old gen grew significantly since last old marking. Could indicate a long young-only run where promotions are accumulating.

**`triggerType=expansion_failure`**: Old gen can't expand (heap at max). Imminent OOM risk if old gen continues to fill. Increase `-Xmx` or reduce live set.

**Oscillating between `rate_average` and `fragmentation`**: Young GCs are running frequently due to allocation pressure while old gen fragments — old collections aren't keeping up. Old GC is either not running often enough or not reclaiming enough.

## References

- [shenandoahAdaptiveHeuristics.cpp](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/heuristics/shenandoahAdaptiveHeuristics.cpp)
- [shenandoahOldHeuristics.cpp](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/heuristics/shenandoahOldHeuristics.cpp)
- [shenandoahHeuristics.cpp](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/heuristics/shenandoahHeuristics.cpp)
- [shenandoahRegulatorThread.cpp](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahRegulatorThread.cpp)
- [JEP 521: Generational Shenandoah](https://openjdk.org/jeps/521)
