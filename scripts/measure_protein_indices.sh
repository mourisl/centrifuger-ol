#!/usr/bin/env bash
# Build candidate protein indices natively and measure them, to decide whether
# any are small enough for the website. Works only under index_build/protein/;
# the website build (build_index.sh, site/) is not touched.
#
#   bash scripts/measure_protein_indices.sh [threads] [names...]
#
# Names: refseq_viral_prot (with phages), swissprot, refseq_plastid_prot
# Results: index_build/protein/sizes.tsv (one row per index and offrate)
set -euo pipefail

THREADS=${1:-4}
shift || true
NAMES=${*:-refseq_viral_prot swissprot refseq_plastid_prot}
WA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$WA_DIR/build/native/centrifuger-build"
CLASSIFY="$WA_DIR/build/native/centrifuger"
NCBI=https://ftp.ncbi.nlm.nih.gov
UNIPROT=https://ftp.uniprot.org/pub/databases/uniprot/current_release/knowledgebase/complete
EUTILS=https://eutils.ncbi.nlm.nih.gov/entrez/eutils
OUT="$WA_DIR/index_build/protein"
OFFRATES="5 7"
PART=$((24 * 1024 * 1024))
CHECK_READS=5000

[ -x "$BUILD" ] && [ -x "$CLASSIFY" ] || { echo "Run 'make native' first." >&2; exit 1; }

fetch() {
  if [ ! -s "$2" ]; then
    curl -fsS --retry 3 -o "$2.tmp" "$1" && mv -f "$2.tmp" "$2"
  fi
}

# Same helpers as build_index.sh (copied so the website build stays independent).
ncbi_taxonomy() {
  local d="$WA_DIR/index_build/ncbi_taxonomy"
  mkdir -p "$d"
  fetch "$NCBI/pub/taxonomy/taxdump.tar.gz" "$d/taxdump.tar.gz"
  [ -s "$d/nodes.dmp" ] && [ -s "$d/names.dmp" ] && [ -s "$d/merged.dmp" ] ||
    tar -xzf "$d/taxdump.tar.gz" -C "$d" nodes.dmp names.dmp merged.dmp
  ln -sf "$d/nodes.dmp" nodes.dmp
  ln -sf "$d/names.dmp" names.dmp
  ln -sf "$d/merged.dmp" merged.dmp
}

remap_merged() {
  awk -F'\t' 'NR == FNR { m[$1] = $3; next } { t = ($2 in m) ? m[$2] : $2; print $1 "\t" t }' \
    merged.dmp "$1" > seqid2taxid.map
}

gbff_taxids() {
  awk '
    /^VERSION/ { acc = $2 }
    /\/db_xref="taxon:/ { if (acc != "") { match($0, /taxon:[0-9]+/); print acc "\t" substr($0, RSTART + 6, RLENGTH - 6); acc = "" } }'
}

# Nucleotide reads for the functional check: random 150 bp fragments of NCBI records.
check_reads() { # out.fq.gz accession...
  local out=$1
  shift
  [ -s "$out" ] && return
  curl -fsS --retry 3 "$EUTILS/efetch.fcgi?db=nuccore&id=$(IFS=,; echo "$*")&rettype=fasta&retmode=text" > check_genomes.fna
  python3 -I - check_genomes.fna "$out" "$CHECK_READS" <<'PY'
import gzip, random, sys
seqs, cur = [], []
for line in open(sys.argv[1]):
    if line.startswith(">"):
        if cur: seqs.append("".join(cur))
        cur = []
    else:
        cur.append(line.strip().upper())
if cur: seqs.append("".join(cur))
rng = random.Random(7)
with gzip.open(sys.argv[2], "wt") as fp:
    for i in range(int(sys.argv[3])):
        s = rng.choice(seqs)
        p = rng.randrange(0, len(s) - 150)
        fp.write("@check_%d\n%s\n+\n%s\n" % (i, s[p:p + 150], "I" * 150))
PY
}

# ---------- recipes: each produces ref.faa, seqid2taxid.map and check.fq.gz ----------

prep_refseq_viral_prot() {
  fetch "$NCBI/refseq/release/viral/viral.1.protein.faa.gz" viral.protein.faa.gz
  fetch "$NCBI/refseq/release/viral/viral.1.protein.gpff.gz" viral.protein.gpff.gz
  zcat viral.protein.faa.gz > ref.faa
  zcat viral.protein.gpff.gz | gbff_taxids > seqid2taxid.raw.map
  remap_merged seqid2taxid.raw.map
  cp "$WA_DIR/site/example/mockViral.fq.gz" check.fq.gz
}

