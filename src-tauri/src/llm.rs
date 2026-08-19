//! LLM 层（DESIGN §8）：三种 provider 的流式行解析（纯函数，可独立测试）
//! + 跨 chunk 半行缓冲组装器 + reqwest 流式客户端。
//! 依赖铁律：单次受控调用——无 Agent、无循环、无后台轮询。
//! 模块不依赖 tauri；事件推送（ai-stream:{call_id}）由 ai.rs 编排层负责。
//!
//! usage 语义（三协议拆分方式不同，统一由 LineAssembler 合并）：
//! - openai：末尾 usage 块（stream_options.include_usage）→ Done 携带双向 token；
//! - anthropic：message_start 带 input_tokens、message_delta 带 output_tokens；
//! - ollama：done:true 行带 prompt_eval_count/eval_count。
//! 流终止以 HTTP 流结束为准；Done 事件仅承载 usage 汇总。

use std::collections::HashMap;
use std::sync::Mutex;

use futures_util::StreamExt;

// ───── 事件与 provider 模型 ─────

#[derive(Debug, Clone, PartialEq)]
pub enum StreamEvent {
    Delta(String),
    Done { tokens_in: u64, tokens_out: u64 },
    Error(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    OpenAi,
    Anthropic,
    Ollama,
}

impl ProviderKind {
    pub fn from_type(s: &str) -> Option<Self> {
        match s {
            "openai" => Some(Self::OpenAi),
            "anthropic" => Some(Self::Anthropic),
            "ollama" => Some(Self::Ollama),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::Anthropic => "anthropic",
            Self::Ollama => "ollama",
        }
    }

