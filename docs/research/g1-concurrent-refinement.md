# G1 Concurrent Refinement — Observability Research

## How G1 Concurrent Refinement Works

G1 uses a **post-write barrier** (the G1 write barrier, redesigned in JDK 25 via JEP 522) to track inter-region references. Every time a mutator stores an object reference that crosses region boundaries, the card containing the source object is marked dirty in the card table and enqueued in the **Dirty Card Queue Set (DCQS)**.

The DCQS accumulates dirty cards continuously during mutator execution. Concurrent refinement threads sweep these cards between GC pauses, updating the **remembered sets (RSets)** of the target regions. If refinement can't keep up, dirty cards pile up; at the next Young GC pause, G1 must process the remaining cards synchronously in the "Scan Heap Roots" sub-phase — which directly adds to pause time.

### Refinement Thread Activation

The number of active refinement threads is controlled adaptively:

- `G1ConcurrentRefine::adjust_threads_wanted()` runs after each sweep
- It computes `_pending_cards_target` based on measured scan rate vs the pause goal
- Thread count increases if cards-per-ms is insufficient to drain the queue in time

### Card Categories (from `G1ConcurrentRefineStats`)

| Source field | Meaning |
|---|---|
| `cards_scanned` | Total cards dequeued and inspected |
| `cards_clean` | Cards already clean at scan time (another thread processed them) |
| `cards_not_parsable` | Region was mid-transition (e.g., being allocated); card skipped |
| `cards_no_cross_region` | Reference is within the same region; no RSet update needed |
| `cards_refer_to_cset` | Card's target is in the current collection set |
| `cards_still_refer_to_cset` | Card's target is STILL in CSet after refinement (CSet churn) |
| `pending` | Cards remaining in queue after this sweep |

High `cardsNoCrossRegion` is desirable — it means most writes are locality-friendly and refinement work is minimal. High `cardsStillRefersToCset` vs `cardsRefersToCset` delta indicates the CSet is changing rapidly (mixed-phase GC churn).

### Two Distinct Log Sites (Different Cadences)

**`print_refinement_stats()`** — fires once per refinement sweep (potentially several times per GC pause):
```
Refinement took %.2fms (pre-sweep %.2fms card refine %.2fms)
(scanned %zu clean %zu (%.2f%%) not_clean %zu (%.2f%%) not_parsable %zu
 refers_to_cset %zu (%.2f%%) still_refers_to_cset %zu (%.2f%%) no_cross_region %zu pending %zu)
```
Source: `src/hotspot/share/gc/g1/g1ConcurrentRefine.cpp`, `print_refinement_stats()`

**`adjust_threads_wanted()`** — fires once per GC pause via `G1Policy::record_young_collection_end()`:
```
Concurrent refinement: wanted %u, pending cards: %zu (pending-from-gc %zu),
predicted: %zu, goal %zu, time-until-next-gc: %1.2fms
pred-refine-rate %1.2fc/ms log-rate %1.2fc/ms
```
Source: `src/hotspot/share/gc/g1/g1ConcurrentRefine.cpp`, `adjust_threads_wanted()`

**`record_young_collection_end()`** — policy summary per pause:
```
GC refinement: goal: %zu / %1.2fms, actual: %zu / %1.2fms, %s
```
Source: `src/hotspot/share/gc/g1/g1Policy.cpp`

### JDK 25 Write Barrier Redesign (JEP 522)

JEP 522 ("New Write Barriers for G1") merged in JDK 25 and fundamentally changed how cards are enqueued:
- Eliminated the "pre-write barrier" for SATB marking during concurrent marking
- Simplified the card mark path for the remembered-set write barrier
- The new barrier is cheaper per-write but the overall refinement dynamic is similar

**Production impact of refinement lag:** When the refinement queue grows faster than threads can drain it, the Young GC "Scan Heap Roots" sub-phase grows proportionally. On write-heavy workloads (message queues, caches) this can add 10-50ms to pauses with no visible cause in default GC logs.

## Existing JFR Coverage

| Area | JFR Event | Coverage |
|---|---|---|
| Young GC pause | `jdk.GarbageCollection` + `jdk.GCPhasePause` | Yes |
| G1 MMU | `jdk.G1MMU` | Yes (pause time vs GC time limit) |
| Card table | None | **ZERO COVERAGE** |
| Refinement sweep | None | **ZERO COVERAGE** |
| Refinement policy | None | **ZERO COVERAGE** |
| IHOP (old-gen trigger) | `jdk.G1AdaptiveIHOP`, `jdk.G1BasicIHOP` | Yes |

## Proposed Events

### `jdk.G1ConcurrentRefinementSweep`
- **Covers:** `print_refinement_stats()` — per-sweep card statistics
- **Key diagnostic:** `cardsScanned / duration` = scan rate (cards/ms). If consistently < `threadsWanted * cardRateGoal`, refinement is falling behind.
- **Priority:** High — this is the lowest-level view of write-barrier pressure

### `jdk.G1ConcurrentRefinementPolicy`
- **Covers:** `adjust_threads_wanted()` + `record_young_collection_end()` — per-pause policy state
- **Key diagnostic:** `pendingCards vs pendingCardsTarget` + `exceededGoal`. If `pendingCards >> pendingCardsTarget` repeatedly, the refinement thread count needs tuning or the heap layout needs redesign.
- **Priority:** High — needed to understand why thread count changes

## Tuning Guidance (Context for Event Interpretation)

- `-XX:G1RefinementThreshold` (default: computed) — target pending cards before activating threads
- `-XX:G1ConcRefinementThreads` (default: computed from ParallelGCThreads) — max refinement threads
- High `cardsScanned` with low `cardsClean` = genuine write pressure (refinement doing real work)
- High `cardsScanned` with high `cardsClean` = queue draining redundancy (another thread already processed)
- `cardsPending` trending upward across sweeps → pauses will grow

## References

- [G1 Concurrent Refinement source](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1ConcurrentRefine.cpp)
- [G1 Policy source](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1Policy.cpp)
- [JEP 522: New Write Barriers for G1](https://openjdk.org/jeps/522)
- [tschatzl JDK 25 G1/Parallel GC Changes](https://tschatzl.github.io/2025/08/12/jdk25-g1-serial-parallel-gc-changes.html)
- [tschatzl: New Write Barriers (2025-02-21)](https://tschatzl.github.io/2025/02/21/new-write-barriers.html)
- [tschatzl JDK 26 G1/Parallel GC Changes](https://tschatzl.github.io/2026/02/26/jdk26-g1-serial-parallel-gc-changes.html)
- [JFR event catalog JDK 26](https://bestsolution-at.github.io/jfr-doc/openjdk-26.html)
