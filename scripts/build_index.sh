#!/usr/bin/env bash
# Build one of the website's prebuilt Centrifuger indices and install it into
# site/index/<name>/ as the four plain <name>.<i>.cfr files (no compression, so
# users can download and use them with native Centrifuger) plus manifest.json,
# then refresh site/index/indices.json. The .cfr files are published as GitHub
# release assets (scripts/publish_indices.sh), not committed.
#
#   bash scripts/build_index.sh <name> [threads]
#   bash scripts/build_index.sh all [threads]
#
# Names: refseq16s, refseq_fungi, gtdb_ssu, silva_ssu, refseq_viral,
#        refseq_viral_prot, swissprot (protein indices)
# Requires: curl, gzip, awk, sha256sum, python3, and `make native`.
set -euo pipefail

NAME=${1:?usage: build_index.sh <name|all> [threads]}
THREADS=${2:-4}
WA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$WA_DIR/build/native/centrifuger-build"
NCBI=https://ftp.ncbi.nlm.nih.gov
GTDB=https://data.gtdb.ecogenomic.org/releases/release232/232.0
SILVA_VER=138.2
SILVA=https://www.arb-silva.de/fileadmin/silva_databases/release_${SILVA_VER//./_}/Exports
UNIPROT=https://ftp.uniprot.org/pub/databases/uniprot/current_release/knowledgebase/complete

[ -x "$BUILD" ] || { echo "Run 'make native' first." >&2; exit 1; }

if [ "$NAME" = all ]; then
  for n in refseq16s refseq_fungi gtdb_ssu silva_ssu refseq_viral refseq_viral_prot swissprot; do
    bash "$0" "$n" "$THREADS"
  done
  exit 0
fi

fetch() {
  if [ ! -s "$2" ]; then
    curl -fsS --retry 3 -o "$2.tmp" "$1" && mv -f "$2.tmp" "$2"
  fi
}

# NCBI taxonomy shared by the NCBI-based indices
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

# Replace taxIDs that NCBI has merged into another taxID: raw map -> seqid2taxid.map
remap_merged() {
  awk -F'\t' 'NR == FNR { m[$1] = $3; next } { t = ($2 in m) ? m[$2] : $2; print $1 "\t" t }' \
    merged.dmp "$1" > seqid2taxid.map
}

# seqID -> taxID from GenBank flat files on stdin (VERSION + /db_xref="taxon:N")
gbff_taxids() {
  awk '
    /^VERSION/ { acc = $2 }
    /\/db_xref="taxon:/ { if (acc != "") { match($0, /taxon:[0-9]+/); print acc "\t" substr($0, RSTART + 6, RLENGTH - 6); acc = "" } }'
}

# ---------- recipes: each produces ref.fna, seqid2taxid.map, nodes.dmp, names.dmp ----------

recipe_refseq16s() {
  TITLE="NCBI RefSeq 16S rRNA (Bacteria + Archaea)"
  DESC="RefSeq Targeted Loci 16S rRNA sequences with NCBI taxonomy. For 16S amplicon reads."
  TAXONOMY="NCBI"; OFFRATE=4; EXAMPLE="mock16s"
  ncbi_taxonomy
  for d in Bacteria/bacteria Archaea/archaea; do
    for e in fna gbff; do fetch "$NCBI/refseq/TargetedLoci/$d.16SrRNA.$e.gz" "$(basename $d).16SrRNA.$e.gz"; done
  done
  zcat bacteria.16SrRNA.fna.gz archaea.16SrRNA.fna.gz > ref.fna
  zcat bacteria.16SrRNA.gbff.gz archaea.16SrRNA.gbff.gz | gbff_taxids > seqid2taxid.raw.map
  remap_merged seqid2taxid.raw.map
}

