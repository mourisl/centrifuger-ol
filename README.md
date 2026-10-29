# Centrifuger Web

A static website that runs [Centrifuger](https://github.com/mourisl/centrifuger)
in the browser via WebAssembly. Users choose a prebuilt index, pick FASTQ/FASTA
files (plain or gzipped, single- or paired-end), and get per-read classification
plus a quantification report (Centrifuger, MetaPhlAn, CAMI-II or Kraken2-style).
Reads never leave the user's computer. Indices are downloaded on first use and
cached by the browser.

| Index (`site/index/<name>/`) | Source | Taxonomy | Example reads |
|---|---|---|---|
| `refseq16s` | NCBI RefSeq Targeted Loci 16S (Bacteria + Archaea) | NCBI | `mock16s` |
| `gtdb_ssu` | GTDB R232 16S of species representatives, unfiltered | GTDB (upstream `gtdb-create-dmp.pl`) | `mock16s` |
| `silva_ssu` | SILVA 138.2 SSU Ref NR99 | SILVA (to genus) | `mock16s` |
| `refseq_fungi` | NCBI RefSeq Targeted Loci fungal ITS + 18S + 28S | NCBI | `mockITS` |
| `refseq_viral` | NCBI RefSeq viral genomes, excluding phages | NCBI | `mockViral` |
| `refseq_viral_prot` | NCBI RefSeq viral proteins, including phages (protein) | NCBI | `mockVirome` |
| `swissprot` | UniProtKB/Swiss-Prot, all domains (protein) | NCBI (`OX=` taxIDs) | `mockSwiss` |

The two protein indices are built with `centrifuger-build --protein`. Reads are
still nucleotide; Centrifuger translates them and matches at the amino-acid
level.
- **Strength:** finds viruses that are too divergent for nucleotide matching.
  With the mock species held out of the index, the viral protein index placed
  about 3× more reads in the right genus than the viral genome index.
- **Cost:** translation makes it slower, about 11–15 s per 100k reads in the
  browser versus about 5 s for nucleotide indices.
- **Size:** 200–230 MB to download. They peak around 0.6 GB of browser
  memory.
- **Swiss-Prot is sparse:** it is reliable for well-studied organisms only.
  Many reads from poorly studied taxa stay unclassified.

The page downloads only the selected index, when a run starts.

## How it works

- `centrifuger-src/` is a checkout of upstream GitHub master at commit
  `cb74063` (v1.2.0-r367), made by `make`. This version adds dust masking of
  low-complexity regions to `centrifuger-build`, which is on by default, so the
  prebuilt indices are dust-masked. The source is compiled **without
  modification**, and the local development tree is deliberately not used.
  - To use another tag, branch or commit, set `CFR_REF` in the Makefile, then
    rebuild the binaries and the indices. `make` stops if `centrifuger-src/`
    is checked out at a different commit.
- The build targets **wasm64** (`-m64`). Centrifuger writes `size_t` fields
  straight into the index and uses `%lu` for 64-bit values. wasm64 keeps both
  identical to 64-bit Linux, so indexes built by the native `centrifuger-build`
  load as they are.
  - Browser requirement: Chrome/Edge 133+ or Firefox 134+. The page checks for
    support and says so if it is missing.
- `shim/cfr_wasm_shim.h` is force-included and turns `pthread_create`/`join`/
  `exit` into synchronous calls (always run with `-t 1`).
  - Result: single-threaded, no SharedArrayBuffer and no COOP/COEP headers, so
    any static host works.
- `src/wasm_main.cpp` wraps upstream `main()` and adds `--wasm-stdout <path>`,
  which sends results to a file in the in-memory filesystem.
- `site/worker.js` runs everything in a Web Worker:
  1. Downloads the index's four `.cfr` files, one at a time, so the computer
     stays responsive, and stores them in the Cache API.
  2. Mounts the user's files with WORKERFS, so they are not copied into memory.
  3. Runs `centrifuger`. Its per-read output is gzip-compressed as it is
     written, using zlib inside the module (`src/wasm_gzip.c`,
     `site/output.js`, level 6, about 7× smaller). The compressed output
     streams to a file in the browser's origin private file system (OPFS, on
     disk), so memory use does not grow with the number of reads. The download
     is `<sample>.centrifuger.tsv.gz`. Each tab keeps only its latest result
     and tries to delete it when the page closes. Each tab also holds a Web Lock
     on its file, which the browser releases when the tab goes away. Files
     whose lock is free (closed or crashed tabs) are deleted the next time the
     page loads. Where OPFS is unavailable (some private-browsing modes),
     the output is kept in memory instead.
  4. Runs `centrifuger-quant` once per report format (Centrifuger, MetaPhlAn,
     CAMI-II, Kraken2-style), reading the gzipped classification file from
     disk.

## Results view

