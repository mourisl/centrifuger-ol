#!/usr/bin/env python3
"""Write site/index/indices.json from the per-index manifests in site/index/*/.

Usage: make_catalog.py <site_dir>
"""
import json
import os
import sys

ORDER = ["refseq16s", "gtdb_ssu", "silva_ssu", "refseq_fungi", "refseq_viral", "refseq_viral_prot", "swissprot"]
# Rank shown first in the results (SILVA taxonomy stops at genus)
DEFAULT_RANK = {"refseq_viral": "species", "refseq_viral_prot": "species"}
EXAMPLES = {
    "mock16s": {"url": "example/mock16s.fq.gz",
                "label": "5,000 simulated 150 bp 16S reads from a 9-species mock community"},
    "mockITS": {"url": "example/mockITS.fq.gz",
                "label": "5,000 simulated 150 bp ITS reads from an 8-species fungal mock community"},
    "mockViral": {"url": "example/mockViral.fq.gz",
                  "label": "5,000 simulated 150 bp shotgun reads from 8 human viruses"},
    "mockVirome": {"url": "example/mockVirome.fq.gz",
                   "label": "5,000 simulated 150 bp shotgun reads from 8 human viruses and 3 bacteriophages"},
    "mockSwiss": {"url": "example/mockSwiss.fq.gz",
                  "label": "5,000 simulated 150 bp shotgun reads from 6 bacterial genomes and yeast"},
}


def main():
    site = sys.argv[1]
    idx_dir = os.path.join(site, "index")
    entries = []
    for name in sorted(os.listdir(idx_dir)):
        path = os.path.join(idx_dir, name, "manifest.json")
        if not os.path.isfile(path):
            continue
        with open(path) as fp:
            m = json.load(fp)
        entries.append({
            "name": m["name"],
            "title": m["title"],
            "description": m["description"],
            "taxonomy": m.get("taxonomy", ""),
            "sequences": m["sequences"],
            "bases": m.get("bases"),
            "protein": m.get("protein", False),
            "size": sum(f["size"] for f in m["files"]),
            "files": [{"name": f["name"], "size": f["size"]} for f in m["files"]],
            "built": m["built"],
            "centrifugerVersion": m["centrifugerVersion"],
            "example": EXAMPLES.get(m.get("example")),
            "defaultRank": DEFAULT_RANK.get(m["name"], "genus"),
        })
    entries.sort(key=lambda e: ORDER.index(e["name"]) if e["name"] in ORDER else len(ORDER))
    names = [e["name"] for e in entries]
    catalog = {"default": "refseq16s" if "refseq16s" in names else (names[0] if names else None),
               "indices": entries}
    with open(os.path.join(idx_dir, "indices.json"), "w") as fp:
        json.dump(catalog, fp, indent=2)
        fp.write("\n")
    print("indices.json:", ", ".join(names))


if __name__ == "__main__":
    main()
