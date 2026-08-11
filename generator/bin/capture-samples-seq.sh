#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
# SPDX-License-Identifier: GPL-2.0-only
#
# capture-samples-seq.sh — like capture-samples.sh but runs each collector SEQUENTIALLY,
# matching its log into head.json and deleting the raw log before starting the next GC.
# A full 5-minute `all=trace` run across 3 collectors produces ~20 GB of raw logs; running
# them in parallel would need all of it on disk at once. Sequential + delete-between keeps
# the on-disk footprint to a single GC's log (~6 GB), so it fits on a constrained disk.
#
# Usage:
#   capture-samples-seq.sh <head.json> <workdir> <duration-sec> <benchmark> [benchmark2 ...]
#
# Env: JAVA, RENAISSANCE, XLOG (default all=trace), JAR (generator jar path).
set -u

HEAD="$1"; WORK="$2"; DUR="$3"; shift 3
BENCHES=("$@")
mkdir -p "$WORK"

JAVA=${JAVA:-java}
RENAISSANCE=${RENAISSANCE:-$HOME/renaissance/renaissance.jar}
XLOG=${XLOG:-all=trace}
JAR=${JAR:?set JAR to the generator jar path}

declare -A GCFLAG=( [G1]="-XX:+UseG1GC" [ZGC]="-XX:+UseZGC" [Parallel]="-XX:+UseParallelGC" )

echo "host=$(hostname) java=$($JAVA -version 2>&1 | head -1)"
echo "renaissance=$RENAISSANCE xlog=$XLOG duration=${DUR}s benches=${BENCHES[*]}"

for gc in G1 ZGC Parallel; do
  if ! $JAVA ${GCFLAG[$gc]} -version >/dev/null 2>&1; then
    echo "skip $gc (collector unavailable)"; continue
  fi
  log="$WORK/${gc}.log"; meta="$WORK/${gc}.meta"
  echo "=== $gc: recording ${DUR}s ==="
  start=$(date +%s.%N)
  timeout $((DUR + 120)) "$JAVA" ${GCFLAG[$gc]} \
    -Xms256m -Xmx256m \
    -Xlog:"$XLOG":file="$log":time,uptime,level,tags:filecount=0 \
    -jar "$RENAISSANCE" --run-seconds "$DUR" "${BENCHES[@]}" \
    >"$WORK/${gc}.stdout" 2>&1
  end=$(date +%s.%N)
  awk "BEGIN{printf \"wallSeconds=%.3f\n\", $end-$start}" > "$meta"
  echo "  recorded $(wc -l <"$log" 2>/dev/null || echo 0) lines ($(du -h "$log" 2>/dev/null | cut -f1))"

  # Match this GC only: a temp dir holding just this GC's log + meta. The generator's `samples`
  # command reads head.json, folds in the GCs it finds, and rewrites head.json — so calling it
  # once per GC accumulates all three collectors' samples.
  onedir="$WORK/one_${gc}"; rm -rf "$onedir"; mkdir -p "$onedir"
  mv "$log" "$onedir/${gc}.log"; cp "$meta" "$onedir/${gc}.meta"
  echo "  matching $gc into $HEAD"
  "$JAVA" -jar "$JAR" samples "$HEAD" "$onedir" 5
  # Drop the multi-GB raw log now; keep only the bounded head.<gc>.log sibling the generator wrote.
  rm -rf "$onedir"
  echo "  freed $gc raw log; disk now: $(df -h "$WORK" | tail -1 | awk '{print $4" free"}')"
done

echo "All collectors done. head.json updated: $HEAD"
