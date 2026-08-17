# Shenandoah Generational GC — Observability Research

## Overview

Shenandoah is a low-pause concurrent GC. Its **generational mode** (JEP 521, production-ready JDK 25, merged May 2025 via PR #25270) separates the heap into **young** and **old** generations, adding a remembered set and card barrier similar to G1 but optimized for Shenandoah's concurrent-evacuation model.

Enable with: `-XX:+UseShenandoahGC -XX:ShenandoahGCMode=generational`

## How Shenandoah's Collection Cycle Works

### Non-Generational (Classic) Shenandoah

1. **Concurrent Marking** — mark live objects without stopping mutators
2. **Final Mark (STW)** — brief pause to flush SATB queues
3. **Concurrent Cleanup** — reclaim fully-dead regions
4. **Concurrent Evacuation** — copy live objects to new regions while mutators run (using load reference barriers)
5. **Init Update Refs (STW)** — brief pause
6. **Concurrent Update References** — fix all references to point to new locations
7. **Final Update Refs (STW)** — brief pause

### Generational Shenandoah

Adds a **young generation** with:
- **Card barrier** — dirty card table for tracking young→old and old→young references
- **Remembered set scanning** — at young GC start, scan dirty cards to find old→young references
- **Regulator thread** — continuously decides whether to run young, old, or global collections

#### Collection Types

| Type | Scope | When |
|---|---|---|
| Young (concurrent normal) | Young generation only | Most frequent; triggered by allocation pressure |
| Old (servicing_old) | Old generation | When old gen needs collection; runs concurrently with young |
| Bootstrap (bootstrapping_old) | First old collection | Special case to initialize old gen state |
| Mixed | Young + selected old regions | When old gen has high-garbage regions worth including |
| Global | Full heap | When young-only cycles can't make progress |
| Degenerated (STW) | Whatever was concurrent | When concurrent cycle can't complete before OOM |
| Full (STW) | Full heap, compact | Last resort |

### The Regulator Thread (`ShenandoahRegulatorThread`)

The regulator runs continuously and makes decisions: start a young collection, start an old collection, interrupt an old collection to run a young one. Decisions are based on:
- Allocation rate (young gen filling up)
- Free heap percentage
- Old gen garbage ratio
- Metaspace usage

**No JFR event captures these decisions** — operators see only the resulting GC events, not why a particular collection type was chosen.

## Shenandoah's Remembered Set and Card Statistics

### Card Barrier Mechanics

In generational mode, Shenandoah adds a **write barrier** that marks cards dirty when a reference is stored. Cards are 512 bytes. At young GC start:
1. Scan dirty cards in old-gen regions
2. For each dirty card, find the objects that span that card
3. Check each object's reference fields for old→young pointers
4. Add found young-gen objects to the GC roots

### `ShenandoahCardStats` Fields

| Source field | Type | Meaning |
|---|---|---|
| `_dirty_card_cnt` | size_t | Dirty card table slots found in this scan |
| `_clean_card_cnt` | size_t | Clean card table slots (already clean, skipped) |
| `_max_dirty_run` | size_t | Max consecutive dirty cards (locality indicator) |
| `_max_clean_run` | size_t | Max consecutive clean cards |
| `_dirty_scan_obj_cnt` | size_t | Objects scanned because they overlapped dirty cards |
| `_alternation_cnt` | size_t | Dirty/clean alternation count (cache thrashing indicator) |

**High `maxConsecutiveDirtyCards`** = dirty cards are clustered → efficient bulk scanning.
**High `alternationCount`** = dirty cards are scattered → cache-unfriendly, slower scanning.

**Important:** The `log()` method is wrapped in `#ifndef PRODUCT` — this data is only available in debug/fastdebug builds in the current source. The JFR event would need the emission moved to a product-build path.

Source: `src/hotspot/share/gc/shenandoah/shenandoahCardStats.cpp`

## Shenandoah MMU (Minimum Mutator Utilization)

### What MMU Measures

Shenandoah tracks **GC Utilization (GCU)** and **Mutator Utilization (MU)** per completed phase:
- `GCU% = (GC threads CPU time) / (elapsed wall time) * 100`
- `MU% = 100 - GCU%` *(approximately; concurrent phases share CPU)*

Low MU% means GC is consuming too much CPU, starving mutator threads. This is a production-critical signal for latency-sensitive applications.

### Two Emission Paths

**End-of-cycle path** (`update_utilization(size_t gcid, const char* msg)`):
```
At end of %s: GCU: %.1f%%, MU: %.1f%% during period of %.3fs
```
Phase strings: `"Concurrent Young GC"`, `"Concurrent Global GC"`, `"Concurrent Bootstrap GC"`, `"Mixed Concurrent GC"`, `"Full GC"`, `"Degenerated GC"`
Source: `src/hotspot/share/gc/shenandoah/shenandoahMmuTracker.cpp`

**Old-marking increment path:**
```
At end of %s: GCU: %.1f%%, MU: %.1f%% for duration %.3fs (totals to be subsumed in next gc report)
```

**Periodic-sample path** (`report()`, every ~5s):
```
Periodic Sample: GCU = %.3f%%, MU = %.3f%% during most recent %.1fs
```
This fires independently of GC cycles — it's a rolling-window sample of recent GC CPU overhead.

The JFR event must distinguish these paths via `isPeriodicSample` boolean and must include `gcId` (tracked as `_most_recent_gcid`) for correlation with `jdk.GarbageCollection`.

### Why Not Use `jdk.GCCPUTime`?

`jdk.GCCPUTime` records raw user/sys/real CPU time per GC operation. It does **not** normalize to a utilization percentage over a wall-clock window. Shenandoah's MMU is more useful for latency analysis: "GC consumed X% of available CPU during the last N seconds" directly translates to application throughput impact.

## Shenandoah Reclaim Progress

### The `is_good_progress()` Function

After each concurrent cycle, Shenandoah checks whether the cycle made "good progress" — i.e., whether it reclaimed enough space to avoid degenerated GC escalation.

**Source:** `src/hotspot/share/gc/shenandoah/shenandoahMetrics.cpp`, `ShenandoahMetricsSnapshot::is_good_progress()`

Four dimensions checked **in order with early-exit on first pass**:
1. **Free space**: `free_actual >= free_expected` where `free_expected = softMaxCapacity * ShenandoahCriticalFreeThreshold / 100`
2. **Used space freed**: `used_freed >= progress_expected` where `progress_expected = region_size_bytes()`
3. **Internal fragmentation** reduction: `if_delta >= 0.01` (1% reduction)
4. **External fragmentation** reduction: `ef_delta >= 0.01` (1% reduction)

The function returns on the **first passing dimension**. In the common case (free space is healthy), only dimension 1 is evaluated. Fields for dimensions 2-4 must be **nullable** in the JFR event.

### Why `goodProgress = false` Matters

When `is_good_progress()` returns false **consecutively**, the policy escalates:
- `_consecutive_degenerated_gcs_without_progress` counter increments
- At `CONSECUTIVE_BAD_DEGEN_PROGRESS_THRESHOLD` (2), the next GC escalates to full GC

Without JFR visibility into this counter (not currently in the proposed event), operators cannot predict a full GC before it fires. Consider adding `consecutiveDegenWithoutProgress` from `ShenandoahCollectorPolicy`.

## Shenandoah Collection Decision

### GCMode Enum (from `shenandoahGenerationalControlThread.hpp`)

```cpp
enum GCMode {
  none,
  concurrent_normal,     // normal young/global concurrent GC
  stw_degenerated,       // STW fallback (concurrent cycle couldn't complete)
  stw_full,              // full STW GC (last resort)
  servicing_old,         // concurrent old-gen GC
  bootstrapping_old,     // first old-gen GC (initialization)
  stopped                // GC thread stopped
};
```

The `ShenandoahRegulatorThread` decides which mode to request. The `ShenandoahGenerationalControlThread` executes the decision.

### Mixed Collection (Old Regions in Young GC)

When old gen has regions with high garbage ratio, they may be included in a young collection ("mixed" mode). The selection is done by `ShenandoahOldHeuristics::choose_collection_set_from_regiondata()`:
- Scans `candidate_regions` sorted by garbage ratio
- Selects up to `_old_evacuation_budget` bytes worth of old regions
- Counts `defrag_count` regions selected for defragmentation (low live ratio, fragment cleanup)

The log: `"Old-gen is planning to %s its collection set from %u/%u candidate regions"` where `%s` is "start" or "augment".

### Immediate Garbage Optimization

When a region is >85% garbage (ShenandoahImmediateThreshold), Shenandoah can reclaim it without full evacuation. The `immediate_garbage` (bytes) and `immediate_regions` (count) represent this opportunity. These are logged in `shenandoahOldHeuristics.cpp` as byte count + region count — **not as a percentage** (the original proposed field `immediateGarbagePercent` was incorrect).

## JFR Coverage for Shenandoah

| Area | JFR Event | Coverage |
|---|---|---|
| Heap regions | `jdk.ShenandoahHeapRegionInformation` | Yes (per-region detail) |
| Region state changes | `jdk.ShenandoahHeapRegionStateChange` | Yes |
| Evacuation | `jdk.ShenandoahEvacuationInformation` | Yes |
| Promotion (gen mode) | `jdk.ShenandoahPromotionInformation` | JDK 27 (unreleased) |
| Card statistics | None | **ZERO COVERAGE** |
| MMU | None | **ZERO COVERAGE** |
| Reclaim progress | None | **ZERO COVERAGE** |
| Collection decision | None | **ZERO COVERAGE** |

## References

- [JEP 521: Generational Shenandoah](https://openjdk.org/jeps/521)
- [Shenandoah generational PR #25270](https://github.com/openjdk/jdk/pull/25270)
- [shenandoahCardStats.cpp](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahCardStats.cpp)
- [shenandoahMmuTracker.cpp](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahMmuTracker.cpp)
- [shenandoahMetrics.cpp](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahMetrics.cpp)
- [shenandoahRegulatorThread.cpp](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahRegulatorThread.cpp)
- [shenandoahOldHeuristics.cpp](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/heuristics/shenandoahOldHeuristics.cpp)
- [shenandoahGenerationalControlThread.hpp](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahGenerationalControlThread.hpp)
