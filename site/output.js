// Streaming the classifier's output out of the WebAssembly module, shared by
// worker.js and test/node_parity.mjs.

// Makes `path` a write-only device that passes each chunk the program writes to write(bytes).
export function mkOutputDevice(mod, path, write) {
  const dev = mod.FS.makedev(63, 0);
  mod.FS.registerDevice(dev, {
    open(stream) {
      stream.seekable = false;
    },
    close() {},
    write(stream, buffer, offset, length) {
      offset = Number(offset);
      write(buffer.subarray(offset, offset + Number(length)));
      return length;
    },
  });
  mod.FS.mkdev(path, dev);
}

// gzip compression with the module's own zlib (src/wasm_gzip.c), run
// synchronously as the output is written. Output is copied into the module's
// input buffer and compressed each time it fills. Compressed bytes go to
// emit(bytes), which must consume them before returning.
export function gzipper(mod, level, emit) {
  if (mod._cfr_gz_begin(level) !== 0) throw new Error('Could not start gzip compression.');
  const inPtr = Number(mod._cfr_gz_in());
  const inSize = mod._cfr_gz_in_size();
  let used = 0;
  const flush = (n) => {
    if (n < 0) throw new Error('gzip compression failed.');
    if (n > 0) {
      const p = Number(mod._cfr_gz_out());
      emit(mod.HEAPU8.subarray(p, p + n));
    }
  };
  return {
    write(bytes) {
      for (let off = 0; off < bytes.length; ) {
        const take = Math.min(inSize - used, bytes.length - off);
        mod.HEAPU8.set(bytes.subarray(off, off + take), inPtr + used);
        used += take;
        off += take;
        if (used === inSize) {
          flush(mod._cfr_gz_write(used));
          used = 0;
        }
      }
    },
    end() {
      if (used) flush(mod._cfr_gz_write(used));
      used = 0;
      flush(mod._cfr_gz_end());
    },
  };
}