prep_swissprot() {
  fetch "$UNIPROT/uniprot_sprot.fasta.gz" uniprot_sprot.fasta.gz
  zcat uniprot_sprot.fasta.gz > ref.faa
  awk '/^>/ { if (match($0, / OX=[0-9]+/)) print substr($1, 2) "\t" substr($0, RSTART + 4, RLENGTH - 4) }' \
    ref.faa > seqid2taxid.raw.map
  remap_merged seqid2taxid.raw.map
  check_reads check.fq.gz NC_000913.3 # E. coli K-12 MG1655
}

prep_refseq_plastid_prot() {
  for i in 1 2 3; do
    fetch "$NCBI/refseq/release/plastid/plastid.$i.protein.faa.gz" plastid.$i.protein.faa.gz
    fetch "$NCBI/refseq/release/plastid/plastid.$i.protein.gpff.gz" plastid.$i.protein.gpff.gz
  done
  zcat plastid.[123].protein.faa.gz > ref.faa
  zcat plastid.[123].protein.gpff.gz | gbff_taxids > seqid2taxid.raw.map
  remap_merged seqid2taxid.raw.map
  check_reads check.fq.gz NC_000932.1 # Arabidopsis thaliana chloroplast
}

# ---------- build and measure ----------

mkdir -p "$OUT"
TSV="$OUT/sizes.tsv"
[ -s "$TSV" ] || printf "name\toffrate\tproteins\taa\tmapped\tbuild_s\tbuild_peak_mb\tcfr1_mb\tcfr2_mb\tcfr3_mb\tcfr4_mb\traw_mb\tgz_mb\tparts\tcheck_reads_per_s\tcheck_classified\n" > "$TSV"

for NAME in $NAMES; do
  type "prep_$NAME" >/dev/null 2>&1 || { echo "Unknown index: $NAME" >&2; exit 1; }
  mkdir -p "$OUT/$NAME"
  cd "$OUT/$NAME"
  ncbi_taxonomy
  "prep_$NAME"
  nprot=$(grep -c '^>' ref.faa)
  aa=$(awk '!/^>/ { n += length($0) } END { print n }' ref.faa)
  mapped=$(wc -l < seqid2taxid.map)
  echo "[$NAME] proteins: $nprot, amino acids: $aa, mapped: $mapped"

  for off in $OFFRATES; do
    pre="$NAME.o$off"
    /usr/bin/time -v -o "$pre.time" "$BUILD" --protein -r ref.faa --taxonomy-tree nodes.dmp --name-table names.dmp \
      --conversion-table seqid2taxid.map -o "$pre" -t "$THREADS" --offrate "$off" > "$pre.build.log" 2>&1
    secs=$(awk -F': ' '/Elapsed \(wall clock\)/ { n = split($2, t, ":"); s = 0; for (i = 1; i <= n; i++) s = s * 60 + t[i]; print int(s) }' "$pre.time")
    peak=$(awk -F': ' '/Maximum resident set size/ { printf "%.0f", $2 / 1024 }' "$pre.time")
    raw=0; gz=0; parts=0; mb=""
    for i in 1 2 3 4; do
      s=$(stat -c %s "$pre.$i.cfr")
      g=$(gzip -9 -c "$pre.$i.cfr" | wc -c)
      raw=$((raw + s)); gz=$((gz + g)); parts=$((parts + (g + PART - 1) / PART))
      mb="$mb$(awk -v s="$s" 'BEGIN { printf "%.1f", s / 1e6 }')\t"
    done
    # Functional check: classify the check reads with this index.
    t0=$(date +%s.%N)
    "$CLASSIFY" -x "$pre" -u check.fq.gz -t 1 > "$pre.check.tsv" 2> /dev/null
    t1=$(date +%s.%N)
    rate=$(awk -v a="$t0" -v b="$t1" -v n="$CHECK_READS" 'BEGIN { printf "%.0f", n / (b - a) }')
    cls=$(awk -F'\t' 'NR > 1 && $1 != prev { prev = $1; n++; if ($2 != "unclassified") c++ } END { printf "%.1f%%", 100 * c / n }' "$pre.check.tsv")
    printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%b%s\t%s\t%s\t%s\t%s\n" "$NAME" "$off" "$nprot" "$aa" "$mapped" "$secs" "$peak" "$mb" \
      "$(awk -v s="$raw" 'BEGIN { printf "%.1f", s / 1e6 }')" "$(awk -v s="$gz" 'BEGIN { printf "%.1f", s / 1e6 }')" \
      "$parts" "$rate" "$cls" >> "$TSV"
    tail -1 "$TSV"
    grep -i "warn" "$pre.build.log" | head -5 || true
  done
done
