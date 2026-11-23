//! One HTTP/1.1 request inside a TLS session to a Signal host, with the response parsed by httparse.

use std::io::{ErrorKind, Read, Write};

use rustls::ClientConnection;
use wasm_bindgen::prelude::*;

use crate::js_error;
use crate::tls::{Transport, connect};

/// A complete HTTP response.
#[derive(Debug, PartialEq)]
pub struct ParsedResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

fn is_http_token(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
}

fn format_request_head(
    host: &str,
    method: &str,
    path: &str,
    headers: &[String],
    body_len: usize,
) -> Result<String, String> {
    if !is_http_token(method) {
        return Err("invalid HTTP method".to_string());
    }
    if !path.starts_with('/') || path.bytes().any(|b| b <= 0x20 || b == 0x7f) {
        return Err("invalid HTTP request path".to_string());
    }
    if host.is_empty() || host.bytes().any(|b| b <= 0x20 || b == 0x7f) {
        return Err("invalid HTTP host".to_string());
    }
    let send_content_length = body_len > 0
        || method.eq_ignore_ascii_case("POST")
        || method.eq_ignore_ascii_case("PUT")
        || method.eq_ignore_ascii_case("PATCH");
    let mut head = format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n");
    if send_content_length {
        head.push_str(&format!("Content-Length: {body_len}\r\n"));
    }
    for header in headers {
        let (name, value) = header
            .split_once(':')
            .ok_or_else(|| "a header must be \"Name: value\"".to_string())?;
        let name = name.trim();
        let value = value.trim();
        if !is_http_token(name) {
            return Err(format!("invalid HTTP header name: {name}"));
        }
        if name.eq_ignore_ascii_case("host")
            || name.eq_ignore_ascii_case("connection")
            || name.eq_ignore_ascii_case("content-length")
            || name.eq_ignore_ascii_case("transfer-encoding")
        {
            return Err(format!("header {name} is managed by the client"));
        }
        if value.bytes().any(|b| b == b'\r' || b == b'\n' || b == 0) {
            return Err(format!("invalid characters in header {name}"));
        }
        head.push_str(name);
        head.push_str(": ");
        head.push_str(value);
        head.push_str("\r\n");
    }
    head.push_str("\r\n");
    Ok(head)
}

/// Parses an HTTP/1.1 response from `buffer`. Returns `Ok(None)` while more bytes are needed. Skips leading `1xx`
/// interim responses (except `101`). With `ended`, a body with neither Content-Length nor chunked encoding runs to
/// the end of the stream. With `no_body` (e.g. a HEAD request), or for statuses that never carry a body (204, 304,
/// 101), completes as soon as the headers end.
pub fn parse_response(buffer: &[u8], ended: bool, no_body: bool) -> Result<Option<ParsedResponse>, String> {
    let mut head_offset = 0usize;
    let (status, headers, rest) = loop {
        let slice = &buffer[head_offset..];
        let mut header_storage = [httparse::EMPTY_HEADER; 64];
        let mut response = httparse::Response::new(&mut header_storage);
        let head_len = match response.parse(slice).map_err(|e| e.to_string())? {
            httparse::Status::Complete(n) => n,
            httparse::Status::Partial => return Ok(None),
        };
        let status = response.code.ok_or("response has no status code")?;
        if (100..200).contains(&status) && status != 101 {
            head_offset = head_offset
                .checked_add(head_len)
                .ok_or("response header offset overflow")?;
            continue;
        }
        let headers: Vec<(String, String)> = response
            .headers
            .iter()
            .map(|h| {
                (
                    h.name.to_ascii_lowercase(),
                    String::from_utf8_lossy(h.value).into_owned(),
                )
            })
            .collect();
        break (status, headers, &slice[head_len..]);
    };
    if no_body || status == 204 || status == 304 || status == 101 {
        return Ok(Some(ParsedResponse {
            status,
            headers,
            body: Vec::new(),
        }));
    }
    let is_chunked = headers
        .iter()
        .filter(|(n, _)| n == "transfer-encoding")
        .any(|(_, v)| v.to_ascii_lowercase().contains("chunked"));
    let header = |name: &str| headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str());

    let body = if is_chunked {
        let mut body = Vec::new();
        let mut offset = 0usize;
        loop {
            let (size_len, size) =
                match httparse::parse_chunk_size(&rest[offset..]).map_err(|_| "malformed chunk size")? {
                    httparse::Status::Complete(parsed) => parsed,
                    httparse::Status::Partial => return Ok(None),
                };
            let size = usize::try_from(size).map_err(|_| "chunk too large")?;
            let data_start = offset.checked_add(size_len).ok_or("chunk too large")?;
            if size == 0 {
                let tail = &rest[data_start..];
                if tail.starts_with(b"\r\n") || tail.windows(4).any(|w| w == b"\r\n\r\n") {
                    break body;
                }
                return Ok(None);
            }
            let data_end = data_start.checked_add(size).ok_or("chunk too large")?;
            let next_offset = data_end.checked_add(2).ok_or("chunk too large")?;
            if rest.len() < next_offset {
                return Ok(None);
            }
            if &rest[data_end..next_offset] != b"\r\n" {
                return Err("malformed chunk terminator".to_string());
            }
            body.extend_from_slice(&rest[data_start..data_end]);
            offset = next_offset;
        }
    } else if let Some(length) = header("content-length") {
        let length: usize = length.trim().parse().map_err(|_| "malformed Content-Length")?;
        if rest.len() < length {
            return Ok(None);
        }
        rest[..length].to_vec()
    } else if ended {
        rest.to_vec()
    } else {
        return Ok(None);
    };
    Ok(Some(ParsedResponse { status, headers, body }))
}

