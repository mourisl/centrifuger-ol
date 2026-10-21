// Entry point wrapper for the WebAssembly build. Upstream main() is renamed to
// cfr_upstream_main via -Dmain=cfr_upstream_main. This wrapper accepts one
// extra leading option, "--wasm-stdout <path>", that redirects stdout to a file
// in the Emscripten filesystem. The worker makes that path a device that streams
// the output to disk, so it is opened for appending: devices cannot be
// truncated, and on a new regular file "a" behaves like "w".
#include <stdio.h>
#include <string.h>

int cfr_upstream_main(int argc, char *argv[]) ;

int main(int argc, char *argv[])
{
  if (argc >= 3 && !strcmp(argv[1], "--wasm-stdout"))
  {
    if (freopen(argv[2], "a", stdout) == NULL)
    {
      fprintf(stderr, "Failed to open %s for writing\n", argv[2]) ;
      return 1 ;
    }
    argv[2] = argv[0] ;
    argc -= 2 ;
    argv += 2 ;
  }
  int ret = cfr_upstream_main(argc, argv) ;
  fflush(stdout) ;
  fflush(stderr) ;
  return ret ;
}