    /// 端点：openai {base}/chat/completions；anthropic {base}/v1/messages；ollama {base}/api/chat。
    pub fn endpoint(&self, base: &str) -> String {
        let b = base.trim_end_matches('/');
        match self {
            Self::OpenAi => format!("{b}/chat/completions"),
            Self::Anthropic => format!("{b}/v1/messages"),
            Self::Ollama => format!("{b}/api/chat"),
        }
    }
}

// ───── 纯行解析器（T1）─────

/// SSE `data:` 载荷提取（event:/注释/空行 → None，即坏行跳过）。
fn sse_payload(line: &str) -> Option<&str> {
    let l = line.trim_start();
    let rest = l.strip_prefix("data:")?;
    Some(rest.trim_start())
}

/// openai 兼容 API：`data: {json}`，增量在 choices[0].delta.content；
/// usage 块（choices 为空）与 `data: [DONE]` 均返回 Done。
pub fn parse_openai_line(line: &str) -> Vec<StreamEvent> {
    let Some(payload) = sse_payload(line) else {
        return vec![];
    };
    if payload.trim() == "[DONE]" {
        return vec![StreamEvent::Done { tokens_in: 0, tokens_out: 0 }];
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) else {
        return vec![];
    };
    let mut out = Vec::new();
    if let Some(msg) = v.pointer("/error/message").and_then(|m| m.as_str()) {
        out.push(StreamEvent::Error(msg.to_string()));
        return out;
    }
    if let Some(text) = v.pointer("/choices/0/delta/content").and_then(|c| c.as_str()) {
        if !text.is_empty() {
            out.push(StreamEvent::Delta(text.to_string()));
        }
    }
    if let Some(u) = v.get("usage").filter(|u| u.is_object()) {
        let tin = u.get("prompt_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
        let tout = u.get("completion_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
        out.push(StreamEvent::Done { tokens_in: tin, tokens_out: tout });
    }
    out
}

/// anthropic messages 流：content_block_delta 增量；message_start/message_delta
/// 各带一半 usage；message_stop 终结。Done 的 usage 由组装器合并。
pub fn parse_anthropic_line(line: &str) -> Vec<StreamEvent> {
    let Some(payload) = sse_payload(line) else {
        return vec![];
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) else {
        return vec![];
    };
    match v.get("type").and_then(|t| t.as_str()).unwrap_or("") {
        "content_block_delta" => v
            .pointer("/delta/text")
            .and_then(|t| t.as_str())
            .filter(|t| !t.is_empty())
            .map(|t| vec![StreamEvent::Delta(t.to_string())])
            .unwrap_or_default(),
        "message_start" => {
            let tin = v.pointer("/message/usage/input_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
            vec![StreamEvent::Done { tokens_in: tin, tokens_out: 0 }]
        }
        "message_delta" => {
            let tout = v.pointer("/usage/output_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
            vec![StreamEvent::Done { tokens_in: 0, tokens_out: tout }]
        }
        "message_stop" => vec![StreamEvent::Done { tokens_in: 0, tokens_out: 0 }],
        "error" => {
            let msg = v
                .pointer("/error/message")
                .and_then(|m| m.as_str())
                .unwrap_or("未知错误");
            vec![StreamEvent::Error(msg.to_string())]
        }
        _ => vec![],
    }
}

/// ollama chat NDJSON：每行一个 JSON，message.content 增量，done:true 终结并带 usage。
pub fn parse_ollama_line(line: &str) -> Vec<StreamEvent> {
    let l = line.trim();
    if l.is_empty() {
        return vec![];
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(l) else {
        return vec![];
    };
    let mut out = Vec::new();
    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        out.push(StreamEvent::Error(err.to_string()));
        return out;
    }
    if let Some(text) = v.pointer("/message/content").and_then(|c| c.as_str()) {
        if !text.is_empty() {
            out.push(StreamEvent::Delta(text.to_string()));
        }
    }
    if v.get("done").and_then(|d| d.as_bool()) == Some(true) {
        let tin = v.get("prompt_eval_count").and_then(|x| x.as_u64()).unwrap_or(0);
        let tout = v.get("eval_count").and_then(|x| x.as_u64()).unwrap_or(0);
        out.push(StreamEvent::Done { tokens_in: tin, tokens_out: tout });
    }
    out
}

// ───── LineAssembler：半行缓冲 + usage 合并（T1/T2）─────

pub struct LineAssembler {
    kind: ProviderKind,
    buf: Vec<u8>,
    tokens_in: u64,
    tokens_out: u64,
    error: Option<String>,
}

impl LineAssembler {
    pub fn new(kind: ProviderKind) -> Self {
        Self { kind, buf: Vec::new(), tokens_in: 0, tokens_out: 0, error: None }
    }

    /// 喂入一个网络 chunk（可能截断在行中间/UTF-8 字符中间），
    /// 返回可立即转发的 Delta/Error 事件；Done 事件只并入 usage 累计。
    pub fn push(&mut self, chunk: &[u8]) -> Vec<StreamEvent> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line[..line.len() - 1]);
            let line = line.trim_end_matches('\r');
            self.absorb(line, &mut out);
        }
        out
    }

    /// 流结束：冲刷残余半行，返回汇总 Done（以及错误）。
    pub fn finish(&mut self) -> Vec<StreamEvent> {
        if !self.buf.is_empty() {
            let line = String::from_utf8_lossy(&self.buf).into_owned();
            self.buf.clear();
            let mut dummy = Vec::new();
            self.absorb(&line, &mut dummy);
        }
        if let Some(msg) = self.error.clone() {
            return vec![
                StreamEvent::Error(msg),
                StreamEvent::Done { tokens_in: self.tokens_in, tokens_out: self.tokens_out },
            ];
        }
        vec![StreamEvent::Done { tokens_in: self.tokens_in, tokens_out: self.tokens_out }]
    }

    pub fn usage(&self) -> (u64, u64) {
        (self.tokens_in, self.tokens_out)
    }

    /// 取出流内错误（SSE error 事件），无则 None。
    pub fn take_error(&mut self) -> Option<String> {
        self.error.take()
    }

    fn absorb(&mut self, line: &str, out: &mut Vec<StreamEvent>) {
        if line.trim().is_empty() {
            return;
        }
        let events = match self.kind {
            ProviderKind::OpenAi => parse_openai_line(line),
            ProviderKind::Anthropic => parse_anthropic_line(line),
            ProviderKind::Ollama => parse_ollama_line(line),
        };
        for ev in events {
            match ev {
                StreamEvent::Delta(t) => out.push(StreamEvent::Delta(t)),
                StreamEvent::Error(m) => {
                    if self.error.is_none() {
                        self.error = Some(m.clone());
                    }
                    out.push(StreamEvent::Error(m));
                }
                StreamEvent::Done { tokens_in, tokens_out } => {
                    if tokens_in > 0 {
                        self.tokens_in = tokens_in;
                    }
                    if tokens_out > 0 {
                        self.tokens_out = tokens_out;
                    }
                }
            }
        }
    }
}

// ───── 请求模型与流式客户端（T2）─────

#[derive(Debug, Clone, PartialEq)]
pub struct VisionPart {
    pub b64: String,
    pub media_type: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum MessageContent {
    Text(String),
    Vision { text: String, images: Vec<VisionPart> },
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChatMessage {
    pub role: String, // system | user | assistant
    pub content: MessageContent,
}

impl ChatMessage {
    pub fn system(text: impl Into<String>) -> Self {
        Self { role: "system".into(), content: MessageContent::Text(text.into()) }
    }
    pub fn user(text: impl Into<String>) -> Self {
        Self { role: "user".into(), content: MessageContent::Text(text.into()) }
    }
    pub fn assistant(text: impl Into<String>) -> Self {
        Self { role: "assistant".into(), content: MessageContent::Text(text.into()) }
    }
    pub fn user_vision(text: impl Into<String>, images: Vec<VisionPart>) -> Self {
        Self { role: "user".into(), content: MessageContent::Vision { text: text.into(), images } }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub max_tokens: Option<u64>,
    pub temperature: Option<f64>,
}

#[derive(Debug, thiserror::Error)]
pub enum LlmError {
    #[error("网络错误: {0}")]
    Request(#[from] reqwest::Error),
    #[error("服务返回 HTTP {status}: {body}")]
    Http { status: reqwest::StatusCode, body: String },
    #[error("{0}")]
    Stream(String),
}

#[derive(Debug)]
pub struct StreamOutcome {
    pub text: String,
    pub tokens_in: u64,
    pub tokens_out: u64,
}

fn openai_content(c: &MessageContent) -> serde_json::Value {
    match c {
        MessageContent::Text(t) => serde_json::json!(t),
        MessageContent::Vision { text, images } => {
            let mut parts = vec![serde_json::json!({ "type": "text", "text": text })];
            for img in images {
                parts.push(serde_json::json!({
                    "type": "image_url",
                    "image_url": { "url": format!("data:{};base64,{}", img.media_type, img.b64) }
                }));
            }
            serde_json::json!(parts)
        }
    }
}

fn build_body(kind: ProviderKind, req: &ChatRequest) -> serde_json::Value {
    match kind {
        ProviderKind::OpenAi => {
            let mut v = serde_json::json!({
                "model": req.model,
                "messages": req.messages.iter().map(|m| serde_json::json!({
                    "role": m.role,
                    "content": openai_content(&m.content),
                })).collect::<Vec<_>>(),
                "stream": true,
                "stream_options": { "include_usage": true },
            });
            if let Some(t) = req.temperature {
                v["temperature"] = serde_json::json!(t);
            }
            if let Some(m) = req.max_tokens {
                v["max_tokens"] = serde_json::json!(m);
            }
            v
        }
        ProviderKind::Anthropic => {
            let system: Vec<&str> = req
                .messages
                .iter()
                .filter_map(|m| match &m.content {
                    MessageContent::Text(t) if m.role == "system" => Some(t.as_str()),
                    _ => None,
                })
                .collect();
            let messages: Vec<serde_json::Value> = req
                .messages
                .iter()
                .filter(|m| m.role != "system")
                .map(|m| match &m.content {
                    MessageContent::Text(t) => serde_json::json!({ "role": m.role, "content": t }),
                    MessageContent::Vision { text, images } => {
                        let mut blocks = vec![serde_json::json!({ "type": "text", "text": text })];
                        for img in images {
                            blocks.push(serde_json::json!({
                                "type": "image",
                                "source": { "type": "base64", "media_type": img.media_type, "data": img.b64 }
                            }));
                        }
                        serde_json::json!({ "role": m.role, "content": blocks })
                    }
                })
                .collect();
            let mut v = serde_json::json!({
                "model": req.model,
                // anthropic 必填 max_tokens
                "max_tokens": req.max_tokens.unwrap_or(4096),
                "messages": messages,
                "stream": true,
            });
            if !system.is_empty() {
                v["system"] = serde_json::json!(system.join("\n\n"));
            }
            if let Some(t) = req.temperature {
                v["temperature"] = serde_json::json!(t);
            }
            v
        }
        ProviderKind::Ollama => {
            let messages: Vec<serde_json::Value> = req
                .messages
                .iter()
                .map(|m| {
                    let (text, images): (String, Option<Vec<String>>) = match &m.content {
                        MessageContent::Text(t) => (t.clone(), None),
                        MessageContent::Vision { text, images } => (
                            text.clone(),
                            Some(images.iter().map(|i| i.b64.clone()).collect()),
                        ),
                    };
                    let mut o = serde_json::json!({ "role": m.role, "content": text });
                    if let Some(imgs) = images {
                        o["images"] = serde_json::json!(imgs);
                    }
                    o
                })
                .collect();
            let mut v = serde_json::json!({
                "model": req.model,
                "messages": messages,
                "stream": true,
            });
            let mut options = serde_json::Map::new();
            if let Some(m) = req.max_tokens {
                options.insert("num_predict".into(), serde_json::json!(m));
            }
            if let Some(t) = req.temperature {
                options.insert("temperature".into(), serde_json::json!(t));
            }
            if !options.is_empty() {
                v["options"] = serde_json::Value::Object(options);
            }
            v
        }
    }
}

/// 单次流式对话：请求 {base}，逐 chunk 解析，Delta/Error 经回调转发；
/// 返回汇总全文与 usage。**绝不重试**（铁律：单次受控调用，fallback 由编排层换路由）。
pub async fn stream_chat<F>(
    base_url: &str,
    kind: ProviderKind,
    key: Option<&str>,
    req: &ChatRequest,
    mut on_event: F,
) -> Result<StreamOutcome, LlmError>
where
    F: FnMut(StreamEvent),
{
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()?;
    let mut rb = client
        .post(kind.endpoint(base_url))
        .header("content-type", "application/json")
        .json(&build_body(kind, req));
    match kind {
        ProviderKind::OpenAi => {
            if let Some(k) = key {
                rb = rb.bearer_auth(k);
            }
        }
        ProviderKind::Anthropic => {
            rb = rb
                .header("x-api-key", key.unwrap_or_default())
                .header("anthropic-version", "2023-06-01");
        }
        ProviderKind::Ollama => {}
    }
    let resp = rb.send().await?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let body: String = body.chars().take(500).collect();
        return Err(LlmError::Http { status, body });
    }
    let mut stream = resp.bytes_stream();
    let mut asm = LineAssembler::new(kind);
    let mut text = String::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        for ev in asm.push(&chunk) {
            if let StreamEvent::Delta(t) = &ev {
                text.push_str(t);
            }
            on_event(ev);
        }
    }
    for ev in asm.finish() {
        on_event(ev);
    }
    if let Some(msg) = asm.take_error() {
        return Err(LlmError::Stream(msg));
    }
    let (tokens_in, tokens_out) = asm.usage();
    Ok(StreamOutcome { text, tokens_in, tokens_out })
}

// ───── 密钥存取（keyring / 测试内存实现，T3 前置）─────

pub trait KeyStore: Send + Sync {
    fn set(&self, provider_id: &str, key: &str) -> Result<(), String>;
    fn get(&self, provider_id: &str) -> Result<Option<String>, String>;
    fn delete(&self, provider_id: &str) -> Result<(), String>;
}

/// 真实现：Windows 凭据管理器（keyring），service=mewbox、account=provider_id。
/// 密钥不落盘、不进工作区（DESIGN §8）；换机需重配（设计如此）。
pub struct KeyringStore;

impl KeyStore for KeyringStore {
    fn set(&self, provider_id: &str, key: &str) -> Result<(), String> {
        let entry = keyring::Entry::new("mewbox", provider_id).map_err(|e| e.to_string())?;
        entry.set_password(key).map_err(|e| e.to_string())
    }

    fn get(&self, provider_id: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new("mewbox", provider_id).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(k) => Ok(Some(k)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn delete(&self, provider_id: &str) -> Result<(), String> {
        let entry = keyring::Entry::new("mewbox", provider_id).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// 测试假实现（不碰系统钥匙串）。
#[derive(Default)]
pub struct InMemoryKeyStore(Mutex<HashMap<String, String>>);

impl KeyStore for InMemoryKeyStore {
    fn set(&self, provider_id: &str, key: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(provider_id.to_string(), key.to_string());
        Ok(())
    }

    fn get(&self, provider_id: &str) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().get(provider_id).cloned())
    }

    fn delete(&self, provider_id: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(provider_id);
        Ok(())
    }
}

// ───── 测试 ─────

#[cfg(test)]
pub(crate) mod mock {
    //! 微型 SSE/HTTP mock 服务器：TcpListener + 手写 chunked 响应，
    //! 小块分片（强制半行切分）+ 逐块 flush + 可选延迟（取消测试用）。

    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};

    /// 读完整请求（头 + content-length 长度的体）。
    fn read_request(s: &mut TcpStream) -> String {
        let mut data = Vec::new();
        let mut b = [0u8; 1];
        loop {
            let n = s.read(&mut b).unwrap_or(0);
            if n == 0 {
                break;
            }
            data.push(b[0]);
            if let Some(pos) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&data[..pos]).to_lowercase();
                let cl = headers
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length:"))
                    .and_then(|v| v.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                if data.len() >= pos + 4 + cl {
                    break;
                }
            }
        }
        String::from_utf8_lossy(&data).into_owned()
    }

    /// 起一个一次性 mock 服务器：返回端口。响应体按 piece 字节分块写出，
    /// 每块间 delay_ms 延迟；piece 故意小于一行以制造半行切分。
    pub fn spawn(body: Vec<u8>, piece: usize, delay_ms: u64) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let _req = read_request(&mut s);
            let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";
            s.write_all(head.as_bytes()).unwrap();
            for piece_bytes in body.chunks(piece.max(1)) {
                s.write_all(format!("{:x}\r\n", piece_bytes.len()).as_bytes()).unwrap();
                s.write_all(piece_bytes).unwrap();
                s.write_all(b"\r\n").unwrap();
                s.flush().unwrap();
                if delay_ms > 0 {
                    std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                }
            }
            s.write_all(b"0\r\n\r\n").unwrap();
            s.flush().unwrap();
        });
        port
    }

    /// 起 HTTP 错误状态的 mock 服务器。
    pub fn spawn_error(status_line: &str, body: &str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let status_line = status_line.to_string();
        let body = body.to_string();
        std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let _req = read_request(&mut s);
            let resp = format!(
                "{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                status_line,
                body.len(),
                body
            );
            s.write_all(resp.as_bytes()).unwrap();
            s.flush().unwrap();
        });
        port
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── 纯解析器 ──

