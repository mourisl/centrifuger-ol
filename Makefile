# Build Centrifuger (from the pinned GitHub checkout in centrifuger-src/) to
# WebAssembly for the static website, plus native tools for building the index.
#   source scripts/env.sh && make
CFR_REPO ?= https://github.com/mourisl/centrifuger.git
# Upstream master as of 2026-10-21 (v1.2.0-r367, reference dust masking in
# centrifuger-build). Any tag, branch or commit works, e.g. CFR_REF=v1.1.4.
CFR_REF ?= cb740636bf047b16fc55a169c998291a135e27e9
CFR_SRC ?= centrifuger-src
OUT     ?= site/wasm

EMCXX ?= em++
EMCC  ?= emcc

WASM_CFLAGS = -O3 -m64 -sUSE_ZLIB=1 -I$(CFR_SRC) -I$(CFR_SRC)/compactds
WASM_CXXFLAGS = $(WASM_CFLAGS) -include shim/cfr_wasm_shim.h -Dmain=cfr_upstream_main -Wno-format
WASM_LDFLAGS = -O3 -m64 -sUSE_ZLIB=1 \
	-sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=8GB -sSTACK_SIZE=8MB \
	-sMODULARIZE=1 -sEXPORT_ES6=1 -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 \
	-sFORCE_FILESYSTEM=1 -lworkerfs.js -sENVIRONMENT=web,worker,node \
	-sEXPORTED_RUNTIME_METHODS=callMain,FS,WORKERFS

NATIVE_CXX ?= g++
NATIVE_FLAGS = -O3 -Wall -I$(CFR_SRC) -I$(CFR_SRC)/compactds

# Pinned upstream checkout (the local development tree is deliberately not used).
$(CFR_SRC)/CentrifugerClass.cpp:
	git clone -q $(CFR_REPO) $(CFR_SRC)
	git -C $(CFR_SRC) checkout -q --detach $(CFR_REF)

# Stop if an existing checkout is not at CFR_REF.
check-src: $(CFR_SRC)/CentrifugerClass.cpp
	@want=$$(git -C $(CFR_SRC) rev-parse -q --verify '$(CFR_REF)^{commit}'); \
	have=$$(git -C $(CFR_SRC) rev-parse HEAD); \
	[ "$$want" = "$$have" ] || { echo "$(CFR_SRC) is at $$have, not $(CFR_REF); remove it or run: git -C $(CFR_SRC) fetch && git -C $(CFR_SRC) checkout --detach $(CFR_REF)" >&2; exit 1; }

HEADERS = $(wildcard $(CFR_SRC)/*.hpp $(CFR_SRC)/*.h $(CFR_SRC)/compactds/*.hpp) shim/cfr_wasm_shim.h

all: wasm

wasm: $(OUT)/centrifuger.js $(OUT)/centrifuger-quant.js

build/wasm/%.o: $(CFR_SRC)/%.cpp $(CFR_SRC)/CentrifugerClass.cpp $(HEADERS) | check-src
	@mkdir -p $(dir $@)
	$(EMCXX) $(WASM_CXXFLAGS) -c $< -o $@

build/wasm/wasm_main.o: src/wasm_main.cpp
	@mkdir -p $(dir $@)
	$(EMCXX) $(WASM_CFLAGS) -c $< -o $@

build/wasm/wasm_shim.o: src/wasm_shim.c
	@mkdir -p $(dir $@)
	$(EMCC) $(WASM_CFLAGS) -c $< -o $@

build/wasm/wasm_gzip.o: src/wasm_gzip.c
	@mkdir -p $(dir $@)
	$(EMCC) $(WASM_CFLAGS) -c $< -o $@

# The classifier also exports the gzip helpers the worker uses to compress its output.
CLASS_EXPORTS = -sEXPORTED_FUNCTIONS=_main,_cfr_gz_begin,_cfr_gz_in,_cfr_gz_in_size,_cfr_gz_write,_cfr_gz_end,_cfr_gz_out \
	-sEXPORTED_RUNTIME_METHODS=callMain,FS,WORKERFS,HEAPU8

$(OUT)/centrifuger.js: build/wasm/CentrifugerClass.o build/wasm/wasm_main.o build/wasm/wasm_shim.o build/wasm/wasm_gzip.o
	@mkdir -p $(OUT)
	$(EMCXX) $^ $(WASM_LDFLAGS) $(CLASS_EXPORTS) -sEXPORT_NAME=createCentrifuger -o $@

$(OUT)/centrifuger-quant.js: build/wasm/CentrifugerQuant.o build/wasm/wasm_main.o build/wasm/wasm_shim.o
	@mkdir -p $(OUT)
	$(EMCXX) $^ $(WASM_LDFLAGS) -sEXPORT_NAME=createCentrifugerQuant -o $@

# Native binaries from the same pinned source, used to build the index and as
# the reference in the parity test.
native: build/native/centrifuger build/native/centrifuger-build build/native/centrifuger-quant

build/native/centrifuger: $(CFR_SRC)/CentrifugerClass.cpp $(HEADERS) | check-src
	@mkdir -p $(dir $@)
	$(NATIVE_CXX) $(NATIVE_FLAGS) -o $@ $< -lpthread -lz
build/native/centrifuger-build: $(CFR_SRC)/CentrifugerBuild.cpp $(HEADERS) | check-src
	@mkdir -p $(dir $@)
	$(NATIVE_CXX) $(NATIVE_FLAGS) -o $@ $< -lpthread -lz
build/native/centrifuger-quant: $(CFR_SRC)/CentrifugerQuant.cpp $(HEADERS) | check-src
	@mkdir -p $(dir $@)
	$(NATIVE_CXX) $(NATIVE_FLAGS) -o $@ $< -lpthread -lz

index: native
	bash scripts/build_index.sh all

test: wasm native
	node test/node_parity.mjs

clean:
	rm -rf build $(OUT)/centrifuger.js $(OUT)/centrifuger.wasm $(OUT)/centrifuger-quant.js $(OUT)/centrifuger-quant.wasm

.PHONY: all wasm native index test clean check-src
