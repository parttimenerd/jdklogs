# ZGC Director Rules — Observability Research

## How ZGC's Director Works

ZGC is a concurrent GC that must decide **when to start** a collection cycle without STW pauses for that decision. The **ZDirector** runs as a periodic thread (sampling every ~10ms) and evaluates a set of rules to determine whether to trigger a Young or Old collection.

ZGC (generational mode, the default since JDK 21 for `-XX:+UseZGC`) maintains separate **Young** and **Old** generation collection decisions:
- **Young GC (Minor):** Collects the young generation; runs frequently
- **Old GC (Major):** Collects the tenured generation; triggered less often

### Rule Evaluation Order and Early-Exit

`ZDirector::make_minor_gc_decision()` and `make_major_gc_decision()` return on the **first triggered rule**. This means:
- At most **one Minor** rule and one **Major** rule fires per evaluation cycle
- Only the winning rule produces a log line (at `log_debug(gc,director)`)
- Skipped rules are never logged — you cannot observe which rules were *not* triggered

This is a fundamental observability limitation. To expose all rule evaluations (for tuning), the director would need to evaluate all rules unconditionally before returning.

### Minor (Young) Rules

| Rule | Trigger condition | Key log fields |
|---|---|---|
| `rule_minor_timer` | Time since last young GC >= ZCollectionIntervalMinor | Interval, TimeUntilGC |
| `rule_minor_allocation_rate_dynamic` | UseDynamicNumberOfGCThreads=true; predicts OOM before GC can complete | MaxAllocRate, variance%, Free, GCCPUTime, GCDuration, TimeUntilOOM, TimeUntilGC, GCWorkers |
| `rule_minor_allocation_rate_static` | Same but UseDynamicNumberOfGCThreads=false | MaxAllocRate, Free, GCDuration, TimeUntilGC |
| `rule_minor_high_usage` | Free heap < threshold | Free MB, free% |

The **dynamic allocation rate** rule is the most sophisticated: it accounts for multi-thread GC CPU time and predicts whether the current allocation rate will exhaust free space before GC can complete. The soft/hard/semi-hard sub-variants share the same log format — triggering variant is not distinguishable from logs.

### Major (Old) Rules

| Rule | Trigger condition | Key log fields |
|---|---|---|
| `rule_major_timer` | Time since last old GC >= ZCollectionIntervalMajor | Interval, TimeUntilGC |
| `rule_major_warmup` | Used heap < UsedThreshold (early-life warmup) | Used MB, UsedThreshold MB |
| `rule_major_allocation_rate` | **Escalation rule**: called from start_gc() to upgrade minor→major; balances young vs old collection efficiency | ExtraYoungGCTime, OldGCTime, Lookahead, ExtraYoungGCTimeForLookahead |
| `rule_major_proactive` | Proactive background collection (if no collection would fire otherwise) | Branch: enabled: AcceptableGCInterval, TimeSinceLastGC, TimeUntilGC; disabled: UsedUntilEnabled, TimeUntilEnabled |

**Important:** `rule_major_allocation_rate` is NOT called from `make_major_gc_decision()`. It is an **escalation rule** called from `start_gc()` after a minor collection was already decided. It answers: "should we upgrade this young GC to a major GC?" based on the ratio of extra young GC time to old GC time.

The **proactive rule** has two branches: before the heap has warmed up enough (`UsedUntilEnabled > 0`), it logs only warmup progress. After warmup, it logs whether the inter-GC interval exceeds an acceptable threshold.

### ZGC Memory Hierarchy

```
Heap = Young Generation + Old Generation
Young Generation = Eden + Survivor-from + Survivor-to
```

- Allocations always go to Eden (young)
- Young GC promotes surviving objects to Old
- Old GC collects the tenured generation
- Free = total heap capacity - (young used + old used)

### What "Allocation Rate" Means in ZGC

The allocation rate is tracked as a sliding-window exponential moving average of bytes allocated per second. ZGC measures it continuously and uses it to predict:
- `timeUntilOOM` = freeBytes / allocRate - gcDuration (time until allocation exhausts free space)
- `timeUntilGC` = derived from ZCollectionIntervalMinor or allocation rate deadline

When `timeUntilOOM < gcDuration`, the young GC trigger fires immediately (soft rule) or immediately regardless (hard rule).

## Existing JFR Coverage

| Area | JFR Event | Coverage |
|---|---|---|
| Young GC | `jdk.ZYoungGarbageCollection` | Yes (start/end/reason) |
| Old GC | `jdk.ZOldGarbageCollection` | Yes (start/end/reason) |
| Allocation stall | `jdk.ZAllocationStall` | Yes |
| Director rule | None | **ZERO COVERAGE** |
| ZGC stats (experimental) | `jdk.ZStatisticsCounter`, `jdk.ZStatisticsSampler` | Partial (opaque IDs, experimental) |
| Uncommit | `jdk.ZUncommit` | Yes |

The `ZStatisticsCounter`/`ZStatisticsSampler` experimental events expose ZGC internal counters (allocation rate, live bytes, etc.) but are not human-readable without a ZStatCounter name lookup table and are marked experimental/internal-use.

## Why the `jdk.ZDirectorRule` Event Matters

When ZGC collection frequency is unexpected:
- **Too frequent** → higher overall GC overhead, reduced throughput
- **Too infrequent** → allocation stalls when heap fills up

Without seeing which rule triggered and why, operators can only observe the effect (stall events, GC start times) not the cause. The director rules encode the predictive logic — exposing them makes ZGC's self-tuning transparent.

**Most useful diagnostic pattern:** If `rule_minor_timer` consistently fires before `rule_minor_allocation_rate_dynamic`, ZGC is timer-driven rather than allocation-driven — meaning ZCollectionIntervalMinor may be set too aggressively. If `rule_minor_high_usage` fires, free heap headroom is insufficient.

## Sparse-Field Design Concern

The event has 25+ fields, most applicable to only one rule. This "wide sparse" design receives pushback in JFR upstream reviews. Alternatives:
1. Per-rule-type events (`jdk.ZDirectorTimerRule`, `jdk.ZDirectorAllocationRateRule`, etc.) — verbose but type-safe
2. Single event with a union-like `payload` string (not idiomatic for JFR)
3. Current sparse design with documented null semantics — simplest for consumers

The upstream JFR design principle (Erik Gahlin) favors normalized events; per-rule events would likely be preferred.

## References

- [ZGC Director source](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zDirector.cpp)
- [ZNMethodTable source](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zNMethodTable.cpp)
- [ZStat source](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zStat.cpp)
- [ZGC JFR events (ZAllocationStall etc.)](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/z/zStat.cpp)
- [ZPageAllocation JFR improvement JDK 25](https://github.com/openjdk/jdk/pull/26534)
- [JFR event catalog JDK 26](https://bestsolution-at.github.io/jfr-doc/openjdk-26.html)
