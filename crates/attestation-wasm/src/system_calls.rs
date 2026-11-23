//! The five system calls that the C library asks for.
//!
//! The C library linked into this module (wasi-libc) reaches its surroundings through WASI, a set of system calls for
//! WebAssembly. A browser offers none of them. The linker would turn each into an import of the finished module, and
//! the page would have to supply them. Defining them here, under the names the C library refers to, binds them at
//! link time instead, so the module imports nothing beyond what wasm-bindgen itself needs.
//!
//! BoringSSL uses the random numbers. The clock and the writes are reached only on paths such as an abort message.

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn console_error(text: &str);
    #[wasm_bindgen(js_namespace = Date, js_name = now)]
    fn milliseconds_since_1970() -> f64;
}

// WASI's error numbers.
const SUCCESS: i32 = 0;
const BAD_FILE_DESCRIPTOR: i32 = 8;
const INVALID_ARGUMENT: i32 = 28;
const IO_ERROR: i32 = 29;
const NOT_SEEKABLE: i32 = 70;

const STANDARD_OUTPUT: i32 = 1;
const STANDARD_ERROR: i32 = 2;

/// Fills `length` bytes at `buffer` with random bytes from the browser.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn __imported_wasi_snapshot_preview1_random_get(buffer: *mut u8, length: usize) -> i32 {
    if length == 0 {
        return SUCCESS;
    }
    if buffer.is_null() {
        return INVALID_ARGUMENT;
    }
    // SAFETY: `length > 0` and `buffer` is non-null; the C library passes a writable buffer of `length` bytes.
    let bytes = unsafe { core::slice::from_raw_parts_mut(buffer, length) };
    match getrandom::fill(bytes) {
        Ok(()) => SUCCESS,
        Err(_) => IO_ERROR,
    }
}

/// Writes the time in nanoseconds since 1970 to `nanoseconds`, whichever clock is asked for.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn __imported_wasi_snapshot_preview1_clock_time_get(
    _clock: i32,
    _precision: i64,
    nanoseconds: *mut u64,
) -> i32 {
    if nanoseconds.is_null() {
        return INVALID_ARGUMENT;
    }
    let ms = milliseconds_since_1970();
    let ns = if ms.is_finite() && ms >= 0.0 {
        (ms * 1_000_000.0) as u64
    } else {
        0
    };
    // SAFETY: `nanoseconds` is non-null and points to one writable u64.
    unsafe { *nanoseconds = ns };
    SUCCESS
}

/// One piece of a write: WASI's `ciovec`.
#[repr(C)]
pub struct Piece {
    start: *const u8,
    length: usize,
}

/// Sends what the C library writes to standard output or standard error to the browser's console.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn __imported_wasi_snapshot_preview1_fd_write(
    file: i32,
    pieces: *const Piece,
    piece_count: usize,
    written: *mut usize,
) -> i32 {
    if file != STANDARD_OUTPUT && file != STANDARD_ERROR {
        return BAD_FILE_DESCRIPTOR;
    }
    if written.is_null() || (piece_count > 0 && pieces.is_null()) {
        return INVALID_ARGUMENT;
    }
    let mut bytes = Vec::new();
    if piece_count > 0 {
        // SAFETY: `piece_count > 0` and `pieces` is non-null; the C library passes `piece_count` initialized pieces.
        let pieces = unsafe { core::slice::from_raw_parts(pieces, piece_count) };
        for piece in pieces {
            if piece.length == 0 {
                continue;
            }
            if piece.start.is_null() {
                return INVALID_ARGUMENT;
            }
            // SAFETY: `piece.length > 0` and `piece.start` is non-null.
            bytes.extend_from_slice(unsafe { core::slice::from_raw_parts(piece.start, piece.length) });
        }
    }
    console_error(&String::from_utf8_lossy(&bytes));
    // SAFETY: `written` is non-null and points to one writable usize.
    unsafe { *written = bytes.len() };
    SUCCESS
}

/// There are no files to close.
#[unsafe(no_mangle)]
pub extern "C" fn __imported_wasi_snapshot_preview1_fd_close(_file: i32) -> i32 {
    BAD_FILE_DESCRIPTOR
}

/// There are no files to seek in.
#[unsafe(no_mangle)]
pub extern "C" fn __imported_wasi_snapshot_preview1_fd_seek(
    _file: i32,
    _offset: i64,
    _from: i32,
    _position: *mut u64,
) -> i32 {
    NOT_SEEKABLE
}
