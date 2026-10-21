#!/usr/bin/env python3
"""Index parts (site/index/<name>/*.part*) are not tracked by git. They are
stored as assets of GitHub releases; each manifest.json names its release
("release"), and the Pages workflow fetches the parts at deploy time.

Usage:
  index_parts.py list   <site> [names...]   print the part paths (for uploading)
  index_parts.py verify <site> [names...]   check parts against the manifests
  index_parts.py fetch  <site> [names...]   download missing parts, then verify
  index_parts.py set-release <site> <tag> [names...]   record the release tag

fetch downloads https://github.com/<owner>/<repo>/releases/download/<tag>/<part>
(public repository; no tools needed). The repository comes from INDEX_REPO,
GITHUB_REPOSITORY (set in Actions) or `git remote get-url origin`. For a private
repository it falls back to `gh release download` (needs GH_TOKEN in CI). Set
LOCAL_ASSET_DIR to copy parts from a local folder instead.
"""
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request


def manifests(site, names):
    paths = sorted(glob.glob(os.path.join(site, "index", "*", "manifest.json")))
    out = []
    for p in paths:
        with open(p) as fp:
            m = json.load(fp)
        if not names or m["name"] in names:
            out.append((p, m))
    missing = set(names) - {m["name"] for _, m in out}
    if missing:
        sys.exit("no manifest for: " + ", ".join(sorted(missing)))
    return out


def parts(path, m):
    d = os.path.dirname(path)
    return [(f, [os.path.join(d, p) for p in f["parts"]]) for f in m["files"]]


def problems(path, m):
    errs = []
    for f, ps in parts(path, m):
        absent = [p for p in ps if not os.path.isfile(p)]
        if absent:
            errs.append("%s: missing %s" % (f["name"], ", ".join(os.path.basename(p) for p in absent)))
            continue
        h = hashlib.sha256()
        size = 0
        for p in ps:
            with open(p, "rb") as fp:
                for block in iter(lambda: fp.read(1 << 20), b""):
                    h.update(block)
                    size += len(block)
        if size != f["gzSize"] or h.hexdigest() != f["sha256"]:
            errs.append("%s: size or sha256 differs from manifest" % f["name"])
    return errs


def verify(items):
    bad = 0
    for path, m in items:
        errs = problems(path, m)
        print("%-20s %s" % (m["name"], "ok" if not errs else "; ".join(errs)))
        bad += bool(errs)
    if bad:
        sys.exit("%d index(es) failed verification" % bad)


def github_repo():
    repo = os.environ.get("INDEX_REPO") or os.environ.get("GITHUB_REPOSITORY")
    if repo:
        return repo
    try:
        url = subprocess.run(["git", "remote", "get-url", "origin"], stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, universal_newlines=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        url = ""
    m = re.search(r"github\.com[:/](.+?/.+?)(\.git)?$", url)
    if not m:
        sys.exit("cannot tell the GitHub repository; set INDEX_REPO=<owner>/<repo>")
    return m.group(1)


def download(url, dest):
    tmp = dest + ".download"
    with urllib.request.urlopen(url, timeout=120) as r, open(tmp, "wb") as fp:
        shutil.copyfileobj(r, fp, 1 << 20)
    os.replace(tmp, dest)


def fetch_release(m, path, tag, repo):
    """Download the parts of one index from its release (gh only as a fallback)."""
    base = "https://github.com/%s/releases/download/%s/" % (repo, tag)
    try:
        for f, ps in parts(path, m):
            for p in ps:
                download(base + os.path.basename(p), p)
        return
    except urllib.error.HTTPError as e:
        if e.code != 404:
            sys.exit("%s: download failed (%s) from %s" % (m["name"], e, base))
        if not shutil.which("gh"):
            sys.exit("%s: %s not found in release %s of %s (missing asset, or a private repository; "
                     "install gh for private ones)" % (m["name"], e.url.rsplit("/", 1)[-1], tag, repo))
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["gh", "release", "download", tag, "--repo", repo, "--dir", tmp,
                        "--pattern", m["name"] + ".*.part*"], check=True)
        for f, ps in parts(path, m):
            for p in ps:
                asset = os.path.join(tmp, os.path.basename(p))
                if not os.path.isfile(asset):
                    sys.exit("%s: release %s has no asset %s" % (m["name"], tag, os.path.basename(p)))
                shutil.copyfile(asset, p)


def fetch(items):
    local = os.environ.get("LOCAL_ASSET_DIR")
    repo = None if local else github_repo()
    for path, m in items:
        if not problems(path, m):
            print("%-20s present" % m["name"])
            continue
        tag = m.get("release")
        if local:
            for f, ps in parts(path, m):
                for p in ps:
                    asset = os.path.join(local, os.path.basename(p))
                    if not os.path.isfile(asset):
                        sys.exit("%s: %s has no asset %s" % (m["name"], local, os.path.basename(p)))
                    shutil.copyfile(asset, p)
            continue
        if not tag:
            sys.exit("%s: manifest has no \"release\"; publish its parts first (see README)" % m["name"])
        print("%-20s downloading from release %s of %s" % (m["name"], tag, repo), flush=True)
        fetch_release(m, path, tag, repo)
    verify(items)


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    cmd, site = sys.argv[1], sys.argv[2]
    if cmd == "set-release":
        tag, names = sys.argv[3], sys.argv[4:]
        for path, m in manifests(site, names):
            m["release"] = tag
            with open(path, "w") as fp:
                json.dump(m, fp, indent=2)
                fp.write("\n")
            print("%-20s release %s" % (m["name"], tag))
        return
    items = manifests(site, sys.argv[3:])
    if cmd == "list":
        for path, m in items:
            for _, ps in parts(path, m):
                print("\n".join(ps))
    elif cmd == "verify":
        verify(items)
    elif cmd == "fetch":
        fetch(items)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
