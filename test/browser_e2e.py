#!/usr/bin/env python3
"""End-to-end test of the website in headless Firefox (needs memory64: Firefox 134+).

Serves site/ locally, runs the example dataset and a paired-end upload, and
checks that results appear. Requires `pip install selenium`.
Usage: browser_e2e.py [screenshot_dir]
"""
import functools
import http.server
import json
import os
import subprocess
import sys
import threading
import time

from selenium import webdriver
from selenium.common.exceptions import TimeoutException
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import Select, WebDriverWait

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
SITE = os.environ.get("E2E_SITE", os.path.join(ROOT, "site"))
SHOTS = sys.argv[1] if len(sys.argv) > 1 else None
NATIVE = os.path.join(ROOT, "build", "native", "centrifuger")
NATIVE_INDEX = os.path.join(ROOT, "index_build", "refseq16s", "refseq16s")

# Lists the result files in OPFS and reads the newest one (gzip-compressed).
READ_OPFS = """
const done = arguments[arguments.length - 1];
(async () => {
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('centrifuger-results');
  const names = [];
  for await (const n of dir.keys()) names.push(n);
  names.sort();
  const f = await (await dir.getFileHandle(names[names.length - 1])).getFile();
  const head = new Uint8Array(await f.slice(0, 2).arrayBuffer());
  const text = await new Response(f.stream().pipeThrough(new DecompressionStream('gzip'))).text();
  return { files: names.length, names, gzip: head[0] === 0x1f && head[1] === 0x8b, size: f.size, text };
})().then(done, (e) => done({ error: String(e) }));
"""

# Creates an unlocked result file, as left by a tab that crashed.
PLANT_STALE = """
const done = arguments[arguments.length - 1];
navigator.storage.getDirectory()
  .then((root) => root.getDirectoryHandle('centrifuger-results', { create: true }))
  .then((dir) => dir.getFileHandle('class-stale.tsv', { create: true }))
  .then(() => done(true), (e) => done(String(e)));
"""


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".wasm": "application/wasm", ".js": "text/javascript", ".mjs": "text/javascript"}

    def log_message(self, *args):
        pass

    def end_headers(self):
        # E2E_GZIP_ENCODING=1 imitates hosts that serve .gz files with
        # Content-Encoding: gzip, so the browser hands over decoded bytes.
        if os.environ.get("E2E_GZIP_ENCODING") and self.path.split("?")[0].endswith(".cfr.gz"):
            self.send_header("Content-Encoding", "gzip")
        super().end_headers()


def runs_done(driver):
    return driver.find_element(By.ID, "log").get_attribute("textContent").count("\nDone: ")


def wait_done(driver, before, timeout=300):
    try:
        WebDriverWait(driver, timeout).until(
            lambda d: runs_done(d) > before or d.find_element(By.ID, "error").is_displayed())
    except TimeoutException:
        raise RuntimeError("timed out; log:\n" + driver.find_element(By.ID, "log").get_attribute("textContent")) from None
    err = driver.find_element(By.ID, "error")
    if err.is_displayed():
        raise RuntimeError("page error: " + err.text + "\nlog:\n" + driver.find_element(By.ID, "log").get_attribute("textContent"))


