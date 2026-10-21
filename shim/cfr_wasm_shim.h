// Force-included (-include) into every Centrifuger translation unit for the
// WebAssembly build. It lets the unmodified upstream sources run without
// pthreads support:
//   - pthread_create runs the thread function synchronously,
//   - pthread_exit longjmps back to the matching pthread_create,
//   - pthread_join / attr calls are no-ops.
// This is only correct when Centrifuger runs with one thread (-t 1), which the
// web worker always passes.
#ifndef CFR_WASM_SHIM_H
#define CFR_WASM_SHIM_H

#include <pthread.h>
#include <setjmp.h>
#include <stdlib.h>

#ifdef __cplusplus
extern "C" {
#endif

int cfr_shim_pthread_create(pthread_t *thread, const pthread_attr_t *attr,
    void *(*start)(void *), void *arg) ;
int cfr_shim_pthread_join(pthread_t thread, void **retval) ;
__attribute__((noreturn)) void cfr_shim_pthread_exit(void *retval) ;

#ifdef __cplusplus
}
#endif

#define pthread_create cfr_shim_pthread_create
#define pthread_join cfr_shim_pthread_join
#define pthread_exit cfr_shim_pthread_exit

#endif
