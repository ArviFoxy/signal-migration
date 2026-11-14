//! Links the C and C++ libraries that BoringSSL needs.
//!
//! scripts/build-boringssl-wasm.sh builds BoringSSL with wasi-sdk for the target wasm32-wasip1 and copies that
//! toolchain's C library, C++ library and compiler runtime into build/boringssl-wasm. The Rust code is built for
//! wasm32-unknown-unknown, where no C library is linked by default, so the libraries are named here.

use std::env;
use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let built = manifest.join("../../build/boringssl-wasm");
    println!("cargo:rerun-if-changed={}", built.join("lib/libcrypto.a").display());

    if env::var("TARGET").as_deref() != Ok("wasm32-unknown-unknown") {
        return;
    }
    let libraries = built.join("sysroot/lib/wasm32-wasip1");
    // BoringSSL is built without C++ exceptions, so it takes the C++ library built without them.
    for folder in [libraries.join("noeh"), libraries, built.join("lib")] {
        println!("cargo:rustc-link-search=native={}", folder.display());
    }
    for library in ["c++", "c++abi", "c", "clang_rt.builtins"] {
        println!("cargo:rustc-link-lib=static={library}");
    }
}