#[wasm_bindgen]
pub struct TlsHttpRequest {
    connection: ClientConnection,
    transport: Transport,
    received: Vec<u8>,
    read_end: ReadEnd,
    no_body: bool,
    response: Option<ParsedResponse>,
}

#[wasm_bindgen]
impl TlsHttpRequest {
    /// Starts TLS to `host` and queues the request; `headers` are "Name: value". Uses `Connection: close`.
    #[wasm_bindgen(constructor)]
    pub fn new(
        host: &str,
        method: &str,
        path: &str,
        headers: Vec<String>,
        body: &[u8],
    ) -> Result<TlsHttpRequest, JsError> {
        let head = format_request_head(host, method, path, &headers, body.len()).map_err(js_error)?;
        let mut connection = connect(host).map_err(js_error)?;
        let no_body = method.eq_ignore_ascii_case("HEAD");
        connection.writer().write_all(head.as_bytes()).map_err(js_error)?;
        connection.writer().write_all(body).map_err(js_error)?;
        let mut request = TlsHttpRequest {
            connection,
            transport: Transport::default(),
            received: Vec::new(),
            read_end: ReadEnd::Open,
            no_body,
            response: None,
        };
        request.pump()?;
        Ok(request)
    }

    #[wasm_bindgen(js_name = receiveEncrypted)]
    pub fn receive_encrypted(&mut self, data: &[u8]) -> Result<(), JsError> {
        self.transport.push_received(data);
        self.pump()
    }

    /// Call when the tunnel closed. A response delimited by the end of the stream is complete only if the server
    /// ended the TLS session with close_notify; otherwise the tunnel may have cut it short.
    #[wasm_bindgen(js_name = streamEnded)]
    pub fn stream_ended(&mut self) -> Result<(), JsError> {
        self.pump()
    }

    #[wasm_bindgen(js_name = takeEncrypted)]
    pub fn take_encrypted(&mut self) -> Vec<u8> {
        self.transport.take_outgoing()
    }

    #[wasm_bindgen(getter, js_name = isComplete)]
    pub fn is_complete(&self) -> bool {
        self.response.is_some()
    }

    #[wasm_bindgen(getter)]
    pub fn status(&self) -> u16 {
        self.response.as_ref().map_or(0, |r| r.status)
    }

