# Native Heap Trimming — Observability Research

## What Native Heap Trimming Does

The JVM allocates native (C heap) memory via `malloc`/`free` for internal data structures — class metadata, code cache overflow, JIT compiler buffers, GC internal state. On Linux, glibc's `malloc` uses `mmap` for large allocations but pools smaller ones in heap segments. After a GC cycle that frees large amounts of Java heap, these `malloc` arenas often retain freed memory as **virtual address space retained for future allocations** — visible as RSS (Resident Set Size) bloat even though the Java heap is smaller.

**Native heap trimming** calls `malloc_trim(0)` (on Linux) to release these freed glibc `malloc` arenas back to the OS via `MADV_DONTNEED` or `munmap`. The result is reduced RSS without changing Java heap size.

## Why This Matters in Containers

In Kubernetes/Docker deployments:
- **Memory limits** are enforced against RSS, not Java heap size
- After a GC, Java heap may shrink but RSS stays high (malloc arenas retained)
- This can trigger OOMKill even when the JVM is healthy
- Customers historically worked around this with `jcmd VM.native_memory` or manual `jcmd System.trim_native_heap` on a schedule

JDK 21 added automatic native heap trimming (`NativeHeapTrimmer` thread, `-XX:TrimNativeHeapInterval` in ms). JDK 22 made it a product flag (JDK-8325496). The trimmer fires after GC cycles when the JVM is idle.

## The Trim Operation

Source: `src/hotspot/share/runtime/trimNativeHeap.cpp`

```
execute_trim_and_log():
  1. Measure RSS before: sc.before = os::get_rss_kb() * 1024
  2. Call os::trim_native_heap() → malloc_trim(0)
  3. Measure RSS after: sc.after = os::get_rss_kb() * 1024
  4. Log result
```

**RSS measurement:** Reads `/proc/self/status` → `VmRSS` field. Returns `SIZE_MAX` if unavailable (non-Linux, restricted `/proc` access in hardened containers). When `sc.after == SIZE_MAX`, the "no details" log line fires and `detailsAvailable = false`.

### Log Format Strings

With details:
```
Periodic Trim (UINT64_FORMAT): PROPERFMT->PROPERFMT (%cPROPERFMT) %.3fms
```
Example: `Periodic Trim (42): 512M->480M (-32M) 45.123ms`

Where:
- `UINT64_FORMAT` = `_num_trims_performed` (counter, starts at 1)
- `PROPERFMT` = auto-scaled size with unit suffix (K/M/G)
- `%c` = `'+'` if after > before (RSS grew), `'-'` if after < before (RSS reduced)
- `%.3fms` = trim duration

Without details:
```
Periodic Trim (UINT64_FORMAT): complete (no details) %.3fms
```

### `deltaBytes` Semantics (Corrected)

The source computes:
```cpp
const size_t delta = (sc.after < sc.before) ? (sc.before - sc.after) : (sc.after - sc.before);
const char sign = (sc.after < sc.before) ? '-' : '+';
```

`delta` is **unsigned** (absolute value). The sign is a separate char. For JFR, `deltaBytes` should be a **signed long** computed as `afterBytes - beforeBytes`:
- Negative = RSS reduced (memory returned to OS) — the normal/good case
- Positive = RSS grew during trim (unusual; can happen if trim causes other allocations)

## Upstream Status

**JDK-8365306 (PR #26756)** was opened by tstuefe (Thomas Stüfe) and proposed three events:
1. `NativeHeapTrim` — trim timing and RSS recovery *(no upstream objection to this event)*
2. `ProcessSize` — normalized process memory by type (RSS, virtual, swap, etc.) *(blocked by design dispute)*
3. `LibcStatistics` — malloc outstanding/retained allocations *(secondary)*

The PR was **closed 2025-12 due to inactivity** after a design dispute with Erik Gahlin (JFR lead) about `ProcessSize`. Gahlin's objection: `ProcessSize` should be a normalized `ProcessMemoryUsage` event with a `MemoryType` field (like `NativeMemoryUsage`), not a wide struct. The `NativeHeapTrim` event itself was not blocked.

**Recommendation:** Re-propose only `jdk.NativeHeapTrim` as a standalone duration event. Align the field schema with whatever design emerges from the `ProcessMemoryUsage` normalization discussion.

## Relationship to `jdk.ResidentSetSize`

`jdk.ResidentSetSize` (exists in JDK 25+) emits RSS and peak RSS **periodically** (`everyChunk` by default, configurable). It does NOT capture:
- The trim operation itself
- RSS delta caused by the trim
- Whether the trim is effective (RSS after vs before)
- Trim frequency or sequence number

`jdk.NativeHeapTrim` is complementary: it's a duration event tied to each individual trim operation, not a periodic sampler.

## Production Diagnostic Value

**Key question:** "Is automatic native heap trimming actually returning memory?"

Without the JFR event:
1. Enable `-Xlog:trimnative=info` to see trim log
2. Sample RSS from outside (`/proc/self/status`, container metrics)
3. Correlate timestamps manually

With the JFR event:
- `deltaBytes` per trim shows effectiveness immediately
- `trimCount` shows trim frequency
- `duration` shows trim overhead (malloc_trim can be slow on systems with many arenas)
- `detailsAvailable = false` quickly identifies containers where the measurement doesn't work

**Common failure mode:** RSS stays high after GC in containers. With trim event visible in JFR, operator can see: trim fired (trimCount incremented), duration was 200ms, but deltaBytes = 0 → malloc arenas were not holding free memory → investigate JVM native allocation patterns instead.

## `jdk.GCOverheadLimitExceeded` — Production Context

When `GCOverheadLimitExceeded` fires, it is immediately before the JVM throws `OutOfMemoryError: GC overhead limit exceeded`. At this point:
- The JVM has just completed N consecutive GC cycles (default N=5)
- Each cycle: GC time ≥ 98% AND free heap ≤ 2%
- The JVM decides: "we're not making progress, fail fast"

**Why the current situation is a problem:** `MetaspaceOOM` has a JFR event (`jdk.MetaspaceAllocationFailure`). GC overhead limit has no event. The only way to diagnose it is:
1. Parse GC logs for "GC Overhead Limit exceeded too often"
2. Catch the OOM in application code
3. Check heap dumps after the fact

The proposed `jdk.GCOverheadLimitExceeded` would fire **before** the OOM, making it possible to:
- Alert on consecutive violations (consecutiveViolations trending toward GCOverheadLimitThreshold=5)
- See whether the failure is time-driven (gcTimePercent ≈ 98%) or space-driven (freeSpacePercent ≈ 2%)
- Correlate with other GC events (gcId) to see what types of GC were failing

## References

- [trimNativeHeap.cpp](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/runtime/trimNativeHeap.cpp)
- [JDK-8365306 NativeHeapTrim PR #26756 (closed)](https://github.com/openjdk/jdk/pull/26756)
- [JDK-8293114 jcmd System.trim_native_heap PR #14781](https://github.com/openjdk/jdk/pull/14781)
- [g1CollectedHeap.cpp (GCOverheadLimit G1)](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/g1/g1CollectedHeap.cpp)
- [parallelScavengeHeap.cpp (GCOverheadLimit Parallel)](https://github.com/openjdk/jdk/blob/master/src/hotspot/share/gc/parallel/parallelScavengeHeap.cpp)
- [JDK-8212084 G1 UseGCOverheadLimit (merged JDK 26, PR #27950)](https://github.com/openjdk/jdk/pull/27950)
- [jdk.ResidentSetSize event (JDK 25)](https://bestsolution-at.github.io/jfr-doc/openjdk-25.html)
