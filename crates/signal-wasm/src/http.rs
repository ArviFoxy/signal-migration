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

/// Parses an HTTP/1.1 response from `buffer`. Returns `Ok(None)` while more bytes are needed. With `ended`, a body
/// with neither Content-Length nor chunked encoding runs to the end of the stream.
pub fn parse_response(buffer: &[u8], ended: bool) -> Result<Option<ParsedResponse>, String> {
    let mut header_storage = [httparse::EMPTY_HEADER; 64];
    let mut response = httparse::Response::new(&mut header_storage);
    let head_len = match response.parse(buffer).map_err(|e| e.to_string())? {
        httparse::Status::Complete(n) => n,
        httparse::Status::Partial => return Ok(None),
    };
    let status = response.code.ok_or("response has no status code")?;
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
    let header = |name: &str| headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str());
    let rest = &buffer[head_len..];

    let body = if header("transfer-encoding").is_some_and(|v| v.to_ascii_lowercase().contains("chunked")) {
        let mut body = Vec::new();
        let mut offset = 0;
        loop {
            let (size_len, size) =
                match httparse::parse_chunk_size(&rest[offset..]).map_err(|_| "malformed chunk size")? {
                    httparse::Status::Complete(parsed) => parsed,
                    httparse::Status::Partial => return Ok(None),
                };
            let size = usize::try_from(size).map_err(|_| "chunk too large")?;
            let data_start = offset + size_len;
            if size == 0 {
                break body;
            }
            if rest.len() < data_start + size + 2 {
                return Ok(None);
            }
            body.extend_from_slice(&rest[data_start..data_start + size]);
            offset = data_start + size + 2;
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
        let mut connection = connect(host).map_err(js_error)?;
        let mut head = format!(
            "{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nContent-Length: {}\r\n",
            body.len()
        );
        for header in headers {
            head.push_str(&header);
            head.push_str("\r\n");
        }
        head.push_str("\r\n");
        connection.writer().write_all(head.as_bytes()).map_err(js_error)?;
        connection.writer().write_all(body).map_err(js_error)?;
        let mut request = TlsHttpRequest {
            connection,
            transport: Transport::default(),
            received: Vec::new(),
            response: None,
        };
        request.pump(false)?;
        Ok(request)
    }

    #[wasm_bindgen(js_name = receiveEncrypted)]
    pub fn receive_encrypted(&mut self, data: &[u8]) -> Result<(), JsError> {
        self.transport.push_received(data);
        self.pump(false)
    }

    /// Call when the tunnel closed; completes a response delimited by the end of the stream.
    #[wasm_bindgen(js_name = streamEnded)]
    pub fn stream_ended(&mut self) -> Result<(), JsError> {
        self.pump(true)
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

    pub fn body(&self) -> Vec<u8> {
        self.response.as_ref().map(|r| r.body.clone()).unwrap_or_default()
    }

    fn pump(&mut self, ended: bool) -> Result<(), JsError> {
        loop {
            if self.connection.wants_write() {
                self.connection.write_tls(&mut self.transport).map_err(js_error)?;
                continue;
            }
            if self.connection.wants_read() && !self.transport.0.borrow().incoming.is_empty() {
                self.connection.read_tls(&mut self.transport).map_err(js_error)?;
                self.connection.process_new_packets().map_err(js_error)?;
                continue;
            }
            break;
        }
        let mut buffer = [0u8; 16 * 1024];
        let mut tls_closed = false;
        loop {
            match self.connection.reader().read(&mut buffer) {
                Ok(0) => {
                    tls_closed = true;
                    break;
                }
                Ok(n) => self.received.extend_from_slice(&buffer[..n]),
                Err(error) if error.kind() == ErrorKind::WouldBlock => break,
                Err(error) if error.kind() == ErrorKind::UnexpectedEof => {
                    tls_closed = true;
                    break;
                }
                Err(error) => return Err(js_error(error)),
            }
        }
        if self.response.is_none() {
            self.response = parse_response(&self.received, ended || tls_closed).map_err(js_error)?;
        }
        Ok(())
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
            parse_response(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nhello", false).unwrap(),
            None
        );
        let response = parse_response(b"HTTP/1.1 409 Conflict\r\nContent-Length: 10\r\n\r\nhelloworld", false)
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
        assert_eq!(parse_response(b"HTTP/1.1 200 OK\r\n\r\npartial", false).unwrap(), None);
        assert_eq!(
            parse_response(b"HTTP/1.1 200 OK\r\n\r\npartial", true)
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
                false
            )
            .unwrap(),
            None
        );
    }
}