    pub fn header(&self, name: &str) -> Option<String> {
        let name = name.to_ascii_lowercase();
        self.response
            .as_ref()?
            .headers
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, v)| v.clone())
    }

    /// All response headers as `"lowercase-name: value"`, so JavaScript can copy them before freeing the request.
    #[wasm_bindgen(js_name = rawHeaders)]
    pub fn raw_headers(&self) -> Vec<String> {
        self.response
            .as_ref()
            .map(|r| r.headers.iter().map(|(n, v)| format!("{n}: {v}")).collect())
            .unwrap_or_default()
    }

    pub fn body(&self) -> Vec<u8> {
        self.response.as_ref().map(|r| r.body.clone()).unwrap_or_default()
    }

    fn pump(&mut self) -> Result<(), JsError> {
        // rustls `wants_read()` returns false whenever decrypted plaintext is unread, and `read_tls()` consumes at
        // most 4 KiB per call. Draining plaintext inside the loop ensures multi-record WebSocket frames (>4 KiB)
        // never strand ciphertext in `transport.incoming`.
        loop {
            let mut progressed = false;
            if self.connection.wants_write() {
                self.connection.write_tls(&mut self.transport).map_err(js_error)?;
                progressed = true;
            }
            let before = self.received.len();
            let end = read_available(&mut self.connection.reader(), &mut self.received).map_err(js_error)?;
            if end != ReadEnd::Open {
                self.read_end = end;
            }
            if self.received.len() > before {
                progressed = true;
            }
            if self.connection.wants_read() && !self.transport.0.borrow().incoming.is_empty() {
                self.connection.read_tls(&mut self.transport).map_err(js_error)?;
                self.connection.process_new_packets().map_err(js_error)?;
                progressed = true;
            }
            if !progressed {
                break;
            }
        }
        if self.response.is_none() {
            self.response =
                parse_response(&self.received, self.read_end == ReadEnd::Clean, self.no_body).map_err(js_error)?;
        }
        Ok(())
    }
}

/// How reading the TLS session's plaintext stopped.
#[derive(Debug, PartialEq)]
enum ReadEnd {
    /// Nothing more for now.
    Open,
    /// The server ended the session with close_notify: rustls then reads 0 bytes.
    Clean,
    /// The connection ended without close_notify (rustls reports UnexpectedEof), which whoever relays the bytes can
    /// cause, so a response delimited by the end of the stream may be incomplete.
    Dropped,
}

