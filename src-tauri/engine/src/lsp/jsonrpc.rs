use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const JSONRPC_VERSION: &str = "2.0";

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Id {
    Number(i64),
    String(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageHeader {
    pub content_length: usize,
}

/// Parse an `LSP/JSON-RPC` header block (`Content-Length: N\r\n\r\n`).
/// Returns `(header, bytes_consumed)` or `None` if the buffer is incomplete.
pub fn parse_header(buf: &[u8]) -> Option<(MessageHeader, usize)> {
    let idx = find_subslice(buf, b"\r\n\r\n")?;
    let head = std::str::from_utf8(&buf[..idx]).ok()?;
    let mut content_length: Option<usize> = None;
    for line in head.split("\r\n") {
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case("Content-Length") {
                content_length = value.trim().parse::<usize>().ok();
            }
        }
    }
    let length = content_length?;
    Some((MessageHeader { content_length: length }, idx + 4))
}

/// A request frame: `Content-Length: <n>\r\n\r\n<json>`.
pub fn encode_message(json: &[u8]) -> Vec<u8> {
    let header = format!("Content-Length: {}\r\n\r\n", json.len());
    let mut out = Vec::with_capacity(header.len() + json.len());
    out.extend_from_slice(header.as_bytes());
    out.extend_from_slice(json);
    out
}

/// Decode a single message from a buffer. Returns `(message_bytes, consumed)`.
pub fn decode_message(buf: &[u8]) -> Option<(Vec<u8>, usize)> {
    let (header, consumed) = parse_header(buf)?;
    if buf.len() < consumed + header.content_length {
        return None;
    }
    let body = &buf[consumed..consumed + header.content_length];
    Some((body.to_vec(), consumed + header.content_length))
}

/// An RPC message — the union of request, response, and notification.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RpcMessage {
    Request {
        jsonrpc: String,
        id: Id,
        method: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        params: Option<Value>,
    },
    Response {
        jsonrpc: String,
        id: Id,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<RpcError>,
    },
    Notification {
        jsonrpc: String,
        method: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        params: Option<Value>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcMessage {
    pub fn request(id: Id, method: impl Into<String>, params: Value) -> Self {
        RpcMessage::Request {
            jsonrpc: JSONRPC_VERSION.to_string(),
            id,
            method: method.into(),
            params: Some(params),
        }
    }

    pub fn response(id: Id, result: Value) -> Self {
        RpcMessage::Response {
            jsonrpc: JSONRPC_VERSION.to_string(),
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error_response(id: Id, code: i64, message: String) -> Self {
        RpcMessage::Response {
            jsonrpc: JSONRPC_VERSION.to_string(),
            id,
            result: None,
            error: Some(RpcError {
                code,
                message,
                data: None,
            }),
        }
    }

    pub fn notification(method: impl Into<String>, params: Value) -> Self {
        RpcMessage::Notification {
            jsonrpc: JSONRPC_VERSION.to_string(),
            method: method.into(),
            params: Some(params),
        }
    }
}

pub fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_decode_roundtrip() {
        let msg = RpcMessage::request(Id::Number(1), "initialize", serde_json::json!({
            "processId": null,
            "capabilities": {}
        }));
        let body = serde_json::to_vec(&msg).unwrap();
        let framed = encode_message(&body);

        assert!(framed.starts_with(b"Content-Length: "));
        assert!(framed.ends_with(b"\r\n\r\n"));

        let (decoded, consumed) = decode_message(&framed).unwrap();
        assert_eq!(consumed, framed.len());
        let decoded: RpcMessage = serde_json::from_slice(&decoded).unwrap();

        match decoded {
            RpcMessage::Request { id, method, params, .. } => {
                assert_eq!(id, Id::Number(1));
                assert_eq!(method, "initialize");
                assert!(params.is_some());
            }
            other => panic!("expected request, got {other:?}"),
        }
    }

    #[test]
    fn decode_partial_header_returns_none() {
        assert!(parse_header(b"Content-Length: 10").is_none());
    }

    #[test]
    fn decode_incomplete_body_returns_none() {
        let msg = RpcMessage::notification("$/progress", serde_json::json!({"value": 1}));
        let body = serde_json::to_vec(&msg).unwrap();
        let framed = encode_message(&body);
        // Cut off 3 bytes of the body.
        let truncated = &framed[..framed.len() - 3];
        assert!(decode_message(truncated).is_none());
    }

    #[test]
    fn response_with_error_roundtrip() {
        let msg = RpcMessage::error_response(Id::String("a".into()), -32601, "Method not found".into());
        let body = serde_json::to_vec(&msg).unwrap();
        let (decoded, _) = decode_message(&encode_message(&body)).unwrap();
        let decoded: RpcMessage = serde_json::from_slice(&decoded).unwrap();
        match decoded {
            RpcMessage::Response { error, result, .. } => {
                assert!(result.is_none());
                assert_eq!(error.unwrap().code, -32601);
            }
            other => panic!("expected response, got {other:?}"),
        }
    }

    #[test]
    fn notification_roundtrip() {
        let msg = RpcMessage::notification("textDocument/didChange", serde_json::json!({
            "textDocument": { "uri": "file:///x.ts", "version": 2 }
        }));
        let body = serde_json::to_vec(&msg).unwrap();
        let (decoded, _) = decode_message(&encode_message(&body)).unwrap();
        let decoded: RpcMessage = serde_json::from_slice(&decoded).unwrap();
        match decoded {
            RpcMessage::Notification { method, params, .. } => {
                assert_eq!(method, "textDocument/didChange");
                assert!(params.is_some());
            }
            other => panic!("expected notification, got {other:?}"),
        }
    }

    #[test]
    fn streaming_multiple_messages() {
        let mut buf = Vec::new();
        for i in 0..3 {
            let msg = RpcMessage::request(Id::Number(i), "textDocument/hover", serde_json::json!({}));
            buf.extend(encode_message(&serde_json::to_vec(&msg).unwrap()));
        }
        let mut consumed_total = 0;
        let mut count = 0;
        while let Some((_, consumed)) = decode_message(&buf[consumed_total..]) {
            consumed_total += consumed;
            count += 1;
        }
        assert_eq!(count, 3);
        assert_eq!(consumed_total, buf.len());
    }
}
