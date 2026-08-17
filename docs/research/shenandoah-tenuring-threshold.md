# Shenandoah Tenuring Threshold — Observability Research

## What Tenuring Threshold Does

In Shenandoah's generational mode (JEP 521, production-ready JDK 25), objects age through GC cycles. When an object's age reaches the **tenuring threshold**, it is promoted from the young generation to the old generation. Unlike G1 and Parallel GC (which use a fixed threshold tuned by `MaxTenuringThreshold`), Shenandoah **dynamically computes the tenuring threshold after each young GC** using mortality rate analysis.

## The Age Census Mechanism

Source: `src/hotspot/share/gc/shenandoah/shenandoahAgeCensus.cpp`

### How It Works

Shenandoah maintains a ring buffer of **age tables** — population vectors tracking how many bytes of objects exist at each age cohort (0..15). After each young GC, `update_tenuring_threshold()` calls `compute_tenuring_threshold()`:

```
1. Examine age cohorts from MaxTenuringAge down to MinTenuringAge
2. For each cohort age i:
   - cur_pop = population at age i this epoch
   - prev_pop = population at age i-1 last epoch
   - mortality_rate = 1.0 - (cur_pop / prev_pop)
3. Find the OLDEST cohort with:
   - prev_pop > ShenandoahGenerationalTenuringCohortPopulationThreshold
   - mortality_rate > ShenandoahGenerationalTenuringMortalityRateThreshold
4. Return (that age + 1) as the tenuring threshold
   — objects AT that age are still dying fast enough to keep in young gen
   — objects ONE AGE OLDER should be promoted
```

The result is clamped between `ShenandoahGenerationalMinTenuringAge` and `ShenandoahGenerationalMaxTenuringAge`.

### The `ShenandoahGenerationalCensusIgnoreOlderCohorts` Optimization

When enabled, the search is capped at the PREVIOUS cycle's tenuring threshold. This prevents older cohorts (which have higher apparent mortality due to promotions) from pulling the threshold down unnecessarily.

### Mortality Rate and "Dark Matter"

The mortality rate formula accounts for `dark matter` — object population that appears to increase between epochs (impossible under simple aging model). When `cur_pop > prev_pop`, the mortality rate is set to 0 (cohort treated as healthy; logged at trace level).

## Log Format String

```
New tenuring threshold %zu (min %zu, max %zu)
```

**Log tag:** `gc,age`  
**Log level:** `log_info`  
**Function:** `ShenandoahAgeCensus::update_tenuring_threshold()` (production code — NOT `#ifndef PRODUCT` guarded)  
**Source line:** `shenandoahAgeCensus.cpp:258`

Variables:
1. `(uintx) _tenuring_threshold[_epoch]` — newly computed threshold
2. `ShenandoahGenerationalMinTenuringAge` — flag value (lower bound)
3. `ShenandoahGenerationalMaxTenuringAge` — flag value (upper bound)

## JFR Coverage Gap

The existing `jdk.TenuringDistribution` event covers G1 and Parallel GC:
```xml
<Event name="TenuringDistribution" ...>
  <Field type="uint" name="gcId" />
  <Field type="uint" name="age" />
  <Field type="ulong" contentType="bytes" name="size" />
</Event>
```

This event records the per-age-bucket SIZE at each GC — one event per age bucket. It does NOT cover:
- The tenuring threshold decision (why threshold changed)
- Shenandoah generational mode at all (different algorithm, different data)

`jdk.ShenandoahTenuringThreshold` is complementary: it records the **threshold value change** and its bounds, not the full age histogram. If the full histogram is also needed, a separate `jdk.ShenandoahTenuringDistribution` event would be required.

## Why the Dynamic Algorithm Matters

Shenandoah's mortality-rate-based algorithm is fundamentally different from G1/Parallel's threshold:

| Aspect | G1/Parallel | Shenandoah |
|---|---|---|
| Algorithm | `MaxTenuringThreshold` (static max) | Mortality rate analysis (dynamic) |
| Adjustment | +1/-1 based on survivor space fullness | Jump to computed optimal age |
| Range | 0–MaxTenuringThreshold | ShenandoahGenerationalMinTenuringAge–Max |
| Frequency | Every young GC | Every young GC |
| Main flag | `MaxTenuringThreshold` | `ShenandoahGenerational{Min,Max}TenuringAge` |

## Production Diagnostic Value

**Threshold too low → premature tenuring:** Old gen fills faster than expected; young GC becomes frequent; eventually triggers old GC. Threshold `1` or `2` persistently means nearly all young objects are being promoted immediately.

**Threshold too high → objects stuck in young gen:** Objects that should be in old gen are being repeatedly scanned during young GC, increasing GC time. Threshold at `maxTenuringAge` persistently means the population is long-lived but not being promoted.

**Oscillating threshold:** Rapid up-down changes indicate a mixed-age survivor population — part young-dying, part long-lived. May benefit from tuning `ShenandoahGenerationalTenuringMortalityRateThreshold`.

**Trend toward max → workload aging:** When threshold steadily climbs to max over time, more long-lived objects have accumulated in young gen. Expect old gen growth and eventual full GC.

## Related Events

- `jdk.TenuringDistribution` — per-age-bucket sizes for G1/Parallel (NOT Shenandoah)
- `jdk.ShenandoahCollectionDecision` — why a young/old/mixed GC was chosen (decision, not age data)
- `jdk.ShenandoahEvacuationInformation` — actual evacuation stats per cycle
- `jdk.ShenandoahPromotionInformation` — promotion stats (JDK 27-dev)

## References

- [shenandoahAgeCensus.cpp](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahAgeCensus.cpp)
- [shenandoahAgeCensus.hpp](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/shenandoah/shenandoahAgeCensus.hpp)
- [JEP 521: Generational Shenandoah](https://openjdk.org/jeps/521)
- [Shenandoah generational PR #25270](https://github.com/openjdk/jdk/pull/25270)
