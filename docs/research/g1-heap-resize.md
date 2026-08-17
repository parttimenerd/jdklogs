# G1 Heap Resize Policy — Observability Research

## What G1 Heap Sizing Policy Does

G1's heap sizing policy (`G1HeapSizingPolicy`) continuously adjusts the committed heap size between GC pauses based on **GC CPU usage patterns**. Unlike Serial/Parallel GC (which resize based on occupancy ratios), G1's young-collection resizing uses a **deviation counter** driven by how much CPU the GC is consuming relative to a target (`GCTimeRatio`).

Two conceptually separate resize mechanisms exist:
1. **Young-collection resize** (`young_collection_resize_amount()`) — primary mechanism; CPU-usage driven
2. **Full-collection resize** (`full_collection_resize_amount()`) — occupancy driven; fires after full GC only

The proposed `jdk.G1HeapResize` event targets the **young-collection path** (the normal steady-state resizing).

## How the CPU-Usage Deviation Counter Works

### The Counter

```cpp
int _gc_cpu_usage_deviation_counter;
```

Initialized to `(G1CPUUsageExpandThreshold / 2) + 1` — biased toward early expansion at startup so the heap grows proactively rather than waiting for a spike.

After each GC, the counter is updated:
- `short_term_gc_cpu_usage > upper_threshold` → **increment** (GC is spending too much CPU; need to expand)
- `short_term_gc_cpu_usage < lower_threshold` → **decrement** (GC is idle; can shrink)
- Within thresholds → no change

**Trigger thresholds:**
- `counter >= G1CPUUsageExpandThreshold` → **expand** the heap
- `counter <= -G1CPUUsageShrinkThreshold` → **shrink** the heap
- After resize: counter resets to 0

**Decay:** If no resize fires but the long-term cycle count reaches a limit, `decay_cpu_usage_tracking_data()` halves the counter (`_gc_cpu_usage_deviation_counter /= 2`). This prevents the counter from accumulating across many borderline GCs into an oversized single resize event.

### Upper and Lower Thresholds

Both thresholds are computed from `GCTimeRatio` and `G1CPUUsageDeviationPercent`:

```cpp
double gc_cpu_usage_target = 1.0 / (1.0 + GCTimeRatio);
double gc_cpu_usage_margin = G1CPUUsageDeviationPercent / 100.0;
double upper_threshold = gc_cpu_usage_target * (1 + gc_cpu_usage_margin);
double lower_threshold = gc_cpu_usage_target * (1 - gc_cpu_usage_margin);
```

Default `GCTimeRatio = 9` for G1 → `gc_cpu_usage_target = 0.10` (10% of CPU for GC). With `G1CPUUsageDeviationPercent = 10%`, the band is [9%, 11%].

Note: G1's default `GCTimeRatio = 9` differs from Parallel GC's default of `99`. G1 is designed for latency (shorter pauses, less throughput optimization), so it accepts more GC CPU overhead per unit time.

## Log Format Strings

**Main resize decision** (`log_resize()` in `g1HeapSizingPolicy.cpp`):
```
Heap resize: short term GC CPU usage %1.2f%% long term GC CPU usage %1.2f%% lower threshold %1.2f%% upper threshold %1.2f%% GC CPU usage target %1.2f%% at limit %s resize by %zuB expand %s
```
Logged at `log_debug(gc, ergo, heap)`.

**Shrink detail log** (shrink path only):
```
Shrink log: scale factor %1.2f%% total free regions %u needed for alloc %u base targeted for shrinking %u resize_bytes %zd ( %zu regions)
```

