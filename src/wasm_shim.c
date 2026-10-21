// Implementation of the synchronous pthread shim (see shim/cfr_wasm_shim.h).
#include <pthread.h>
#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>

#define CFR_SHIM_MAX_DEPTH 8

static jmp_buf cfrJmpStack[CFR_SHIM_MAX_DEPTH] ;
static void *cfrRetStack[CFR_SHIM_MAX_DEPTH] ;
static int cfrDepth = 0 ;

int cfr_shim_pthread_create(pthread_t *thread, const pthread_attr_t *attr,
    void *(*start)(void *), void *arg)
{
  (void)attr ;
  if (cfrDepth >= CFR_SHIM_MAX_DEPTH)
  {
    fprintf(stderr, "cfr_wasm_shim: thread nesting too deep\n") ;
    abort() ;
  }
  int d = cfrDepth++ ;
  if (setjmp(cfrJmpStack[d]) == 0)
    cfrRetStack[d] = start(arg) ;
  cfrDepth = d ;
  if (thread)
    *thread = (pthread_t)0 ;
  return 0 ;
}

int cfr_shim_pthread_join(pthread_t thread, void **retval)
{
  (void)thread ;
  if (retval)
    *retval = NULL ;
  return 0 ;
}

void cfr_shim_pthread_exit(void *retval)
{
  if (cfrDepth == 0)
    exit(0) ;
  cfrRetStack[cfrDepth - 1] = retval ;
  longjmp(cfrJmpStack[cfrDepth - 1], 1) ;
}