- **Summary:** read counts, the classified fraction and the run time.
- **Bar chart and table:** filtered by rank and by a name search.
- **Taxonomic flow:** a Sankey diagram from domain to species
  (`site/sankey.js`, no external libraries).
  - The tree comes from the Kraken-style report, and the values come from the
    Centrifuger table (read share or abundance).
  - A band that stops early carries reads not resolved to a lower rank.
  - The top N taxa per rank are kept (5–20, chosen on the page). The rest are
    merged into "Other".
  - Flows are colored by phylum.

## Layout

```
Makefile                    wasm + native builds (clones the pinned upstream tag)
shim/ src/                  pthread shim, main() wrapper, gzip helper for the classification output
scripts/env.sh              puts ./emsdk on PATH (works around old system Python)
scripts/install_emsdk.sh    installs the pinned emsdk into ./emsdk
scripts/build_index.sh      downloads sources, builds one index (or all) into site/index/<name>/
scripts/make_catalog.py     writes site/index/indices.json from the manifests
scripts/publish_indices.sh  uploads the index .cfr files to a GitHub release, records it in the manifests
scripts/index_parts.py      lists, verifies and fetches the index .cfr files (used by the Pages workflow)
scripts/measure_protein_indices.sh  one-off size measurement of candidate protein indices
test/node_parity.mjs        wasm vs native byte-for-byte comparison
test/browser_e2e.py         headless Firefox end-to-end test (selenium)
test/simulate_reads.py      makes the example reads in site/example/ (--preset mock16s|mockITS|mockViral|mockVirome|mockSwiss)
test/eval_mock.py           accuracy of a mock classification (--rank genus|family|phylum)
site/                       the deployable static site (sankey.js: taxonomic flow diagram;
                            output.js: output device + gzip stage)
.github/workflows/pages.yml CI build + GitHub Pages deploy
```

## Build

```bash
bash scripts/install_emsdk.sh        # once
source scripts/env.sh
make wasm native                     # site/wasm/*, build/native/*
bash scripts/build_index.sh all 4    # all indices (SILVA takes longest; downloads ≈1.5 GB)
bash scripts/build_index.sh refseq16s 4   # or one index
python3 test/simulate_reads.py --preset mock16s index_build/refseq16s/ref.fna site/example/mock16s.fq.gz
# mockVirome samples viral.fna (zcat index_build/refseq_viral/viral.fna.gz, which still contains phages);
# mockSwiss samples genomes fetched from NCBI efetch (accessions in the preset)
```

## Test

```bash
node test/node_parity.mjs            # every index on its example reads: wasm output == native output
pip install selenium
python3 test/browser_e2e.py          # E2E_SINGLE_PROCESS=1 on HPC nodes
python3 -m http.server -d site 8000  # manual check at http://localhost:8000
```

## Deploy

`site/` is fully static and hosted on **GitHub Pages**. Each index is served as
its four plain `<name>.<i>.cfr` files, without splitting or compression.
- The page links to them, so users can download an index and run native
  `centrifuger -x <folder>/<name>`.
- Indices total about 760 MB of the 1 GB Pages limit; the workflow fails if
  `site/` exceeds 1 GB. Keep new indices small.

- Push this directory as a repository root (branch `master`), then set
  Settings → Pages → Source to "GitHub Actions".
- The workflow builds the wasm, fetches the index files (see below), runs the
  parity test and deploys.

### Index files live in GitHub releases, not in git

The `.cfr` files (`site/index/<name>/*.cfr`) are ignored by git.
- They are stored as assets of GitHub releases, as one flat list of 28 files.
- Each index's `manifest.json` (tracked) lists its files with sizes and sha256,
  and records the release that holds them (`"release"`).
- At deploy time the workflow runs `python3 scripts/index_parts.py fetch site`,
  which downloads the files and checks them against the manifests.

Code releases and ordinary pushes need no index assets. `git push` cannot
upload release assets, since releases aren't part of git, so after rebuilding
an index, publish its files in one of two ways:

- **On GitHub's web page (no tools):**
  1. Releases → "Draft a new release". Create a tag such as
     `indices-2026-10-28` and tick "pre-release".
  2. Drag in the files printed by `python3 scripts/index_parts.py list site
     swissprot` (omit the name to list every index).
  3. Run `python3 scripts/index_parts.py set-release site indices-2026-10-28
     swissprot`, which writes the tag into the manifest.
- **With the GitHub CLI:** `bash scripts/publish_indices.sh swissprot` does all
  three steps (default tag `indices-<today>`).

Then commit `site/index` (the manifests) and push. Indices you didn't rebuild
keep pointing at their earlier release.

To deploy, the workflow downloads each file from
`https://github.com/<owner>/<repo>/releases/download/<tag>/<file>`. That needs
no extra tools for a public repository; a private one falls back to `gh`. On a
fresh clone, `python3 scripts/index_parts.py fetch site` gets the files locally
the same way.

No special headers are needed, so other static hosts work too, as long as
they accept files of up to about 200 MB (Cloudflare Pages, limited to 25 MiB
per file, does not).

To add an index, add a `recipe_<name>` function to `scripts/build_index.sh`.
It installs the four `.cfr` files plus a `manifest.json`, and refreshes
`indices.json`, so the new index appears in the page's selector.
