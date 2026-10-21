#!/usr/bin/env python3
"""Simulate a small FASTQ from a mock community for the website examples.

Picks one reference record per community member (matched by accession prefix
or by the start of the description) and samples reads with substitution errors
at the given abundances, half of them reverse-complemented.
Usage: simulate_reads.py [--preset mock16s|mockITS|mockViral|mockVirome|mockSwiss] ref.fna out.fq.gz [n_reads] [read_len] [seed]
"""
import gzip
import random
import sys

PRESETS = {
    # Zymo-like bacterial/archaeal community (16S)
    "mock16s": [
        ("Pseudomonas aeruginosa", 0.20),
        ("Escherichia coli", 0.15),
        ("Salmonella enterica", 0.12),
        ("Limosilactobacillus fermentum", 0.10),
        ("Enterococcus faecalis", 0.10),
        ("Staphylococcus aureus", 0.10),
        ("Listeria monocytogenes", 0.08),
        ("Bacillus subtilis", 0.08),
        ("Methanobrevibacter smithii", 0.05),
    ],
    # Fungal community (ITS)
    "mockITS": [
        ("Saccharomyces cerevisiae", 0.20),
        ("Candida albicans", 0.18),
        ("Aspergillus fumigatus", 0.14),
        ("Malassezia restricta", 0.12),
        ("Cryptococcus neoformans", 0.10),
        ("Penicillium chrysogenum", 0.10),
        ("Nakaseomyces glabratus", 0.08),
        ("Debaryomyces hansenii", 0.08),
    ],
    # Human viruses (shotgun reads from RefSeq genomes)
    "mockViral": [
        ("NC_045512", 0.20),  # SARS-CoV-2
        ("NC_001802", 0.15),  # HIV-1
        ("NC_003977", 0.12),  # hepatitis B virus
        ("NC_001526", 0.12),  # human papillomavirus 16
        ("NC_001806", 0.12),  # herpes simplex virus 1
        ("NC_001474", 0.10),  # dengue virus 2
        ("NC_004102", 0.10),  # hepatitis C virus genotype 1
        ("NC_035889", 0.09),  # Zika virus
    ],
    # mockViral plus bacteriophages (for the viral protein index, which includes phages)
    "mockVirome": [
        ("NC_045512", 0.14),  # SARS-CoV-2
        ("NC_001802", 0.10),  # HIV-1
        ("NC_003977", 0.08),  # hepatitis B virus
        ("NC_001526", 0.08),  # human papillomavirus 16
        ("NC_001806", 0.08),  # herpes simplex virus 1
        ("NC_001474", 0.07),  # dengue virus 2
        ("NC_004102", 0.07),  # hepatitis C virus genotype 1
        ("NC_035889", 0.06),  # Zika virus
        ("NC_001416", 0.12),  # Escherichia phage lambda
        ("NC_000866", 0.10),  # Escherichia phage T4
        ("NC_049977", 0.10),  # Bacteroides phage crAss001
    ],
    # Shotgun reads from complete genomes (for Swiss-Prot): well-studied species
    # plus two gut commensals with few Swiss-Prot entries
    "mockSwiss": [
        ("NC_000913", 0.20),  # Escherichia coli K-12 MG1655
        ("NC_000964", 0.15),  # Bacillus subtilis 168
        ("NC_007795", 0.15),  # Staphylococcus aureus NCTC 8325
        ("NC_002516", 0.15),  # Pseudomonas aeruginosa PAO1
        ("NC_001136", 0.10),  # Saccharomyces cerevisiae chromosome IV
        ("NZ_CP022479", 0.13),  # Faecalibacterium duncaniae A2-165
        ("NC_004663", 0.12),  # Bacteroides thetaiotaomicron VPI-5482
    ],
}


def read_fasta(path):
    name, seq = None, []
    with open(path) as fp:
        for line in fp:
            if line.startswith(">"):
                if name:
                    yield name, "".join(seq)
                name, seq = line[1:].strip(), []
            else:
                seq.append(line.strip())
    if name:
        yield name, "".join(seq)


def main():
    args = sys.argv[1:]
    preset = "mock16s"
    if args and args[0] == "--preset":
        preset, args = args[1], args[2:]
    community = PRESETS[preset]
    ref, out = args[0], args[1]
    n = int(args[2]) if len(args) > 2 else 5000
    rlen = int(args[3]) if len(args) > 3 else 150
    rng = random.Random(int(args[4]) if len(args) > 4 else 17)

    picked = {}
    for name, seq in read_fasta(ref):
        acc = name.split()[0]
        desc = name.split(" ", 1)[1] if " " in name else ""
        for key, _ in community:
            if key in picked or len(seq) < rlen + 50:
                continue
            if acc.split(".")[0] == key or desc.startswith(key):
                picked[key] = (acc, seq)
    members = [(k, w) for k, w in community if k in picked]
    for k, _ in community:
        if k not in picked:
            sys.stderr.write("warning: %s not found in %s\n" % (k, ref))
    total = sum(w for _, w in members)
    for k, w in members:
        sys.stderr.write("%s\t%s\t%.3f\n" % (k, picked[k][0], w / total))

    comp = {"A": "T", "C": "G", "G": "C", "T": "A"}
    with gzip.open(out, "wt") as fp:
        for i in range(n):
            sp = rng.choices([m[0] for m in members], weights=[m[1] for m in members])[0]
            acc, seq = picked[sp]
            start = rng.randrange(0, len(seq) - rlen + 1)
            r = list(seq[start:start + rlen].upper())
            for j in range(rlen):
                if rng.random() < 0.005:
                    r[j] = rng.choice([b for b in "ACGT" if b != r[j]])
            r = "".join(r)
            if rng.random() < 0.5:
                r = "".join(comp.get(b, "N") for b in reversed(r))
            fp.write("@mock_%06d_%s\n%s\n+\n%s\n" % (i, acc, r, "I" * rlen))


if __name__ == "__main__":
    main()
