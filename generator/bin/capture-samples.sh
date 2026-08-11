#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 SAP SE or an SAP affiliate company and jdklogs contributors
# SPDX-License-Identifier: GPL-2.0-only
#
# capture-samples.sh — run a small renaissance benchmark under several GCs with a
# restricted heap and a broad -Xlog selector, capturing real HotSpot log output plus
# the wall-time of each run. The generator's `samples` command later parses these logs,
# matches each line back to a source log site by format string, and records per-(level,
# tagset) byte/line volume for the frontend's "MB/hour" estimate.
#
# Usage:
#   capture-samples.sh <outdir> <duration-sec> <benchmark> [benchmark2 ...]
#
# Env:
#   JAVA          java binary (default: java)
#   RENAISSANCE   path to renaissance.jar (default: ~/renaissance/renaissance.jar; downloaded if absent)
#   XLOG          the -Xlog selector to capture (default: all=trace)
#
# Output per (bench,gc):  <outdir>/<gc>.log     raw log lines with time,uptime,level,tags decorators
#                         <outdir>/<gc>.meta    "wallSeconds=<n>" (measured run wall time)
set -u

OUT="$1"; DUR="$2"; shift 2
BENCHES=("$@")
mkdir -p "$OUT"

JAVA=${JAVA:-java}
RENAISSANCE=${RENAISSANCE:-$HOME/renaissance/renaissance.jar}
# Broad but bounded: trace on everything produces a rich sample. Decorators time,uptime,level,tags
# let the matcher split each line into (uptime | level | tagset | message).
XLOG=${XLOG:-all=trace}

if [ ! -f "$RENAISSANCE" ]; then
  mkdir -p "$(dirname "$RENAISSANCE")"
  echo "renaissance.jar not found at $RENAISSANCE — downloading latest GA release" >&2
  url=$(curl -fsSL https://api.github.com/repos/renaissance-benchmarks/renaissance/releases/latest \
        | grep -o 'https://[^"]*renaissance-gpl[^"]*\.jar' | head -1)
  [ -z "$url" ] && { echo "ERROR: could not resolve renaissance download URL" >&2; exit 1; }
  curl -fsSL "$url" -o "$RENAISSANCE"
fi

echo "host=$(hostname) java=$($JAVA -version 2>&1 | head -1)"
echo "renaissance=$RENAISSANCE  xlog=$XLOG  duration=${DUR}s  benches=${BENCHES[*]}"

# --- collector availability -------------------------------------------------
declare -A GCFLAG=( [G1]="-XX:+UseG1GC" [ZGC]="-XX:+UseZGC" [Parallel]="-XX:+UseParallelGC" )
avail=()
for gc in G1 ZGC Parallel; do
  if $JAVA ${GCFLAG[$gc]} -version >/dev/null 2>&1; then avail+=("$gc"); fi
done
echo "Available collectors: ${avail[*]}"

# --- one recording run (backgrounded) --------------------------------------
run_one() {
  local gc="$1"; local log="$OUT/${gc}.log"; local meta="$OUT/${gc}.meta"
  local start end
  start=$(date +%s.%N)
  timeout $((DUR + 90)) "$JAVA" ${GCFLAG[$gc]} \
    -Xms256m -Xmx256m \
    -Xlog:"$XLOG":file="$log":time,uptime,level,tags:filecount=0 \
    -jar "$RENAISSANCE" --run-seconds "$DUR" "${BENCHES[@]}" \
    >"$OUT/${gc}.stdout" 2>&1
  end=$(date +%s.%N)
  awk "BEGIN{printf \"wallSeconds=%.3f\n\", $end-$start}" > "$meta"
  echo "  done: $gc (exit $?, $(wc -l <"$log" 2>/dev/null || echo 0) lines)"
}

echo "Launching recordings in parallel..."
for gc in "${avail[@]}"; do run_one "$gc" & done
wait
echo "All recordings finished. Logs in $OUT/"