recipe_refseq_fungi() {
  TITLE="NCBI RefSeq fungal ITS, 18S and 28S rRNA"
  DESC="RefSeq Targeted Loci fungal ITS, 18S and 28S rRNA sequences with NCBI taxonomy. For fungal (mycobiome) amplicon reads."
  TAXONOMY="NCBI"; OFFRATE=4; EXAMPLE="mockITS"
  ncbi_taxonomy
  for m in ITS 18SrRNA 28SrRNA; do
    for e in fna gbff; do fetch "$NCBI/refseq/TargetedLoci/Fungi/fungi.$m.$e.gz" "fungi.$m.$e.gz"; done
  done
  zcat fungi.ITS.fna.gz fungi.18SrRNA.fna.gz fungi.28SrRNA.fna.gz > ref.fna
  zcat fungi.ITS.gbff.gz fungi.18SrRNA.gbff.gz fungi.28SrRNA.gbff.gz | gbff_taxids > seqid2taxid.raw.map
  remap_merged seqid2taxid.raw.map
}

recipe_gtdb_ssu() {
  TITLE="GTDB R232 16S rRNA of species representatives"
  DESC="16S rRNA genes of GTDB R232 species-representative genomes (Bacteria + Archaea) with GTDB taxonomy, unfiltered. Some representative genomes carry contaminating 16S genes and GTDB splits many genera (e.g. Enterococcus, Enterococcus_C), so expect more reads to stop above genus than with RefSeq 16S."
  TAXONOMY="GTDB R232"; OFFRATE=5; EXAMPLE="mock16s"
  fetch "$GTDB/genomic_files_reps/bac120_ssu_reps_r232.fna.gz" bac120_ssu_reps.fna.gz
  fetch "$GTDB/genomic_files_reps/ar53_ssu_reps_r232.fna.gz" ar53_ssu_reps.fna.gz
  fetch "$GTDB/bac120_metadata_r232.tsv.gz" bac120_metadata.tsv.gz
  fetch "$GTDB/ar53_metadata_r232.tsv.gz" ar53_metadata.tsv.gz
  # Taxonomy from the upstream script (indices/gtdb-create-dmp.pl), as in the
  # Centrifuger GTDB tutorial. It maps genome file paths to taxIDs; the SSU
  # sequences are named by genome accession with an RS_/GB_ prefix.
  (zcat bac120_metadata.tsv.gz; zcat ar53_metadata.tsv.gz | tail -n +2) > metadata.tsv
  perl "$WA_DIR/centrifuger-src/indices/gtdb-create-dmp.pl" -m metadata.tsv -d . -o gtdb
  rm -f metadata.tsv gtdb_file.list
  mv gtdb_nodes.dmp nodes.dmp
  mv gtdb_names.dmp names.dmp
  awk -F'\t' '{ n = split($1, a, "/"); acc = a[n]; sub(/_genomic\.fna\.gz$/, "", acc); print acc "\t" $2 }' \
    gtdb_fname_to_taxid.map > acc2taxid.tsv
  zcat bac120_ssu_reps.fna.gz ar53_ssu_reps.fna.gz | awk '/^>/ { print $1; next } { print }' > ref.fna
  grep '^>' ref.fna | cut -c2- | awk -F'\t' 'NR == FNR { m[$1] = $2; next } (substr($1, 4) in m) { print $1 "\t" m[substr($1, 4)] }' \
    acc2taxid.tsv - > seqid2taxid.map
}