    #[test]
    fn openai_line_delta_usage_done_and_bad_lines() {
        assert_eq!(
            parse_openai_line(r#"data: {"choices":[{"delta":{"content":"你好"}}]}"#),
            vec![StreamEvent::Delta("你好".into())]
        );
        // usage 块（choices 空）
        assert_eq!(
            parse_openai_line(
                r#"data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}"#
            ),
            vec![StreamEvent::Done { tokens_in: 12, tokens_out: 3 }]
        );
        assert_eq!(
            parse_openai_line("data: [DONE]"),
            vec![StreamEvent::Done { tokens_in: 0, tokens_out: 0 }]
        );
        // 坏行/无关行跳过
        assert!(parse_openai_line("event: message").is_empty());
        assert!(parse_openai_line(": keep-alive").is_empty());
        assert!(parse_openai_line("data: not-json").is_empty());
        // 错误透传
        assert_eq!(
            parse_openai_line(r#"data: {"error":{"message":"invalid key"}}"#),
            vec![StreamEvent::Error("invalid key".into())]
        );
    }

    #[test]
    fn anthropic_line_delta_and_split_usage() {
        assert_eq!(
            parse_anthropic_line(
                r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"嗨"}}"#
            ),
            vec![StreamEvent::Delta("嗨".into())]
        );
        assert_eq!(
            parse_anthropic_line(
                r#"data: {"type":"message_start","message":{"usage":{"input_tokens":25,"output_tokens":1}}}"#
            ),
            vec![StreamEvent::Done { tokens_in: 25, tokens_out: 0 }]
        );
        assert_eq!(
            parse_anthropic_line(
                r#"data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":15}}"#
            ),
            vec![StreamEvent::Done { tokens_in: 0, tokens_out: 15 }]
        );
        assert_eq!(
            parse_anthropic_line(r#"data: {"type":"message_stop"}"#),
            vec![StreamEvent::Done { tokens_in: 0, tokens_out: 0 }]
        );
        assert!(parse_anthropic_line("event: content_block_delta").is_empty());
        assert_eq!(
            parse_anthropic_line(r#"data: {"type":"error","error":{"message":"overloaded"}}"#),
            vec![StreamEvent::Error("overloaded".into())]
        );
    }

    #[test]
    fn ollama_line_delta_done_and_errors() {
        assert_eq!(
            parse_ollama_line(r#"{"message":{"role":"assistant","content":"喵"}}"#),
            vec![StreamEvent::Delta("喵".into())]
        );
        assert_eq!(
            parse_ollama_line(
                r#"{"message":{"content":""},"done":true,"prompt_eval_count":7,"eval_count":2}"#
            ),
            vec![StreamEvent::Done { tokens_in: 7, tokens_out: 2 }]
        );
        assert!(parse_ollama_line("").is_empty());
        assert!(parse_ollama_line("garbage").is_empty());
        assert_eq!(
            parse_ollama_line(r#"{"error":"model not found"}"#),
            vec![StreamEvent::Error("model not found".into())]
        );
    }

    // ── LineAssembler：半行缓冲 + 多事件 + usage 合并 ──

    #[test]
    fn assembler_buffers_half_lines_and_merges_usage() {
        let mut asm = LineAssembler::new(ProviderKind::Anthropic);
        // 第一块截断在 JSON 中间
        let evs = asm.push(b"data: {\"type\":\"content_block_del");
        assert!(evs.is_empty(), "半行不产出事件");
        let evs = asm.push(b"ta\",\"delta\":{\"text\":\"A\"}}\r\ndata: {\"type\":\"message_start\",\"mess");
        assert_eq!(evs, vec![StreamEvent::Delta("A".into())]);
        let evs = asm.push(
            b"age\":{\"usage\":{\"input_tokens\":9}}}\n\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"B\"}}\n",
        );
        assert_eq!(evs, vec![StreamEvent::Delta("B".into())]);
        let evs = asm.push(b"data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":4}}\n");
        assert!(evs.is_empty(), "Done 只并入累计");
        let fin = asm.finish();
        assert_eq!(fin, vec![StreamEvent::Done { tokens_in: 9, tokens_out: 4 }]);
    }

    #[test]
    fn assembler_openai_multi_event_single_chunk() {
        let mut asm = LineAssembler::new(ProviderKind::OpenAi);
        let body = concat!(
            r#"data: {"choices":[{"delta":{"content":"你"}}]}"#,
            "\n\n",
            r#"data: {"choices":[{"delta":{"content":"好"}}]}"#,
            "\n\n",
            r#"data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}"#,
            "\n\n",
            "data: [DONE]\n\n",
        );
        let evs = asm.push(body.as_bytes());
        assert_eq!(
            evs,
            vec![StreamEvent::Delta("你".into()), StreamEvent::Delta("好".into())]
        );
        assert_eq!(asm.finish(), vec![StreamEvent::Done { tokens_in: 5, tokens_out: 2 }]);
    }

    #[test]
    fn assembler_ollama_without_usage_reports_zero() {
        let mut asm = LineAssembler::new(ProviderKind::Ollama);
        let evs = asm.push(b"{\"message\":{\"content\":\"x\"}}\n{\"done\":true}\n");
        assert_eq!(evs, vec![StreamEvent::Delta("x".into())]);
        assert_eq!(asm.finish(), vec![StreamEvent::Done { tokens_in: 0, tokens_out: 0 }]);
    }

    #[test]
    fn assembler_error_is_forwarded() {
        let mut asm = LineAssembler::new(ProviderKind::OpenAi);
        let evs = asm.push(b"data: {\"error\":{\"message\":\"boom\"}}\n");
        assert_eq!(evs, vec![StreamEvent::Error("boom".into())]);
        let fin = asm.finish();
        assert!(matches!(fin[0], StreamEvent::Error(_)));
    }

    #[test]
    fn assembler_handles_utf8_split_across_chunks() {
        let mut asm = LineAssembler::new(ProviderKind::Ollama);
        let line = "{\"message\":{\"content\":\"深度工作\"}}\n".as_bytes().to_vec();
        let (a, b) = line.split_at(20); // 截在多字节字符中间
        assert!(asm.push(a).is_empty());
        let evs = asm.push(b);
        assert_eq!(evs, vec![StreamEvent::Delta("深度工作".into())]);
    }

    // ── keystore 内存实现 ──

    #[test]
    fn in_memory_keystore_roundtrip() {
        let ks = InMemoryKeyStore::default();
        assert_eq!(ks.get("p1").unwrap(), None);
        ks.set("p1", "sk-xxx").unwrap();
        assert_eq!(ks.get("p1").unwrap(), Some("sk-xxx".into()));
        ks.delete("p1").unwrap();
        assert_eq!(ks.get("p1").unwrap(), None);
        // 删除不存在的键不报错
        ks.delete("p1").unwrap();
    }

    // ── mock 服务器端到端（三 provider）──

    fn tiny_req() -> ChatRequest {
        ChatRequest {
            model: "test-model".into(),
            messages: vec![ChatMessage::system("s"), ChatMessage::user("你好")],
            max_tokens: Some(100),
            temperature: None,
        }
    }

    #[tokio::test]
    async fn openai_stream_end_to_end() {
        let body = concat!(
            r#"data: {"choices":[{"delta":{"content":"你"}}]}"#,
            "\n\n",
            r#"data: {"choices":[{"delta":{"content":"好"}}]}"#,
            "\n\n",
            r#"data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}"#,
            "\n\n",
            "data: [DONE]\n\n",
        )
        .as_bytes()
        .to_vec();
        let port = mock::spawn(body, 7, 0); // 7 字节分块 → 强制半行
        let mut events = Vec::new();
        let out = stream_chat(
            &format!("http://127.0.0.1:{port}"),
            ProviderKind::OpenAi,
            Some("sk-test"),
            &tiny_req(),
            |e| events.push(e),
        )
        .await
        .unwrap();
        assert_eq!(out.text, "你好");
        assert_eq!(out.tokens_in, 12);
        assert_eq!(out.tokens_out, 3);
        assert!(events.iter().any(|e| matches!(e, StreamEvent::Delta(t) if t == "你")));
    }

    #[tokio::test]
    async fn anthropic_stream_end_to_end() {
        let body = concat!(
            r#"event: message_start"#,
            "\n",
            r#"data: {"type":"message_start","message":{"usage":{"input_tokens":25,"output_tokens":1}}}"#,
            "\n\n",
            r#"data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}"#,
            "\n\n",
            r#"data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}"#,
            "\n\n",
            r#"data: {"type":"message_delta","delta":{},"usage":{"output_tokens":15}}"#,
            "\n\n",
            r#"data: {"type":"message_stop"}"#,
            "\n\n",
        )
        .as_bytes()
        .to_vec();
        let port = mock::spawn(body, 11, 0);
        let out = stream_chat(
            &format!("http://127.0.0.1:{port}"),
            ProviderKind::Anthropic,
            Some("ak-test"),
            &tiny_req(),
            |_| {},
        )
        .await
        .unwrap();
        assert_eq!(out.text, "Hello");
        assert_eq!(out.tokens_in, 25);
        assert_eq!(out.tokens_out, 15);
    }

    #[tokio::test]
    async fn ollama_stream_end_to_end() {
        let body = concat!(
            "{\"message\":{\"role\":\"assistant\",\"content\":\"喵\"},\"done\":false}\n",
            "{\"message\":{\"content\":\"呜\"},\"done\":false}\n",
            "{\"message\":{\"content\":\"\"},\"done\":true,\"prompt_eval_count\":7,\"eval_count\":2}\n",
        )
        .as_bytes()
        .to_vec();
        let port = mock::spawn(body, 9, 0);
        let out = stream_chat(
            &format!("http://127.0.0.1:{port}"),
            ProviderKind::Ollama,
            None,
            &tiny_req(),
            |_| {},
        )
        .await
        .unwrap();
        assert_eq!(out.text, "喵呜");
        assert_eq!((out.tokens_in, out.tokens_out), (7, 2));
    }

    #[tokio::test]
    async fn http_error_maps_to_llm_error() {
        let port = mock::spawn_error("HTTP/1.1 401 Unauthorized", r#"{"error":{"message":"bad key"}}"#);
        let err = stream_chat(
            &format!("http://127.0.0.1:{port}"),
            ProviderKind::OpenAi,
            Some("bad"),
            &tiny_req(),
            |_| {},
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("401"), "{err}");
    }

    #[tokio::test]
    async fn stream_error_event_maps_to_llm_error() {
        let body = "data: {\"error\":{\"message\":\"quota exceeded\"}}\n\n".as_bytes().to_vec();
        let port = mock::spawn(body, 16, 0);
        let mut seen = Vec::new();
        let err = stream_chat(
            &format!("http://127.0.0.1:{port}"),
            ProviderKind::OpenAi,
            None,
            &tiny_req(),
            |e| seen.push(e),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("quota"), "{err}");
        assert!(seen.iter().any(|e| matches!(e, StreamEvent::Error(_))));
    }

    #[tokio::test]
    async fn cancel_via_task_abort_stops_stream() {
        // 多个 delta、每块延迟 → 客户端中途 abort
        let mut body = Vec::new();
        for _ in 0..50 {
            body.extend_from_slice(
                "data: {\"choices\":[{\"delta\":{\"content\":\"字\"}}]}\n\n".as_bytes(),
            );
        }
        body.extend_from_slice(b"data: [DONE]\n\n");
        let port = mock::spawn(body, 20, 30);
        let base = format!("http://127.0.0.1:{port}");
        let task = tokio::spawn(async move {
            stream_chat(&base, ProviderKind::OpenAi, None, &tiny_req(), |_| {}).await
        });
        let ah = task.abort_handle();
        // 让流跑起来再取消
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        ah.abort();
        let res = task.await.unwrap_err();
        assert!(res.is_cancelled(), "任务应被取消");
    }

    #[test]
    fn endpoint_joins_correctly() {
        assert_eq!(
            ProviderKind::OpenAi.endpoint("https://api.openai.com/v1/"),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            ProviderKind::Anthropic.endpoint("https://api.anthropic.com"),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            ProviderKind::Ollama.endpoint("http://127.0.0.1:11434/"),
            "http://127.0.0.1:11434/api/chat"
        );
    }
}