def main():
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=SITE))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = "http://127.0.0.1:%d/" % httpd.server_address[1]

    opts = webdriver.FirefoxOptions()
    opts.add_argument("-headless")
    opts.add_argument("--width=1200")
    opts.add_argument("--height=1800")
    if os.environ.get("E2E_SINGLE_PROCESS"):
        # For locked-down hosts (e.g. HPC nodes) where Firefox cannot spawn content processes.
        for k, v in [("security.sandbox.content.level", 0), ("fission.autostart", False),
                     ("browser.tabs.remote.autostart", False)]:
            opts.set_preference(k, v)
    driver = webdriver.Firefox(options=opts)
    try:
        driver.get(url)
        assert not driver.find_element(By.ID, "unsupported").is_displayed(), "memory64 not supported"

        # 1. Example dataset (single-end, gzipped 16S mock community)
        t0 = time.time()
        WebDriverWait(driver, 30).until(EC.element_to_be_clickable((By.ID, "example"))).click()
        wait_done(driver, 0)
        reads = driver.find_element(By.ID, "st-reads").text
        classified = driver.find_element(By.ID, "st-class").text
        rows = driver.find_elements(By.CSS_SELECTOR, "#table tbody tr")
        top = [r.find_elements(By.TAG_NAME, "td")[0].text for r in rows[:9]]
        print("example: reads=%s classified=%s genera=%d (%.1fs)" % (reads, classified, len(rows), time.time() - t0))
        print("  top genera:", ", ".join(top))
        assert reads == "5,000", reads
        expected = {"Pseudomonas", "Escherichia", "Salmonella", "Staphylococcus", "Enterococcus",
                    "Listeria", "Bacillus", "Limosilactobacillus", "Methanobrevibacter"}
        missing = expected - set(top)
        assert not missing, "missing genera in top 9: %s" % missing
        ranks = [t.text for t in driver.find_elements(By.CSS_SELECTOR, "#sankey .sk-rank")]
        sk_nodes = len(driver.find_elements(By.CSS_SELECTOR, "#sankey .sk-node"))
        print("sankey: %d nodes, columns %s" % (sk_nodes, ", ".join(ranks)))
        assert ranks == ["Domain", "Phylum", "Class", "Order", "Family", "Genus", "Species"], ranks
        assert sk_nodes > 20 and driver.find_elements(By.CSS_SELECTOR, "#sankey .sk-link")
        if SHOTS:
            driver.save_screenshot(os.path.join(SHOTS, "example.png"))

        # 2. Paired-end upload through the file inputs (index now cached in-worker)
        driver.find_element(By.XPATH, '//input[@value="paired"]/parent::label').click()
        ex = os.path.join(ROOT, "centrifuger-src", "example")
        driver.find_element(By.ID, "file1").send_keys(os.path.join(ex, "example_1.fq"))
        driver.find_element(By.ID, "file2").send_keys(os.path.join(ex, "example_2.fq"))
        WebDriverWait(driver, 10).until(EC.element_to_be_clickable((By.ID, "run"))).click()
        wait_done(driver, 1)
        print("paired: reads=%s classified=%s" % (driver.find_element(By.ID, "st-reads").text,
                                                  driver.find_element(By.ID, "st-class").text))
        assert driver.find_element(By.ID, "st-reads").text == "100"
        log_text = driver.find_element(By.ID, "log").get_attribute("textContent")
        assert "Writing the classification to browser disk storage (OPFS)." in log_text, "OPFS not used"
        opfs = driver.execute_async_script(READ_OPFS)
        assert "error" not in opfs, opfs
        assert opfs["gzip"], "OPFS classification file is not gzip-compressed"
        assert opfs["files"] == 1, "old result files were not removed: %d" % opfs["files"]
        if os.path.exists(NATIVE) and os.path.exists(NATIVE_INDEX + ".1.cfr"):
            native = subprocess.run([NATIVE, "-x", NATIVE_INDEX, "-t", "1", "-1", os.path.join(ex, "example_1.fq"),
                                     "-2", os.path.join(ex, "example_2.fq")], capture_output=True, text=True, check=True).stdout
            assert opfs["text"] == native, "OPFS classification differs from native output"
            print("paired: OPFS classification file (gzip, %d bytes) matches native (%d lines)" % (opfs["size"], native.count("\n")))
        else:
            print("paired: OPFS classification file has %d lines (native comparison skipped)" % opfs["text"].count("\n"))
        print("log tail:\n  " + "\n  ".join(driver.find_element(By.ID, "log").get_attribute("textContent").strip().split("\n")[-3:]))
        if SHOTS:
            driver.save_screenshot(os.path.join(SHOTS, "paired.png"))

        # Loading the page in a second tab removes files of tabs that are gone,
        # but keeps the result of the tab that is still open.
        first_tab = driver.current_window_handle
        driver.switch_to.new_window("tab")
        driver.get(url)
        assert driver.execute_async_script(PLANT_STALE) is True
        driver.get(url)
        WebDriverWait(driver, 30).until(EC.element_to_be_clickable((By.ID, "example")))
        time.sleep(2)  # let the new worker's startup sweep finish
        names = driver.execute_async_script(READ_OPFS)["names"]
        driver.close()
        driver.switch_to.window(first_tab)
        assert names == opfs["names"], "expected only the open tab's result, got %s" % names
        print("second tab: stale file removed, open tab's result kept")

        # 3. Reload: the index must now come from the browser cache, and the
        # result file of the page that was left must be gone.
        driver.get(url)
        WebDriverWait(driver, 30).until(EC.element_to_be_clickable((By.ID, "example"))).click()
        wait_done(driver, 0)
        status = driver.find_element(By.ID, "index-status").text
        print("reload: index status=%r reads=%s" % (status, driver.find_element(By.ID, "st-reads").text))
        assert status == "Ready (cached)", status
        names = driver.execute_async_script(READ_OPFS)["names"]
        assert len(names) == 1 and names != opfs["names"], "old result file not removed: %s" % names
        print("reload: previous result file removed; OPFS holds %s" % names[0])
        assert driver.find_element(By.ID, "st-reads").text == "5,000"
        # 4. Every other index in the catalog, with its own example reads
        with open(os.path.join(SITE, "index", "indices.json")) as fp:
            catalog = json.load(fp)
        wanted = os.environ.get("E2E_INDICES", "").split(",") if os.environ.get("E2E_INDICES") else None
        for ix in catalog["indices"]:
            if ix["name"] == catalog["default"] or not ix.get("example"):
                continue
            if wanted and ix["name"] not in wanted:
                continue
            before = runs_done(driver)
            Select(driver.find_element(By.ID, "index-select")).select_by_value(ix["name"])
            t0 = time.time()
            WebDriverWait(driver, 30).until(EC.element_to_be_clickable((By.ID, "example"))).click()
            wait_done(driver, before, timeout=900)
            rows = driver.find_elements(By.CSS_SELECTOR, "#table tbody tr")
            top = [r.find_elements(By.TAG_NAME, "td")[0].text for r in rows[:5]]
            print("%s: reads=%s classified=%s rank=%s (%.1fs) top: %s" % (
                ix["name"], driver.find_element(By.ID, "st-reads").text, driver.find_element(By.ID, "st-class").text,
                Select(driver.find_element(By.ID, "rank")).first_selected_option.text, time.time() - t0, ", ".join(top)))
            assert driver.find_element(By.ID, "st-reads").text == "5,000"
            assert rows, "no result rows for " + ix["name"]
            assert driver.find_elements(By.CSS_SELECTOR, "#sankey .sk-link"), "no Sankey flows for " + ix["name"]

        pid = driver.capabilities.get("moz:processID")
        if pid and os.path.exists("/proc/%s/status" % pid):
            with open("/proc/%s/status" % pid) as fp:
                hwm = [l.split()[1] for l in fp if l.startswith("VmHWM")]
            print("firefox peak RSS (VmHWM): %.0f MB" % (int(hwm[0]) / 1024))
        print("PASS")
    finally:
        driver.quit()
        httpd.shutdown()


if __name__ == "__main__":
    main()