recipe_silva_ssu() {
  TITLE="SILVA ${SILVA_VER} SSU Ref NR99"
  DESC="SILVA ${SILVA_VER} small-subunit rRNA (16S/18S) non-redundant reference with SILVA taxonomy (resolves to genus). For 16S/18S amplicon reads across all domains."
  TAXONOMY="SILVA ${SILVA_VER}"; OFFRATE=5; EXAMPLE="mock16s"
  fetch "$SILVA/taxonomy/tax_slv_ssu_${SILVA_VER}.txt.gz" tax_slv_ssu.txt.gz
  fetch "$SILVA/taxonomy/tax_slv_ssu_${SILVA_VER}.acc_taxid.gz" tax_slv_ssu.acc_taxid.gz
  fetch "$SILVA/SILVA_${SILVA_VER}_SSURef_NR99_tax_silva.fasta.gz" silva_nr99.fasta.gz
  # tax_slv_ssu: "Bacteria;Pseudomonadota;<tab>taxid<tab>rank..." -- link each
  # node to its parent by full path (names such as "uncultured" repeat).
  zcat tax_slv_ssu.txt.gz | awk -F'\t' -v nodes=nodes.dmp -v names=names.dmp '
    BEGIN { print "1\t|\t1\t|\tno rank\t|" > nodes; print "1\t|\troot\t|\t\t|\tscientific name\t|" > names }
    { path[NR] = $1; id[NR] = $2; rk[NR] = $3; byPath[$1] = $2 }
    END {
      for (i = 1; i <= NR; i++) {
        p = path[i]; sub(/;$/, "", p)
        nm = p; sub(/.*;/, "", nm)
        par = p; if (sub(/;[^;]*$/, "", par)) par = par ";"; else par = ""
        parent = (par in byPath) ? byPath[par] : 1
        print id[i] "\t|\t" parent "\t|\t" rk[i] "\t|" > nodes
        print id[i] "\t|\t" nm "\t|\t\t|\tscientific name\t|" > names
      }
    }'
  zcat tax_slv_ssu.acc_taxid.gz > seqid2taxid.map
  # RNA -> DNA alphabet, keep only the sequence ID in headers
  zcat silva_nr99.fasta.gz | awk '/^>/ { print $1; next } { gsub(/U/, "T"); gsub(/u/, "t"); print }' > ref.fna
}

recipe_refseq_viral() {
  TITLE="NCBI RefSeq viral genomes (excluding phages)"
  DESC="RefSeq viral genomes with NCBI taxonomy, excluding bacteriophages (Caudoviricetes and sequences named phage). For shotgun reads from eukaryotic viruses."
  TAXONOMY="NCBI"; OFFRATE=5; EXAMPLE="mockViral"
  ncbi_taxonomy
  fetch "$NCBI/refseq/release/viral/viral.1.1.genomic.fna.gz" viral.fna.gz
  fetch "$NCBI/refseq/release/viral/viral.1.genomic.gbff.gz" viral.gbff.gz
  zcat viral.gbff.gz | gbff_taxids > seqid2taxid.raw.map
  remap_merged seqid2taxid.raw.map
  # Taxa under Caudoviricetes (2731619)
  awk -F'\t' '{ parent[$1] = $3 } END {
      for (t in parent) { x = t; for (k = 0; k < 64 && x != 1; k++) { if (x == 2731619) { print t; break } x = parent[x] } } }' \
    nodes.dmp > phage_taxids.txt
  awk -F'\t' 'NR == FNR { ph[$1] = 1; next } !($2 in ph)' phage_taxids.txt seqid2taxid.map > keep.map
  zcat viral.fna.gz | awk 'NR == FNR { keep[$1] = 1; next }
    /^>/ { id = substr($1, 2); ok = (id in keep) && tolower($0) !~ /phage/ }
    ok' keep.map - > ref.fna
  grep '^>' ref.fna | cut -c2- | cut -d' ' -f1 | awk 'NR == FNR { k[$1] = 1; next } ($1 in k)' - keep.map > seqid2taxid.map
}

# Protein indices: ref.fna holds amino-acid sequences and BUILD_OPTS=--protein.
recipe_refseq_viral_prot() {
  TITLE="NCBI RefSeq viral proteins (including phages)"
  DESC="All RefSeq viral proteins with NCBI taxonomy, bacteriophages included. Reads are translated and matched at the protein level, which finds viruses too divergent for nucleotide matching. Large: plan for about 1 GB of browser memory."
  TAXONOMY="NCBI"; OFFRATE=5; EXAMPLE="mockVirome"; BUILD_OPTS="--protein"
  ncbi_taxonomy
  fetch "$NCBI/refseq/release/viral/viral.1.protein.faa.gz" viral.protein.faa.gz
  fetch "$NCBI/refseq/release/viral/viral.1.protein.gpff.gz" viral.protein.gpff.gz
  zcat viral.protein.faa.gz > ref.fna
  zcat viral.protein.gpff.gz | gbff_taxids > seqid2taxid.raw.map
  remap_merged seqid2taxid.raw.map
}

