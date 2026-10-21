#!/usr/bin/env python3
"""Score Centrifuger classifications of simulated mock reads at one rank.

Reads are named @mock_<n>_<source accession> by simulate_reads.py. For each
source, counts reads assigned to the expected taxon at the rank (or below it),
reads left above the rank, and reads assigned to a wrong taxon.
At genus rank the expected genus names are compared directly; at family or
phylum the call's ancestor at that rank must match the expected genus's.
Usage: eval_mock.py [--rank genus|family|phylum] <nodes.dmp> <names.dmp> <classification.tsv>
"""
import collections
import re
import sys

# Expected genus per source accession; alternatives cover NCBI vs GTDB names.
EXPECTED = {
    "NR_117678.1": ["Pseudomonas"],
    "NR_114042.1": ["Escherichia", "Escherichia-Shigella"],
    "NR_074910.1": ["Salmonella"],
    "NR_118978.1": ["Limosilactobacillus"],
    "NR_115765.1": ["Enterococcus"],
    "NR_037007.2": ["Staphylococcus"],
    "NR_044823.1": ["Listeria"],
    "NR_102783.2": ["Bacillus"],
    "NR_115169.1": ["Methanobrevibacter", "Methanocatella"],
    # fungal ITS
    "NR_111007.1": ["Saccharomyces"],
    "NR_125332.1": ["Candida"],
    "NR_121481.1": ["Aspergillus"],
    "NR_103585.1": ["Malassezia"],
    "NR_171785.1": ["Cryptococcus"],
    "NR_077145.1": ["Penicillium"],
    "NR_130691.1": ["Nakaseomyces"],
    "NR_120016.1": ["Debaryomyces"],
    # viral genomes
    "NC_045512.2": ["Betacoronavirus"],
    "NC_001802.1": ["Lentivirus"],
    "NC_003977.2": ["Orthohepadnavirus"],
    "NC_001526.4": ["Alphapapillomavirus"],
    "NC_001806.2": ["Simplexvirus"],
    "NC_001474.2": ["Orthoflavivirus", "Flavivirus"],
    "NC_004102.1": ["Hepacivirus", "Orthohepacivirus"],
    "NC_035889.1": ["Orthoflavivirus", "Flavivirus"],
    "NC_001416.1": ["Lambdavirus"],
    "NC_000866.4": ["Tequatrovirus"],
    "NC_049977.1": ["Kehishuvirus"],
    # bacterial and yeast genomes
    "NC_000913.3": ["Escherichia"],
    "NC_000964.3": ["Bacillus"],
    "NC_007795.1": ["Staphylococcus"],
    "NC_002516.2": ["Pseudomonas"],
    "NC_001136.10": ["Saccharomyces"],
    "NZ_CP022479.1": ["Faecalibacterium"],
    "NC_004663.1": ["Bacteroides"],
}


def load_dmp(path, key_col, val_col):
    out = {}
    with open(path) as fp:
        for line in fp:
            f = line.rstrip("\n").split("\t|\t")
            out[f[key_col].strip()] = f[val_col].strip().rstrip("\t|")
    return out


def main():
    args = sys.argv[1:]
    target = "genus"
    if args and args[0] == "--rank":
        target, args = args[1], args[2:]
    parent = load_dmp(args[0], 0, 1)
    rank = load_dmp(args[0], 0, 2)
    name = {}
    with open(args[1]) as fp:
        for line in fp:
            f = [x.strip() for x in line.split("|")]
            if "scientific name" in f:  # NCBI (4 fields) or 3-field dmp files
                name[f[0]] = f[1]

    def ancestor(tid, r):
        for _ in range(64):
            if tid not in rank:
                return None
            if rank[tid] == r:
                return tid
            if tid == parent.get(tid):
                return None
            tid = parent[tid]
        return None

    def genus_of(tid):
        return name.get(ancestor(tid, "genus"))

    # Expected taxIDs at the target rank: ancestors of the expected genera.
    genus_ids = collections.defaultdict(list)
    for tid, nm in name.items():
        if rank.get(tid) == "genus":
            genus_ids[nm].append(tid)
    expected_at = {src: {ancestor(g, target) for n in names for g in genus_ids.get(n, [])} - {None}
                   for src, names in EXPECTED.items()}

    stats = collections.defaultdict(collections.Counter)
    seen = set()
    with open(args[2]) as fp:
        next(fp)
        for line in fp:
            f = line.split("\t")
            if f[0] in seen:
                continue
            seen.add(f[0])
            m = re.match(r"mock_\d+_(.+)$", f[0])
            if not m or m.group(1) not in EXPECTED:
                continue
            src = m.group(1)
            if f[1] == "unclassified":
                stats[src]["unclassified"] += 1
                continue
            at = ancestor(f[2], target)
            if at is None:
                stats[src]["above_genus"] += 1
            elif target == "genus":
                g = name.get(at)
                stats[src]["correct" if re.sub(r"_[A-Z]+$", "", g) in EXPECTED[src] else "wrong:" + g] += 1
            else:
                stats[src]["correct" if at in expected_at[src] else "wrong:" + name.get(at, at)] += 1

    tot = collections.Counter()
    for src in sorted(stats, key=lambda s: EXPECTED[s][0]):
        c = stats[src]
        n = sum(c.values())
        wrong = sum(v for k, v in c.items() if k.startswith("wrong:"))
        top_wrong = ", ".join("%s %d" % (k[6:], v) for k, v in c.most_common() if k.startswith("wrong:"))[:60]
        print("%-20s n=%4d correct=%5.1f%% above=%5.1f%% wrong=%5.1f%%  %s" % (
            EXPECTED[src][0], n, 100 * c["correct"] / n, 100 * c["above_genus"] / n, 100 * wrong / n, top_wrong))
        tot["n"] += n
        tot["correct"] += c["correct"]
        tot["above"] += c["above_genus"]
        tot["wrong"] += wrong
    if tot["n"]:
        print("%-20s n=%4d correct=%5.1f%% above=%5.1f%% wrong=%5.1f%%" % (
            "ALL", tot["n"], 100 * tot["correct"] / tot["n"], 100 * tot["above"] / tot["n"], 100 * tot["wrong"] / tot["n"]))


if __name__ == "__main__":
    main()
