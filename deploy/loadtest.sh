#!/bin/sh
# Runs cmd/loadtest against the local stack while sampling CPU and memory of
# the containers every second, then prints a summary. Arguments are passed
# to cmd/loadtest. Requires the stack started WITH deploy/compose.loadtest.yaml.
#   deploy/loadtest.sh -docs 4 -members 3 -writers 1 -rate 5 -duration 10s
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
out="${LOADTEST_OUT:-$here/loadtest-results}"
mkdir -p "$out"
stamp=$(date +%Y%m%d-%H%M%S)
stats="$out/$stamp-stats.csv"
report="$out/$stamp-report.txt"
(cd "$here/.." && go build -o "$out/loadtest" ./cmd/loadtest)

# Sampler: one line per container per second.
( while :; do
    docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' \
      collabspace-app-1 collabspace-db-1 collabspace-proxy-1 2>/dev/null | sed "s/^/$(date +%s),/"
  done ) > "$stats" &
sampler=$!
stop_sampler() { kill "$sampler" 2>/dev/null || true; wait "$sampler" 2>/dev/null || true; }
trap stop_sampler EXIT

{
  echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "host: $(uname -sm), $(sysctl -n machdep.cpu.brand_string 2>/dev/null || true), $(sysctl -n hw.ncpu 2>/dev/null || nproc) CPUs"
  echo "docker: $(docker info --format '{{.ServerVersion}} {{.OperatingSystem}}, VM CPUs {{.NCPU}}, VM memory {{.MemTotal}} bytes')"
  echo "args: $*"
  "$out/loadtest" -cacert "$here/secrets/tls/ca.pem" "$@"
} 2>&1 | tee "$report"

stop_sampler
# Summary: peak and mean CPU% and peak memory per container.
python3 - "$stats" "$report" <<'PY' | tee -a "$report"
import sys, collections, re
# The editing phase's window, printed by cmd/loadtest, so registration
# (Argon2id hashing) doesn't distort the numbers.
window = None
txt = open(sys.argv[2]).read()
m1, m2 = re.search(r"phase editing start=(\d+)", txt), re.search(r"phase editing end=(\d+)", txt)
if m1 and m2: window = (int(m1.group(1)), int(m2.group(1)))
rows = collections.defaultdict(list)
edit_rows = collections.defaultdict(list)
def mib(s):
    s = s.strip(); units = {"KiB": 1/1024, "MiB": 1, "GiB": 1024, "kB": 1/1024, "MB": 1, "GB": 1024, "B": 1/1048576}
    for u in sorted(units, key=len, reverse=True):
        if s.endswith(u): return float(s[:-len(u)]) * units[u]
    return float(s)
for line in open(sys.argv[1]):
    parts = line.strip().split(",")
    if len(parts) != 4: continue
    ts, name, cpu, mem = parts
    try: sample = (float(cpu.rstrip("%")), mib(mem.split("/")[0]))
    except ValueError: continue
    rows[name].append(sample)
    if window and window[0] <= int(ts) <= window[1]: edit_rows[name].append(sample)
def show(title, data):
    print(title)
    for name, v in sorted(data.items()):
        cpus = [c for c, _ in v]; mems = [m for _, m in v]
        print(f"{name:22s} samples={len(v):4d} cpu mean={sum(cpus)/len(cpus):6.1f}% peak={max(cpus):6.1f}%  mem peak={max(mems):7.1f} MiB")
show("\n== Containers, whole run incl. setup (docker stats, one sample every ~2 s; 100% = one core)", rows)
if edit_rows: show("== Containers, editing phase only", edit_rows)
PY
echo "report: $report"