recipe_swissprot() {
  TITLE="UniProtKB/Swiss-Prot (all domains, protein)"
  DESC="Curated Swiss-Prot proteins from all domains of life, with NCBI taxonomy. Reads are translated and matched at the protein level. Broad but sparse (mostly well-studied organisms), so calls below phylum or family are reliable only for well-studied taxa. Large: plan for about 1 GB of browser memory."
  TAXONOMY="NCBI"; OFFRATE=5; EXAMPLE="mockSwiss"; BUILD_OPTS="--protein"
  ncbi_taxonomy
  fetch "$UNIPROT/uniprot_sprot.fasta.gz" uniprot_sprot.fasta.gz
  zcat uniprot_sprot.fasta.gz > ref.fna
  # taxID from OX= in each header, keyed by the first header token (sp|ACC|NAME)
  awk '/^>/ { if (match($0, / OX=[0-9]+/)) print substr($1, 2) "\t" substr($0, RSTART + 4, RLENGTH - 4) }' \
    ref.fna > seqid2taxid.raw.map
  remap_merged seqid2taxid.raw.map
}

# ---------- build and install ----------

# INDEX_BUILD_DIR / SITE_DIR override the work and install locations (for experiments).
SITE_DIR=${SITE_DIR:-$WA_DIR/site}
WORK="${INDEX_BUILD_DIR:-$WA_DIR/index_build}/$NAME"
OUT="$SITE_DIR/index/$NAME"
mkdir -p "$WORK"
cd "$WORK"
type "recipe_$NAME" >/dev/null 2>&1 || { echo "Unknown index: $NAME" >&2; exit 1; }
BUILD_OPTS=""
"recipe_$NAME"
PROTEIN=$([ "$BUILD_OPTS" = "--protein" ] && echo true || echo false)

nseq=$(grep -c '^>' ref.fna)
nmap=$(wc -l < seqid2taxid.map)
bp=$(awk '!/^>/ { n += length($0) } END { print n }' ref.fna)
echo "[$NAME] sequences: $nseq, mapped: $nmap, residues: $bp"

"$BUILD" $BUILD_OPTS -r ref.fna --taxonomy-tree nodes.dmp --name-table names.dmp \
  --conversion-table seqid2taxid.map -o "$NAME" -t "$THREADS" --offrate "$OFFRATE"

rm -rf "$OUT"
mkdir -p "$OUT"
files_json=""
for i in 1 2 3 4; do
  cp "$NAME.$i.cfr" "$OUT/"
  size=$(stat -c %s "$NAME.$i.cfr")
  sha=$(sha256sum "$NAME.$i.cfr" | cut -d' ' -f1)
  files_json="$files_json${files_json:+,}
    {\"name\": \"$NAME.$i.cfr\", \"size\": $size, \"sha256\": \"$sha\"}"
done
version=$(awk '$1 == "version" { print $2 }' "$NAME.4.cfr")
cat > "$OUT/manifest.json" <<JSON
{
  "name": "$NAME",
  "title": "$TITLE",
  "description": "$DESC",
  "taxonomy": "$TAXONOMY",
  "sequences": $nseq,
  "bases": $bp,
  "offrate": $OFFRATE,
  "protein": $PROTEIN,
  "example": "$EXAMPLE",
  "centrifugerVersion": "$version",
  "built": "$(date -u +%Y-%m-%d)",
  "files": [$files_json
  ]
}
JSON
ls -la "$OUT"

python3 -I "$WA_DIR/scripts/make_catalog.py" "$SITE_DIR"