/// Reads all the plaintext available into `into`.
fn read_available(reader: &mut impl Read, into: &mut Vec<u8>) -> std::io::Result<ReadEnd> {
    let mut buffer = [0u8; 16 * 1024];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => return Ok(ReadEnd::Clean),
            Ok(n) => into.extend_from_slice(&buffer[..n]),
            Err(error) if error.kind() == ErrorKind::WouldBlock => return Ok(ReadEnd::Open),
            Err(error) if error.kind() == ErrorKind::UnexpectedEof => return Ok(ReadEnd::Dropped),
            Err(error) => return Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Detects: losing or duplicating data across chunk boundaries in chunked transfer coding.
    #[test]
    fn joins_a_chunked_body() {
        let response = parse_response(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n",
            false,
            false,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            (response.status, response.body.as_slice()),
            (200, b"Wikipedia".as_slice())
        );
    }

    // Detects: returning a truncated body as if complete.
    #[test]
    fn waits_for_the_rest_of_a_content_length_body() {
        assert_eq!(
            parse_response(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nhello", false, false).unwrap(),
            None
        );
        let response = parse_response(
            b"HTTP/1.1 409 Conflict\r\nContent-Length: 10\r\n\r\nhelloworld",
            false,
            false,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            (response.status, response.body.as_slice()),
            (409, b"helloworld".as_slice())
        );
    }

    // Detects: hanging forever on a body delimited only by the end of the connection.
    #[test]
    fn ends_an_undelimited_body_at_the_end_of_the_stream() {
        assert_eq!(
            parse_response(b"HTTP/1.1 200 OK\r\n\r\npartial", false, false).unwrap(),
            None
        );
        assert_eq!(
            parse_response(b"HTTP/1.1 200 OK\r\n\r\npartial", true, false)
                .unwrap()
                .unwrap()
                .body,
            b"partial"
        );
    }

    // Detects: stalling on 204 No Content (TUS PATCH) or HEAD responses that carry no body bytes.
    #[test]
    fn completes_204_and_head_without_waiting_for_a_body() {
        let patch = parse_response(b"HTTP/1.1 204 No Content\r\nUpload-Offset: 512\r\n\r\n", false, false)
            .unwrap()
            .unwrap();
        assert_eq!(patch.status, 204);
        assert!(patch.body.is_empty());

        let head = parse_response(
            b"HTTP/1.1 200 OK\r\nContent-Length: 1024\r\nUpload-Offset: 512\r\n\r\n",
            false,
            true,
        )
        .unwrap()
        .unwrap();
        assert_eq!(head.status, 200);
        assert!(head.body.is_empty());
    }

    /// A reader that returns `data`, then ends as `end` does.
    struct Ending {
        data: Option<Vec<u8>>,
        end: fn() -> std::io::Result<usize>,
    }

    impl Read for Ending {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            match self.data.take() {
                Some(data) => {
                    buf[..data.len()].copy_from_slice(&data);
                    Ok(data.len())
                }
                None => (self.end)(),
            }
        }
    }

    // Detects: a connection that dropped without close_notify taken for the end of a response delimited by the end
    // of the stream, so that the relay could cut such a response short unnoticed.
    #[test]
    fn completes_an_undelimited_body_only_after_close_notify() {
        let head = b"HTTP/1.1 200 OK\r\n\r\npartial".to_vec();
        let mut dropped = Ending {
            data: Some(head.clone()),
            end: || Err(ErrorKind::UnexpectedEof.into()),
        };
        let mut received = Vec::new();
        let end = read_available(&mut dropped, &mut received).unwrap();
        assert_eq!(end, ReadEnd::Dropped);
        assert_eq!(parse_response(&received, end == ReadEnd::Clean, false).unwrap(), None);

        let mut closed = Ending {
            data: Some(head),
            end: || Ok(0),
        };
        let mut received = Vec::new();
        let end = read_available(&mut closed, &mut received).unwrap();
        assert_eq!(end, ReadEnd::Clean);
        assert_eq!(
            parse_response(&received, end == ReadEnd::Clean, false)
                .unwrap()
                .unwrap()
                .body,
            b"partial"
        );
    }

    // Detects: treating an incomplete chunked body as complete.
    #[test]
    fn waits_for_the_terminating_chunk() {
        assert_eq!(
            parse_response(
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nWiki\r\n",
                false,
                false,
            )
            .unwrap(),
            None
        );
    }

    // Detects: treating 100 Continue interim headers as the final response.
    #[test]
    fn skips_interim_1xx_responses() {
        let response = parse_response(
            b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok",
            false,
            false,
        )
        .unwrap()
        .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body, b"ok");
    }

    // Detects: missing chunked transfer-encoding when multiple Transfer-Encoding headers are present.
    #[test]
    fn recognizes_chunked_across_multiple_transfer_encoding_headers() {
        let response = parse_response(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: identity\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nhi\r\n0\r\n\r\n",
            false,
            false,
        )
        .unwrap()
        .unwrap();
        assert_eq!(response.body, b"hi");
    }

    // Detects: accepting malformed chunk terminators or completing before the final CRLF after 0\r\n.
    #[test]
    fn validates_chunk_crlf_delimiters() {
        assert!(
            parse_response(
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nWikiXX0\r\n\r\n",
                false,
                false,
            )
            .is_err()
        );
        assert_eq!(
            parse_response(
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nWiki\r\n0\r\n",
                false,
                false,
            )
            .unwrap(),
            None
        );
    }

    // Detects: usize arithmetic overflow in chunked parser when chunk size approaches usize::MAX.
    #[test]
    fn rejects_chunk_size_overflow_without_panicking() {
        let huge = format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\nabcd",
            usize::MAX - 2
        );
        let parsed = parse_response(huge.as_bytes(), false, false);
        assert!(parsed.is_err() || parsed.unwrap().is_none());
    }

    // Detects: rustls wants_read() returning false while plaintext sits unread, stranding the rest of a >4 KiB
    // multi-record WebSocket frame in Transport::incoming.
    #[test]
    fn drains_multi_record_tls_response_delivered_in_one_16kib_chunk() {
        use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
        use rustls::time_provider::TimeProvider;
        use rustls::{ClientConfig, RootCertStore, ServerConfig, ServerConnection};
        use std::sync::Arc;
        use std::time::Duration;

        #[derive(Debug)]
        struct FixedTime;
        impl TimeProvider for FixedTime {
            fn current_time(&self) -> Option<UnixTime> {
                Some(UnixTime::since_unix_epoch(Duration::from_secs(1_767_225_600))) // 2026-01-01
            }
        }

        const CA_DER: &[u8] = &[
            48, 130, 1, 105, 48, 130, 1, 16, 160, 3, 2, 1, 2, 2, 20, 13, 47, 194, 99, 208, 86, 213, 221, 236, 125, 233,
            33, 85, 71, 240, 92, 249, 74, 2, 234, 48, 10, 6, 8, 42, 134, 72, 206, 61, 4, 3, 2, 48, 18, 49, 16, 48, 14,
            6, 3, 85, 4, 3, 12, 7, 84, 101, 115, 116, 32, 67, 65, 48, 32, 23, 13, 50, 48, 48, 49, 48, 49, 48, 48, 48,
            48, 48, 48, 90, 24, 15, 50, 48, 57, 57, 49, 50, 51, 49, 50, 51, 53, 57, 53, 57, 90, 48, 18, 49, 16, 48, 14,
            6, 3, 85, 4, 3, 12, 7, 84, 101, 115, 116, 32, 67, 65, 48, 89, 48, 19, 6, 7, 42, 134, 72, 206, 61, 2, 1, 6,
            8, 42, 134, 72, 206, 61, 3, 1, 7, 3, 66, 0, 4, 70, 218, 42, 141, 126, 97, 18, 15, 112, 80, 10, 87, 212,
            246, 49, 72, 9, 74, 121, 165, 87, 232, 116, 26, 228, 233, 150, 75, 205, 21, 194, 114, 58, 245, 118, 130,
            115, 195, 122, 218, 9, 222, 4, 197, 30, 167, 174, 251, 102, 122, 36, 36, 68, 181, 179, 10, 94, 248, 129,
            75, 13, 240, 183, 25, 163, 66, 48, 64, 48, 29, 6, 3, 85, 29, 14, 4, 22, 4, 20, 213, 155, 183, 242, 38, 80,
            242, 189, 21, 115, 132, 96, 85, 241, 176, 24, 220, 191, 103, 248, 48, 15, 6, 3, 85, 29, 19, 1, 1, 255, 4,
            5, 48, 3, 1, 1, 255, 48, 14, 6, 3, 85, 29, 15, 1, 1, 255, 4, 4, 3, 2, 2, 4, 48, 10, 6, 8, 42, 134, 72, 206,
            61, 4, 3, 2, 3, 71, 0, 48, 68, 2, 32, 74, 233, 215, 167, 17, 247, 187, 214, 20, 130, 174, 211, 240, 197,
            100, 95, 209, 113, 162, 113, 59, 78, 164, 11, 171, 189, 41, 86, 5, 151, 29, 55, 2, 32, 14, 171, 61, 5, 23,
            170, 9, 237, 200, 93, 246, 125, 252, 101, 219, 70, 137, 52, 69, 234, 107, 54, 251, 148, 97, 88, 223, 10,
            144, 235, 232, 175,
        ];
        const LEAF_DER: &[u8] = &[
            48, 130, 1, 124, 48, 130, 1, 33, 160, 3, 2, 1, 2, 2, 20, 53, 71, 229, 71, 42, 196, 59, 43, 66, 112, 105,
            128, 163, 99, 11, 26, 3, 245, 110, 56, 48, 10, 6, 8, 42, 134, 72, 206, 61, 4, 3, 2, 48, 18, 49, 16, 48, 14,
            6, 3, 85, 4, 3, 12, 7, 84, 101, 115, 116, 32, 67, 65, 48, 32, 23, 13, 50, 48, 48, 49, 48, 49, 48, 48, 48,
            48, 48, 48, 90, 24, 15, 50, 48, 57, 57, 49, 50, 51, 49, 50, 51, 53, 57, 53, 57, 90, 48, 23, 49, 21, 48, 19,
            6, 3, 85, 4, 3, 12, 12, 116, 101, 115, 116, 46, 105, 110, 118, 97, 108, 105, 100, 48, 89, 48, 19, 6, 7, 42,
            134, 72, 206, 61, 2, 1, 6, 8, 42, 134, 72, 206, 61, 3, 1, 7, 3, 66, 0, 4, 77, 169, 14, 165, 147, 124, 153,
            244, 237, 232, 80, 123, 192, 142, 122, 60, 63, 197, 244, 175, 106, 241, 181, 0, 200, 127, 30, 78, 130, 87,
            213, 192, 0, 33, 104, 151, 219, 77, 212, 88, 109, 102, 96, 71, 249, 122, 218, 101, 161, 102, 67, 139, 227,
            31, 139, 31, 49, 19, 26, 203, 157, 203, 134, 114, 163, 78, 48, 76, 48, 12, 6, 3, 85, 29, 19, 1, 1, 255, 4,
            2, 48, 0, 48, 14, 6, 3, 85, 29, 15, 1, 1, 255, 4, 4, 3, 2, 7, 128, 48, 19, 6, 3, 85, 29, 37, 4, 12, 48, 10,
            6, 8, 43, 6, 1, 5, 5, 7, 3, 1, 48, 23, 6, 3, 85, 29, 17, 4, 16, 48, 14, 130, 12, 116, 101, 115, 116, 46,
            105, 110, 118, 97, 108, 105, 100, 48, 10, 6, 8, 42, 134, 72, 206, 61, 4, 3, 2, 3, 73, 0, 48, 70, 2, 33, 0,
            236, 86, 61, 231, 134, 233, 23, 206, 8, 45, 147, 4, 217, 222, 130, 70, 86, 32, 193, 225, 231, 227, 206, 86,
            137, 92, 142, 56, 228, 79, 81, 104, 2, 33, 0, 204, 83, 128, 4, 155, 244, 213, 169, 52, 110, 6, 222, 42,
            148, 236, 81, 211, 135, 68, 157, 82, 82, 156, 145, 104, 12, 206, 66, 29, 139, 218, 200,
        ];
        const KEY_DER: &[u8] = &[
            48, 129, 135, 2, 1, 0, 48, 19, 6, 7, 42, 134, 72, 206, 61, 2, 1, 6, 8, 42, 134, 72, 206, 61, 3, 1, 7, 4,
            109, 48, 107, 2, 1, 1, 4, 32, 142, 61, 97, 48, 245, 182, 103, 163, 76, 103, 243, 2, 113, 139, 32, 12, 207,
            191, 100, 26, 1, 187, 126, 153, 242, 210, 89, 181, 150, 94, 235, 105, 161, 68, 3, 66, 0, 4, 77, 169, 14,
            165, 147, 124, 153, 244, 237, 232, 80, 123, 192, 142, 122, 60, 63, 197, 244, 175, 106, 241, 181, 0, 200,
            127, 30, 78, 130, 87, 213, 192, 0, 33, 104, 151, 219, 77, 212, 88, 109, 102, 96, 71, 249, 122, 218, 101,
            161, 102, 67, 139, 227, 31, 139, 31, 49, 19, 26, 203, 157, 203, 134, 114,
        ];

        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let mut roots = RootCertStore::empty();
        roots.add(CertificateDer::from(CA_DER)).unwrap();
        let client_cfg = Arc::new(
            ClientConfig::builder_with_details(provider.clone(), Arc::new(FixedTime))
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_root_certificates(roots)
                .with_no_client_auth(),
        );
        let server_cfg = Arc::new(
            ServerConfig::builder_with_details(provider, Arc::new(FixedTime))
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_no_client_auth()
                .with_single_cert(
                    vec![CertificateDer::from(LEAF_DER), CertificateDer::from(CA_DER)],
                    PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(KEY_DER)),
                )
                .unwrap(),
        );

        let mut client_conn = ClientConnection::new(client_cfg, ServerName::try_from("test.invalid").unwrap()).unwrap();
        client_conn.set_buffer_limit(None);
        client_conn
            .writer()
            .write_all(b"GET / HTTP/1.1\r\nHost: test.invalid\r\nConnection: close\r\n\r\n")
            .unwrap();
        let mut req = TlsHttpRequest {
            connection: client_conn,
            transport: Transport::default(),
            received: Vec::new(),
            read_end: ReadEnd::Open,
            no_body: false,
            response: None,
        };
        let mut server = ServerConnection::new(server_cfg).unwrap();

        // Complete TLS handshake + send client request.
        req.pump().unwrap();
        let mut server_req = Vec::new();
        for _ in 0..8 {
            let c2s = req.take_encrypted();
            if !c2s.is_empty() {
                let mut cursor = std::io::Cursor::new(c2s);
                while (cursor.position() as usize) < cursor.get_ref().len() {
                    server.read_tls(&mut cursor).unwrap();
                    server.process_new_packets().unwrap();
                    let _ = server.reader().read_to_end(&mut server_req);
                }
            }
            let mut s2c = Vec::new();
            while server.wants_write() {
                server.write_tls(&mut s2c).unwrap();
            }
            if !s2c.is_empty() {
                req.receive_encrypted(&s2c).unwrap();
            }
            if !server_req.is_empty() {
                break;
            }
        }
        assert!(server_req.starts_with(b"GET / HTTP/1.1"));

        // Emit HTTP headers as one TLS record and an 11 KiB body across additional TLS records, all delivered in a
        // single 16 KiB WebSocket frame (matching crates/server/src/relay.rs).
        let payload = vec![b'x'; 11 * 1024];
        let headers = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", payload.len());
        server.writer().write_all(headers.as_bytes()).unwrap();
        let mut wire = Vec::new();
        while server.wants_write() {
            server.write_tls(&mut wire).unwrap();
        }
        for chunk in payload.chunks(3000) {
            server.writer().write_all(chunk).unwrap();
            while server.wants_write() {
                server.write_tls(&mut wire).unwrap();
            }
        }
        assert!(wire.len() > 8192 && wire.len() <= 16 * 1024);

        req.receive_encrypted(&wire).unwrap();
        assert!(
            req.is_complete(),
            "response must complete from one 16 KiB multi-record frame"
        );
        assert_eq!(req.status(), 200);
        assert_eq!(req.body(), payload);
    }

    // Detects: CRLF or whitespace injection in request method, path, host, or headers.
    #[test]
    fn rejects_request_line_and_header_injection() {
        assert!(format_request_head("cdn.signal.org", "GET", "/ok", &[], 0).is_ok());
        assert!(format_request_head("cdn.signal.org", "GET\r\nX: y", "/ok", &[], 0).is_err());
        assert!(format_request_head("cdn.signal.org", "GET", "/ok HTTP/1.1\r\n", &[], 0).is_err());
        assert!(format_request_head("cdn.signal.org", "GET", "relative", &[], 0).is_err());
        assert!(format_request_head("cdn.signal.org\r\n", "GET", "/ok", &[], 0).is_err());
        assert!(
            format_request_head(
                "cdn.signal.org",
                "POST",
                "/ok",
                &["X-Test: a\r\nInjected: b".to_string()],
                0,
            )
            .is_err()
        );
        assert!(format_request_head("cdn.signal.org", "POST", "/ok", &["Host: evil.example".to_string()], 0,).is_err());
    }
}
