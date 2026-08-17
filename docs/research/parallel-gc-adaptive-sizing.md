# Parallel GC Adaptive Size Policy — Observability Research

## How ParallelGC Adaptive Sizing Works

Parallel GC (enabled with `-XX:+UseParallelGC`) is a throughput-oriented stop-the-world collector. Its `PSAdaptiveSizePolicy` (Parallel Scavenge Adaptive Size Policy) runs a feedback loop after each GC to resize the young and old generations toward throughput and pause-time goals.

**Design philosophy:** Maximize `GCTimeRatio` (mutator time fraction) while keeping minor GC pauses under `MaxGCPauseMillis`. The policy trades generation size against these two competing goals.

## The Feedback Loop

After each minor (young) GC, `PSAdaptiveSizePolicy` updates internal statistics and computes new desired generation sizes:

```
1. Record GC pause time → update _minor_pause_time_seq (ring buffer average)
2. Record GC distance (inter-GC interval) → update _gc_distance_seconds_seq
3. Record promoted bytes → update _avg_promoted, _promoted_bytes
4. Compute desired eden size:
   - If throughput < goal: increase eden (longer mutator intervals → better throughput)
   - If pause > goal: decrease eden (smaller eden → shorter pause)
5. Compute desired survivor size (based on promotion rate)
6. Compute old gen shrink if free > threshold
```

### Key Data Structures

| Source field | Meaning |
|---|---|
| `mutator_time_percent()` | Windowed estimate: 1 - (gc_time / elapsed_time) from `_gc_time_seq` ring buffer |
| `minor_gc_time_estimate()` | `_minor_pause_time_seq.davg()` — smoothed average + std-dev of minor pauses (seconds) |
| `_gc_distance_seconds_seq` | Ring buffer of inter-GC intervals (time from GC end to next GC start) — "gc-distance" in log |
| `_avg_promoted` | `AdaptivePaddedAverage` of promoted bytes — includes padding factor |
| `_promoted_bytes` | Raw last-sample promoted bytes |
| `_promotion_rate_bytes_per_sec` | Smoothed promotion rate (bytes/s) |

### Throughput Goal Computation

The throughput goal is **not stored** — it is computed on demand:
```cpp
double throughput_goal = 1.0 - (1.0 / (1.0 + GCTimeRatio));
```
Default `GCTimeRatio = 99` → throughput_goal = 0.99 (99% mutator time). Set lower to allow more GC time.

### Eden Sizing Decision Tree

```
compute_desired_eden_size():
  if throughput < throughputGoal:
    → INCREASE eden by calculated delta (logged as "eden delta: + %zu K")
    → Only this branch logs the throughputEdenIncrease field
  elif pause > pauseGoal:
    → DECREASE eden
    → No "eden delta" logged for decrease
  elif gc_distance too short (gc thrashing):
    → DECREASE eden to lengthen inter-GC time
  else:
    → UNCHANGED
```

The `throughputEdenIncrease` field in the JFR event is **branch-specific** (throughput-increase path only) and always positive. There is no general "eden delta" field for all cases.

### Old Gen Shrink

`compute_old_gen_shrink_bytes()` runs separately from young-gen sizing. It shrinks the old gen if:
```
old_gen_free > min_free_bytes
```
where `min_free_bytes` is computed from promoted bytes and a 10-minute promotion-rate lookahead:
```
min_free_bytes = max(avg_promoted * factor, 10min_promotion_lookahead)
```

This prevents shrinking old gen so much that the next promotion wave fails.

## Log Format Strings

**`print_stats()` in `psAdaptiveSizePolicy.cpp`:**
```
Adaptive: throughput: %.3f, pause: %.1f ms, gc-distance: %.3f (%.3f) s,
promoted: %.1f %s (%.1f %s), promotion-rate: %.1f M/s (%.1f M/s), overflowing: %s
```
Where `(%.3f)` = last sample, and `%s` are byte-scale suffixes (K/M/G).

**`compute_old_gen_shrink_bytes()` in `psAdaptiveSizePolicy.cpp`:**
```
Adaptive: old-gen free bytes: %.0f M, min-free-bytes: %.1f M, shrink-bytes: %zu K
```

**`compute_desired_eden_size()` — throughput branch in `psAdaptiveSizePolicy.cpp`:**
```
Adaptive: throughput (actual vs goal): %.3f vs %.3f ; eden delta: + %zu K
```

**Desired sizes in `psYoungGen.cpp`:**
```
Desired size eden: %zu K, survivor: %zu K
```

## Fields Corrected from Previous Design

