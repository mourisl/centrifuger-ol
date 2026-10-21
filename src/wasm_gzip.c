// gzip compression of the classification output for the web worker. The worker
// calls these while Centrifuger writes its results (from inside the write to the
// output device), because the browser's CompressionStream is asynchronous and
// could not run until the classification finished. zlib is already linked for
// reading compressed reads.
#include <stdlib.h>
#include <string.h>
#include <zlib.h>

#define IN_SIZE (1 << 20)

static z_stream zs;
static unsigned char *in = NULL; // the worker copies output here, then calls cfr_gz_write
static unsigned char *out = NULL;
static size_t outCap = 0;

// Compresses avail_in bytes; returns the number of output bytes, or -1.
static int Run(int flush)
{
  size_t n = 0;
  int ret;
  do
  {
    if (outCap - n < 65536)
    {
      size_t cap = outCap ? 2 * outCap : 1 << 20;
      unsigned char *p = realloc(out, cap);
      if (!p)
        return -1;
      out = p;
      outCap = cap;
    }
    zs.next_out = out + n;
    zs.avail_out = (uInt)(outCap - n);
    ret = deflate(&zs, flush);
    if (ret == Z_STREAM_ERROR)
      return -1;
    n = outCap - zs.avail_out;
  } while (zs.avail_out == 0 || (flush == Z_FINISH && ret != Z_STREAM_END));
  return (int)n;
}

int cfr_gz_begin(int level)
{
  if (!in && !(in = malloc(IN_SIZE)))
    return -1;
  memset(&zs, 0, sizeof(zs));
  return deflateInit2(&zs, level, Z_DEFLATED, 15 + 16, 8, Z_DEFAULT_STRATEGY) == Z_OK ? 0 : -1;
}

// The input buffer and its size.
unsigned char *cfr_gz_in(void)
{
  return in;
}

int cfr_gz_in_size(void)
{
  return IN_SIZE;
}

// Compresses the first len bytes of the input buffer. Returns how many
// compressed bytes are ready at cfr_gz_out(), or -1 on error.
int cfr_gz_write(int len)
{
  zs.next_in = in;
  zs.avail_in = (uInt)len;
  return Run(Z_NO_FLUSH);
}

// Flushes the remaining data and the gzip trailer; returns the byte count at cfr_gz_out().
int cfr_gz_end(void)
{
  zs.next_in = NULL;
  zs.avail_in = 0;
  int n = Run(Z_FINISH);
  deflateEnd(&zs);
  return n;
}

unsigned char *cfr_gz_out(void)
{
  return out;
}