**At-limit logs** (when heap can't be resized further):
```
Heap resize: ... at limit true resize by 0B expand true
Heap resize: ... at limit true resize by 0B expand false
```

**Full-collection expansion/shrink** (different log site):
```
Heap resize. Attempt heap expansion (capacity lower than min desired capacity). Capacity: %zuB occupancy: %zuB live: %zuB min_desired_capacity: %zuB (%zu %%)
Heap resize. Attempt heap shrinking (capacity higher than max desired capacity). ...
```

## Field Classification: Always-Present vs Shrink-Only

The main resize log always emits all six core fields (regardless of expand/shrink decision):
- `shortTermGcCpuUsagePct` — `short_term_gc_cpu_usage * 100` (from `_analytics->short_term_gc_time_ratio()`)
- `longTermGcCpuUsagePct` — `long_term_gc_cpu_usage * 100` (from `_analytics->long_term_gc_time_ratio()`)
- `lowerThresholdPct` — derived from `gc_cpu_usage_target * (1 - margin) * 100`
- `upperThresholdPct` — derived from `gc_cpu_usage_target * (1 + margin) * 100`
- `gcCpuUsageTargetPct` — `gc_cpu_usage_target * 100` (note: in JFR event this must be re-derived from `GCTimeRatio` at emit time since it's a local variable)
- `expand` — boolean, true if expanding, false if shrinking
- `resizeBytes` — amount to resize (0 if `atLimit = true`)
- `atLimit` — true when heap is at max capacity (can't expand) or min capacity (can't shrink)

**Shrink-path-only fields** (only appear in shrink detail log):
- `scaleFactorPct` — multiplicative scaling factor × 100 (source: `scale_factor`, a double in range ~0.2–2.0; logged as percentage)
- `freeRegions` — `total_free_regions` (total free regions in heap at shrink decision)
- `regionsNeededForAlloc` — `needed_for_allocation` (regions needed for imminent allocations, not to be shrunk)

These three fields have no meaning for expansion decisions and are labeled `SHRINK PATH ONLY` in the JFR event design.

## `scaleFactorPct` Semantics

The scale factor is **not a percentage in the source** — it's a multiplicative double (e.g., 0.2 to 2.0 for expansion; `G1ShrinkByPercentOfAvailable / 100.0` for shrinking). The log multiplies it by 100 (`scale_factor * 100.0`) to display it as a percentage.

For the JFR event, `scaleFactorPct` should store the already-multiplied value (matching the log representation), not the raw multiplicative double. This is consistent with how the log presents it.

## `atLimit` Semantics

`atLimit = true` is emitted when the heap **cannot be resized** despite a resize being desired:
- Expansion path: `capacity() == max_capacity()` → heap is at `-Xmx`
- Shrink path: `capacity() == min_capacity()` → heap is at `-Xms`

When `atLimit = true`, `resizeBytes = 0` and the resize function returns early. This is a signal that the heap is **capacity-constrained** — GC CPU usage pressure exists but the JVM can't respond to it. Persistent `atLimit = true, expand = true` means `-Xmx` is too small for the workload.

## Young-Collection vs Full-Collection Resize

| Aspect | Young-Collection Resize | Full-Collection Resize |
|---|---|---|
| Source function | `young_collection_resize_amount()` | `full_collection_resize_amount()` |
| Trigger mechanism | GC CPU usage deviation counter | Occupancy vs `MinHeapFreeRatio`/`MaxHeapFreeRatio` |
| Fires after | Every young GC (when threshold crossed) | Every full GC only |
| Scaling | Dynamic (sigmoid-based on CPU delta) | Fixed (capacity - desired_capacity) |
| Fields needed | CPU usage %, thresholds, scale | Capacity, occupancy, live, desired |
| Production value | Normal steady-state visibility | Full GC memory pressure visibility |

The proposed `jdk.G1HeapResize` event targets the **young-collection path only**. Full-collection resizing is far less frequent and already partially visible through `jdk.GarbageCollection` duration events.

## JFR Coverage Gap

| Area | JFR Event | Coverage |
|---|---|---|
| Heap size snapshot | `jdk.GCHeapSummary` | Yes (before/after) |
| GC CPU time raw | `jdk.GCCPUTime` | Yes (raw seconds) |
| **Resize decision drivers** | **None** | **ZERO COVERAGE** |
| **CPU usage vs thresholds** | **None** | **ZERO COVERAGE** |
| **atLimit / capacity-constrained** | **None** | **ZERO COVERAGE** |

`jdk.GCHeapSummary` shows the heap size changed, but not **why**. `jdk.GCCPUTime` gives raw CPU seconds, but not the normalized ratio or threshold comparison that drives the policy. The missing observability is the decision logic — the feedback loop inputs and outputs.

## Production Diagnostic Value

**Heap thrashing:** When `resizeBytes` alternates between positive (expand) and negative (shrink) across successive GCs, the heap is oscillating. `shortTermGcCpuUsagePct` vs `longTermGcCpuUsagePct` reveals whether this is genuine load variation or a poorly tuned `G1CPUUsageDeviationPercent`.

**Stuck at limit:** Persistent `atLimit = true, expand = true` is the most actionable signal — it says: "I need more heap, I can't get it." This is the G1-specific early warning before OOM.

**Unexpected heap growth:** When `expand = true` fires frequently, `shortTermGcCpuUsagePct` shows what's driving it. If it's near `gcCpuUsageTargetPct`, the target itself may be too tight (adjust `GCTimeRatio`). If it's far above the target, the workload has genuinely grown.

**Shrink starving live objects:** When `freeRegions - regionsNeededForAlloc` is small during shrink, the policy is trimming close to the live set — increased OOM risk. Visible through `freeRegions` and `regionsNeededForAlloc` together.

## References

- [g1HeapSizingPolicy.cpp](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1HeapSizingPolicy.cpp)
- [g1HeapSizingPolicy.hpp](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1HeapSizingPolicy.hpp)
- [g1Analytics.cpp](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1Analytics.cpp)
- [JDK-8212084 G1 GCOverheadLimit (PR #27950)](https://github.com/openjdk/jdk/pull/27950)
- [tschatzl JDK 27 G1/Parallel GC Changes](https://tschatzl.github.io/2026/08/10/jdk27-g1-serial-parallel-gc-changes.html)