| Previous name | Corrected name | Issue |
|---|---|---|
| `mutatorIntervalSec/Last` | `gcDistanceSec/Last` | Source calls this "gc-distance"; variable `_gc_distance_seconds_seq` |
| `minMutatorIntervalSec` | **REMOVED** | Does not exist — `MinGCDistanceSecond` is a compile-time constant |
| `desiredEdenDelta` | `throughputEdenIncrease` | Only logged on throughput-increase branch; always positive; not a general delta |
| `pauseMs` | `minorPauseMs` | Source is `minor_gc_time_estimate()` — major GC not included |
| `throughputGoal` | `throughputGoal` (corrected note) | No stored field; must be re-derived from `GCTimeRatio` flag at emission time |
| `promotedBytesEstimate/Last` | same but `double` type | Source values are floating-point doubles, not integer bytes |
| `desiredEden/Survivor` | same but caller-site note | Not emittable from `print_stats()`; requires PSYoungGen call site |

## `survivorOverflow` Semantics

`survivorOverflow = true` means the survivor space was too small to hold all surviving young objects — some were promoted to old gen that would not normally be (not yet "tenured"). This is **softer than `PromotionFailed`**:
- `survivorOverflow`: survivor too small, objects bypass to old gen; collection succeeds
- `PromotionFailed` (fires `jdk.PromotionFailed`): old gen too full to accept bypass objects; forces full GC

Repeated `survivorOverflow` events indicate premature tenuring and will gradually fill old gen.

## `GCOverheadLimitExceeded` in Parallel GC

Added support for G1 in JDK 26 (JDK-8212084, PR #27950). Parallel GC has had this since JDK 6. The Parallel GC implementation (`parallelScavengeHeap.cpp`) tracks:
- `long_term_gc_time_ratio()` — windowed GC time fraction
- Separate young and old gen free space percentages (unlike G1 which combines them)

Triggers `OutOfMemoryError: GC overhead limit exceeded` when both:
- GC time > `GCTimeLimit`% (default 98) for `GCOverheadLimitThreshold` consecutive GCs (default 5)
- Free space < `GCHeapFreeLimit`% (default 2)

**Log when checking** (`parallelScavengeHeap.cpp`):
```
GC Overhead Limit: GC Time %f Free Space Young %f Old %f Counter %zu
```
Note the two separate free-space values — the proposed JFR event needs `freeSpaceYoungPercent` and `freeSpaceOldPercent` separately for Parallel GC.

## JFR Coverage for Parallel GC

| Area | JFR Event | Coverage |
|---|---|---|
| GC summary | `jdk.GarbageCollection` + `jdk.PSHeapSummary` | Yes |
| CPU time | `jdk.GCCPUTime` | Yes |
| Old GC | `jdk.ParallelOldGarbageCollection` | Yes |
| Promotion failure | `jdk.PromotionFailed` | Yes |
| Adaptive sizing | None | **ZERO COVERAGE** |
| GC overhead limit | None | **ZERO COVERAGE** (despite new G1 support in JDK 26) |

## Production Scenarios Where This Data Helps

**Throughput oscillation:** When eden size oscillates up and down repeatedly, the throughput and pause goals are in conflict — `throughput vs throughputGoal` and `minorPauseMs vs pauseGoalMs` together reveal which dimension is driving each change.

**Old gen pressure from promotion:** When `promotedBytesEstimate` increases over time with `gcDistanceSec` decreasing, the young gen is under-collecting and old gen fills up. `minFreeBytes` tracks whether the policy accounts for this.

**Survivor overflow cascade:** Repeated `survivorOverflow = true` with increasing `promotionRateEstimate` predicts eventual old-gen exhaustion, detectable before `PromotionFailed` fires.

## References

- [psAdaptiveSizePolicy.cpp](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/psAdaptiveSizePolicy.cpp)
- [psAdaptiveSizePolicy.hpp](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/psAdaptiveSizePolicy.hpp)
- [psYoungGen.cpp](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/psYoungGen.cpp)
- [parallelScavengeHeap.cpp](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/parallelScavengeHeap.cpp)
- [JDK-8212084 G1 GCOverheadLimit (merged JDK 26, PR #27950)](https://github.com/openjdk/jdk/pull/27950)
- [tschatzl JDK 26 G1/Parallel GC Changes](https://tschatzl.github.io/2026/02/26/jdk26-g1-serial-parallel-gc-changes.html)
- [tschatzl JDK 27 G1/Parallel GC Changes](https://tschatzl.github.io/2026/08/10/jdk27-g1-serial-parallel-gc-changes.html)
