# ZGC Generational Mode — Observability Research

## Overview

ZGC's generational mode (production-ready since JDK 21) maintains separate young and old generations. Each young collection (`ZGenerationYoung`) computes a tenuring threshold — the age at which young objects are promoted to old gen. This is the primary JFR coverage gap identified in this research pass.

## The Tenuring Threshold Selection

Source: `src/hotspot/share/gc/z/zGeneration.cpp`

### `select_tenuring_threshold()` — Production Code, Info Level

```cpp
void ZGenerationYoung::select_tenuring_threshold(ZRelocationSetSelectorStats stats, bool promote_all) {
  const char* reason = "";
  if (promote_all) {
    _tenuring_threshold = 0;
    reason = "Promote All";
  } else if (ZTenuringThreshold != -1) {
    _tenuring_threshold = static_cast<uint>(ZTenuringThreshold);
    reason = "ZTenuringThreshold";
  } else {
    _tenuring_threshold = compute_tenuring_threshold(stats);
    reason = "Computed";
  }
  log_info(gc, reloc)("Using tenuring threshold: %d (%s)", _tenuring_threshold, reason);
}
```

**Log tag:** `gc,reloc`  
**Log level:** `log_info`  
**Source line:** `zGeneration.cpp:716`  
**Production code:** YES (no `#ifndef PRODUCT` guard)

The three selection paths:
1. `"Promote All"` — `promote_all` flag set; `_tenuring_threshold = 0` means everything gets promoted
2. `"ZTenuringThreshold"` — user pinned `-XX:ZTenuringThreshold=N`; static value
3. `"Computed"` — dynamic algorithm from `compute_tenuring_threshold(stats)`

### JFR Coverage Gap

No existing JFR event covers this log site. The relevant existing events:

| Event | Coverage |
|---|---|
| `jdk.TenuringDistribution` | G1/Parallel GC per-age-bucket sizes only; NOT ZGC |
| `jdk.ZGCConfiguration` | Static config (uses `ZTenuringThreshold`) but not the per-cycle decision |

`jdk.ZGCTenuringThreshold` is the proposed event (critique pass 6).

## The `compute_tenuring_threshold()` Algorithm

The dynamic algorithm (`reason = "Computed"`) uses three factors:

### 1. Life Decay Factor (`young_life_decay_factor`)

Measures how much the live bytes shrink from one age cohort to the next:

```
young_life_expectancy = avg(young_live[age] / young_live[age-1])  over all ages
young_life_decay_factor = 1.0 / young_life_expectancy
```

- **High decay factor** (> 1): Most young objects die early → generational behavior → promote later (higher threshold)
- **Low decay factor** (≤ 1): Objects persist across ages → anti-generational → promote earlier

### 2. Allocated-to-Garbage Ratio (`allocated_garbage_ratio`)

```
allocated_garbage_ratio = young_allocated / (young_garbage + 1)
```

High ratio means the GC is struggling to keep up with allocation rate. When this is high, the algorithm promotes more aggressively to offload from young gen.

### 3. Young Log Residency (`young_log_residency`)

```
young_residency_factor = max(soft_max_capacity / young_live_total, 1.0)
young_log = clamp(allocated_garbage_ratio * 16, 2, 16)
young_log_residency = log(young_residency_factor) / log(young_log)
```

Measures how small young gen's footprint is relative to the heap, dampened by the log base that is scaled by allocation pressure. Small young-gen footprint = less value in promoting.

### Final Computation

```
tenuring_threshold_raw = young_life_decay_factor * young_log_residency
tenuring_threshold = clamp(round(tenuring_threshold_raw), 1, min(last_populated_age + 1, MaxTenuringThreshold))
```

### Debug-Level Diagnostic Fields (NOT in JFR event)

`compute_tenuring_threshold()` also emits several `log_debug(gc, reloc)` lines:
- `"Allocated To Garbage: %.1f"` → `allocated_garbage_ratio`
- `"Young Log Residency: %.1f"` → `young_log_residency`
- `"Life Decay Factor: %.1f"` → `young_life_decay_factor`

These are at `log_debug` level — below the `log_info` threshold for the proposed JFR event. The proposed `jdk.ZGCTenuringThreshold` event only captures the info-level result (threshold + reason), not the debug-level inputs.

## ZUncommit — Already Covered

`zUncommitter.cpp:157` has:
```
log_info(gc, heap)("Uncommitter (%u) Uncommitted: %zuM(%.0f%%) in %.3fms", ...)
```

This supplemental log is NOT a coverage gap — `jdk.ZUncommit` already exists (`metadata.xml:1248`). The `EventZUncommit::commit(start, end, uncommitted)` call fires from `update_statistics()` in `zUncommitter.cpp` at the per-chunk granularity. The `log_info` line is the per-cycle summary after all chunks are done and is already captured.

## Production Diagnostic Value for `jdk.ZGCTenuringThreshold`

**`reason = "Computed"` with threshold = 0 or 1 persistently**: Near-total promotion every cycle; young gen is functioning as a short-term buffer only. Old gen will grow fast.

**`reason = "Computed"` with threshold at `MaxTenuringThreshold` persistently**: Application has very long-lived objects in young gen. The algorithm says they should survive many cycles before promotion. Combine with `jdk.ZGCHeapCapacity` to check if old gen is filling.

**Oscillating threshold**: Alternating between low/high indicates mixed workload — some rapidly-dying, some long-lived objects. May benefit from explicit `-XX:ZTenuringThreshold`.

**`reason = "ZTenuringThreshold"` (user-pinned)**: Confirms the user has overridden the algorithm. Useful to know when debugging unexpected promotion behavior.

**`reason = "Promote All"`**: Forced full-promotion cycle — GC is under heavy pressure. Correlate with `jdk.GarbageCollection` pause duration.

## Related Events

- `jdk.ShenandoahTenuringThreshold` — analogous event for Shenandoah generational mode (mortality-rate algorithm, different from ZGC's life-decay approach)
- `jdk.TenuringDistribution` — per-age-bucket sizes for G1/Parallel (NOT ZGC)
- `jdk.ZGCConfiguration` — static ZGC config including `ZTenuringThreshold` flag value
- `jdk.ZUncommit` — already exists; covers memory uncommit operations

## References

- [zGeneration.cpp](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zGeneration.cpp)
- [zGeneration.hpp](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zGeneration.hpp)
- [zUncommitter.cpp](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zUncommitter.cpp)
