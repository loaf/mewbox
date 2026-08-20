//! AI 编排层（DESIGN §8，M4 T6/T8）：上下文装配、预算检查、精确替换、
//! 异步流式任务 + 留痕。铁律：单次受控调用（无 Agent/循环/后台轮询）、
//! 一切产出先流式预览、采纳才落盘、无状态（上下文仅当次窗口）。
//!
//! 异步与取消（修订决策 1）：ai_run_op 立即返回，任务体内绝不持
//! `Mutex<Index>` 跨 await（索引只在短锁同步段内访问）。
//! 事件出口经 EventSink trait 注入：真实现 tauri::AppHandle，测试录制器。

use std::sync::Arc;
use std::time::Instant;

use base64::Engine as _;

use crate::config::{self, AiBudget, AiConfig, AiProvider};
use crate::index::{AiCall, FileMeta, Scope, SearchHit, UsageRow};
use crate::llm::{self, ChatMessage, ChatRequest, ProviderKind, StreamEvent, VisionPart};
use crate::materials::{self, MaterialSummary};
use crate::prompts::{self, OpParams, Suggestion};
use crate::publish;
use crate::state::{AppError, AppResult, AppState};

// ───── 事件出口 ─────

/// 流事件出口（前端 listen("ai-stream:{call_id}")）。trait 注入 → 测试无需 Tauri 运行时。
pub trait EventSink: Send + Sync {
    fn emit(&self, event: &str, payload: &serde_json::Value);
}

impl EventSink for tauri::AppHandle {
    fn emit(&self, event: &str, payload: &serde_json::Value) {
        let _ = tauri::Emitter::emit(self, event, payload.clone());
    }
}

fn now_ts() -> String {
    chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

fn event_payload(ev: &StreamEvent) -> serde_json::Value {
    match ev {
        StreamEvent::Delta(t) => serde_json::json!({ "kind": "delta", "text": t }),
        StreamEvent::Done { tokens_in, tokens_out } => serde_json::json!({
            "kind": "done", "tokensIn": tokens_in, "tokensOut": tokens_out
        }),
        StreamEvent::Error(m) => serde_json::json!({ "kind": "error", "text": m }),
    }
}

// ───── 上下文装配（修订决策 7：post | material | version）─────

/// 工作台上下文条目（前端混选文稿+资料+发布版本）。
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextEntry {
    /// post | material | version
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// version 专用：母版 id
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    /// version 专用：发布目标
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

impl ContextEntry {
    /// 留痕 target_ids 用：post/material → id；version → base。
    fn target_id(&self) -> Option<String> {
        match self.kind.as_str() {
            "version" => self.base.clone(),
            _ => self.id.clone(),
        }
    }
}

fn attachments_of(extra: &serde_yaml::Mapping) -> Vec<String> {
    extra
        .get(serde_yaml::Value::String("attachments".into()))
        .and_then(|v| v.as_sequence())
        .map(|seq| seq.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

fn media_type(ext: &str) -> Option<&'static str> {
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

fn ext_of(name: &str) -> String {
    name.rsplit('.').next().unwrap_or("").to_ascii_lowercase()
}

/// 单个附件的文本段：pdf 抽取；图片给视觉提示注；其他类型注明不支持。
/// pdf 空文本（扫描件）→ 明确报错（修订决策 9）。
fn attachment_section(ws: &crate::workspace::Workspace, name: &str) -> AppResult<String> {
    let path = ws.root.join("_assets").join(name);
    let bytes = std::fs::read(&path)
        .map_err(|_| AppError::Ai(format!("附件不存在：{name}")))?;
    if ext_of(name) == "pdf" {
        return match pdf_extract::extract_text_from_mem(&bytes) {
            Ok(t) if t.trim().is_empty() => {
                Err(AppError::Ai("未抽取到文本（扫描件暂不支持）".into()))
            }
            Ok(t) => Ok(t),
            Err(e) => Err(AppError::Ai(format!("PDF 解析失败：{e}"))),
        };
    }
    if media_type(&ext_of(name)).is_some() {
        return Ok(format!("（图片附件 {name}：文字内容需视觉模型，请使用「附件描述」）"));
    }
    Ok(format!("（附件 {name}：该类型暂不支持文本抽取）"))
}

/// 上下文装配：多材料以 `## 标题` 分节拼接；资料附件按需附原文。
/// 全程同步短锁（idx 只在查 meta 时短暂持有）。
pub fn load_contexts(
    state: &AppState,
    entries: &[ContextEntry],
    include_attachment_text: bool,
) -> AppResult<String> {
    let mut sections: Vec<String> = Vec::new();
    for e in entries {
        match e.kind.as_str() {
            "post" | "material" => {
                let id = e
                    .id
                    .as_deref()
                    .ok_or_else(|| AppError::Ai(format!("上下文条目（{}）缺少 id", e.kind)))?;
                let meta = state.meta_by_id(id)?;
                let (fm, body, _) = state.read_any(&meta.path)?;
                let mut sec = format!("## {}\n\n{}", fm.title, body);
                if e.kind == "material" && include_attachment_text {
                    for name in attachments_of(&fm.extra) {
                        let text = attachment_section(&state.ws, &name)?;
                        sec.push_str(&format!("\n\n### 附件：{name}\n{text}"));
                    }
                }
                sections.push(sec);
            }
            "version" => {
                let base = e
                    .base
                    .as_deref()
                    .ok_or_else(|| AppError::Ai("版本上下文缺少 base".into()))?;
                let target = e
                    .target
                    .as_deref()
                    .ok_or_else(|| AppError::Ai("版本上下文缺少 target".into()))?;
                let (vfm, body) = publish::read_version_body(&state.ws, base, target)?;
                sections.push(format!("## {}（{target} 版）\n\n{}", vfm.title, body));
            }
            other => return Err(AppError::Ai(format!("未知上下文类型：{other}"))),
        }
    }
    Ok(sections.join("\n\n"))
}

// ───── 精确替换（修订决策 3）─────

/// 采纳结果：成功条目下标（按建议表原顺序）与跳过条目下标（原文已变化 → UI 标灰）。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOutcome {
    pub body: String,
    pub applied: Vec<usize>,
    pub skipped: Vec<usize>,
}

/// 精确替换：先在**当前正文**上找每条「原段」首次出现的位置，
/// 再按位置**从后往前**替换（前面的偏移不受影响）；未命中跳过。
pub fn apply_suggestions(body: &str, items: &[(String, String)]) -> ApplyOutcome {
    let mut hits: Vec<(usize, usize, usize)> = Vec::new(); // (byte_pos, item_idx, orig_len)
    for (i, (orig, _)) in items.iter().enumerate() {
        if orig.is_empty() {
            continue;
        }
        if let Some(pos) = body.find(orig.as_str()) {
            hits.push((pos, i, orig.len()));
        }
    }
    hits.sort_by(|a, b| b.0.cmp(&a.0)); // 降序：从文末往前替换
    let mut out = body.to_string();
    let mut applied = Vec::new();
    for (pos, i, len) in hits {
        out.replace_range(pos..pos + len, items[i].1.as_str());
        applied.push(i);
    }
    applied.sort_unstable();
    let skipped = (0..items.len()).filter(|i| !applied.contains(i)).collect();
    ApplyOutcome { body: out, applied, skipped }
}

// ───── 预算检查（修订决策 6：美分）─────

/// 调用前预算检查：paused 短路；当日/当月已花费超限 → 明确报错。
/// 索引短锁内完成（无 await）。Ollama 单价恒 0，天然不计费。
fn check_budget(state: &AppState, cfg: &AiConfig) -> Result<(), String> {
    if cfg.budget.paused {
        return Err("AI 已暂停（设置 → AI → 预算 → paused）".into());
    }
    if cfg.budget.daily_cents == 0 && cfg.budget.monthly_cents == 0 {
        return Ok(());
    }
    let prices = config::price_map(cfg);
    let now = chrono::Local::now();
    let (day, month) = {
        let idx = state
            .idx
            .lock()
            .map_err(|_| "索引锁中毒".to_string())?;
        let d = idx
            .ai_cents_since(&now.format("%Y-%m-%d").to_string(), &prices)
            .map_err(|e| e.to_string())?;
        let m = idx
            .ai_cents_since(&now.format("%Y-%m").to_string(), &prices)
            .map_err(|e| e.to_string())?;
        (d, m)
    };
    if cfg.budget.daily_cents > 0 && day >= cfg.budget.daily_cents {
        return Err(format!("今日 AI 预算已用尽（{day}/{} 美分）", cfg.budget.daily_cents));
    }
    if cfg.budget.monthly_cents > 0 && month >= cfg.budget.monthly_cents {
        return Err(format!("本月 AI 预算已用尽（{month}/{} 美分）", cfg.budget.monthly_cents));
    }
    Ok(())
}

// ───── 流式任务 ─────

/// run_op 的全部可选输入（owned，随任务移动）。
#[derive(Debug, Default, Clone)]
pub struct RunParams {
    pub custom: Option<String>,
    pub question: Option<String>,
    /// (user, assistant) 交替，仅当次窗口
    pub history: Vec<(String, String)>,
    pub target_lang: Option<String>,
    pub tone: Option<String>,
    pub selection: Option<String>,
    pub include_attachment_text: bool,
}

/// 已组装的提示词（describe_attachment 携带视觉图）。
struct PromptBundle {
    system: String,
    user: String,
    images: Vec<VisionPart>,
}

fn prompt_digest(b: &PromptBundle) -> String {
    let s = format!("{}|{}", b.system, b.user);
    let mut d: String = s.chars().take(100).collect();
    if s.chars().count() > 100 {
        d.push('…');
    }
    d
}

fn record_call(state: &AppState, c: &AiCall) {
    if let Ok(idx) = state.idx.lock() {
        let _ = idx.record_ai_call(c);
    }
}

fn cleanup_task(state: &AppState, call_id: &str) {
    if let Ok(mut map) = state.ai_tasks.lock() {
        map.remove(call_id);
    }
}

/// 失败收尾：错误事件 + 留痕 outcome=error + 任务表清理。
fn ai_fail(
    state: &AppState,
    sink: &dyn EventSink,
    call_id: &str,
    op: &str,
    target_ids: &str,
    digest: &str,
    model: &str,
    provider: &str,
    msg: &str,
) {
    sink.emit(
        &format!("ai-stream:{call_id}"),
        &serde_json::json!({ "kind": "error", "text": msg }),
    );
    record_call(
        state,
        &AiCall {
            id: call_id.to_string(),
            ts: now_ts(),
            op: op.to_string(),
            target_ids: target_ids.to_string(),
            model: model.to_string(),
            provider: provider.to_string(),
            prompt_digest: digest.to_string(),
            note: None,
            tokens_in: 0,
            tokens_out: 0,
            duration_ms: 0,
            outcome: "error".into(),
        },
    );
    cleanup_task(state, call_id);
}

/// 流式主流程：预算 → 路由 → 初始留痕(preview) → 逐跳流式（零增量失败换 fallback）
/// → 成功重记 usage / 全败记 error。事件经 sink 推 ai-stream:{call_id}。
async fn run_stream(
    state: AppState,
    sink: Arc<dyn EventSink>,
    call_id: String,
    op: String,
    target_ids: String,
    bundle: PromptBundle,
) {
    let started = Instant::now();
    let digest = prompt_digest(&bundle);
    let cfg = match config::read_ai(&state.ws) {
        Ok(c) => c,
        Err(e) => return ai_fail(&state, sink.as_ref(), &call_id, &op, &target_ids, &digest, "", "", &e.to_string()),
    };
    if let Err(msg) = check_budget(&state, &cfg) {
        return ai_fail(&state, sink.as_ref(), &call_id, &op, &target_ids, &digest, "", "", &msg);
    }
    let hops = config::resolve_route(&cfg, &op);
    if hops.is_empty() {
        return ai_fail(
            &state, sink.as_ref(), &call_id, &op, &target_ids, &digest, "", "",
            "操作未配置路由（设置 → AI → 路由表）",
        );
    }
    let first = hops[0].clone();
    // 初始留痕：outcome=preview、0 token（取消/错误可在终态前翻转）
    record_call(
        &state,
        &AiCall {
            id: call_id.clone(),
            ts: now_ts(),
            op: op.clone(),
            target_ids: target_ids.clone(),
            model: first.model.clone(),
            provider: first.provider.clone(),
            prompt_digest: digest.clone(),
            note: None,
            tokens_in: 0,
            tokens_out: 0,
            duration_ms: 0,
            outcome: "preview".into(),
        },
    );

    let mut last_err = String::from("无可用路由");
    for hop in &hops {
        let Some(pcfg) = cfg.providers.iter().find(|p: &&AiProvider| p.id == hop.provider) else {
            continue;
        };
        let key = state.keys.get(&hop.provider).ok().flatten();
        let mut req = ChatRequest {
            model: hop.model.clone(),
            messages: vec![ChatMessage::system(bundle.system.clone())],
            max_tokens: None,
            temperature: None,
        };
        req.messages.push(if bundle.images.is_empty() {
            ChatMessage::user(bundle.user.clone())
        } else {
            ChatMessage::user_vision(bundle.user.clone(), bundle.images.clone())
        });
        let sink_hop = Arc::clone(&sink);
        let ev_id = call_id.clone();
        let mut deltas = 0u64;
        let result = llm::stream_chat(&pcfg.base_url, hop.kind, key.as_deref(), &req, |ev| {
            sink_hop.emit(&format!("ai-stream:{ev_id}"), &event_payload(&ev));
            if matches!(ev, StreamEvent::Delta(_)) {
                deltas += 1;
            }
        })
        .await;
        match result {
            Ok(out) => {
                // 成功：重记完整 usage（outcome 保持 preview，等用户采纳/丢弃）
                record_call(
                    &state,
                    &AiCall {
                        id: call_id.clone(),
                        ts: now_ts(),
                        op: op.clone(),
                        target_ids: target_ids.clone(),
                        model: hop.model.clone(),
                        provider: hop.provider.clone(),
                        prompt_digest: digest.clone(),
                        note: None,
                        tokens_in: out.tokens_in,
                        tokens_out: out.tokens_out,
                        duration_ms: started.elapsed().as_millis() as u64,
                        outcome: "preview".into(),
                    },
                );
                cleanup_task(&state, &call_id);
                return;
            }
            Err(e) => {
                last_err = e.to_string();
                // 已有部分输出则不再换路由（前端已渲染半截，重流会重复）
                if deltas > 0 {
                    break;
                }
            }
        }
    }
    ai_fail(
        &state, sink.as_ref(), &call_id, &op, &target_ids, &digest,
        &first.model, &first.provider, &last_err,
    );
}

fn prepare_prompt(
    state: &AppState,
    op: &str,
    entries: &[ContextEntry],
    p: &RunParams,
) -> Result<PromptBundle, String> {
    let context = load_contexts(state, entries, p.include_attachment_text).map_err(|e| e.to_string())?;
    let params = OpParams {
        context: &context,
        selection: p.selection.as_deref(),
        question: p.question.as_deref(),
        history: &p.history,
        target_lang: p.target_lang.as_deref(),
        tone: p.tone.as_deref(),
        custom: p.custom.as_deref(),
    };
    let (system, user) = prompts::build(op, &params)?;
    Ok(PromptBundle { system, user, images: vec![] })
}

fn spawn_ai_task(state: &AppState, call_id: &str, fut: impl std::future::Future<Output = ()> + Send + 'static) {
    let handle = tauri::async_runtime::spawn(fut);
    state
        .ai_tasks
        .lock()
        .unwrap()
        .insert(call_id.to_string(), handle.inner().abort_handle());
}

// ───── AppState AI 方法（commands 薄封装）─────

impl AppState {
    /// 发起 AI 操作：spawn 后立即返回；结果经 `ai-stream:{call_id}` 事件流式推送，
    /// 留痕 outcome 初值 preview。call_id 由前端生成（uuid）。
    pub fn ai_run_op(
        &self,
        sink: Arc<dyn EventSink>,
        call_id: &str,
        op: &str,
        entries: &[ContextEntry],
        params: RunParams,
    ) -> AppResult<()> {
        if !prompts::OPS.contains(&op) {
            return Err(AppError::Ai(format!("未知 AI 操作：{op}")));
        }
        let st = self.clone();
        let sink_run = Arc::clone(&sink);
        let call_id_run = call_id.to_string();
        let op_owned = op.to_string();
        let entries = entries.to_vec();
        let run = params;
        let target_ids = serde_json::to_string(
            &entries.iter().filter_map(|e| e.target_id()).collect::<Vec<_>>(),
        )
        .unwrap_or_else(|_| "[]".into());
        let register_id = call_id_run.clone();
        let fut = async move {
            let bundle = match prepare_prompt(&st, &op_owned, &entries, &run) {
                Ok(b) => b,
                Err(msg) => {
                    ai_fail(&st, sink_run.as_ref(), &call_id_run, &op_owned, &target_ids, "", "", "", &msg);
                    return;
                }
            };
            run_stream(st, sink_run, call_id_run, op_owned, target_ids, bundle).await;
        };
        spawn_ai_task(self, &register_id, fut);
        Ok(())
    }

    /// 取消进行中的调用：abort + 留痕 cancelled + 错误事件（已结束的调用为无操作）。
    pub fn ai_cancel(&self, sink: &dyn EventSink, call_id: &str) -> AppResult<()> {
        let handle = self
            .ai_tasks
            .lock()
            .map_err(|_| AppError::NotFound("AI 任务表锁中毒".into()))?
            .remove(call_id);
        if let Some(h) = handle {
            h.abort();
            let _ = self.with_idx(|idx| Ok(idx.update_ai_outcome(call_id, "cancelled", None)?));
            sink.emit(
                &format!("ai-stream:{call_id}"),
                &serde_json::json!({ "kind": "error", "text": "已取消" }),
            );
        }
        Ok(())
    }

    /// 采纳结果（outcome=adopted；批量润色/查错整体记一次，采纳计数写入 note）。
    pub fn ai_adopt_result(&self, call_id: &str, note: Option<&str>) -> AppResult<()> {
        self.with_idx(|idx| Ok(idx.update_ai_outcome(call_id, "adopted", note)?))
    }

    /// 丢弃结果（outcome=discarded）。
    pub fn ai_discard_result(&self, call_id: &str) -> AppResult<()> {
        self.with_idx(|idx| Ok(idx.update_ai_outcome(call_id, "discarded", None)?))
    }

    /// 结果存为资料：kb/Inbox 新建容器，extra 标 `source: ai-workbench` +
    /// `generated_from: [源对象 id]`；可选逐个建立关联；outcome=saved。
    pub fn ai_save_as_material(
        &self,
        call_id: &str,
        title: &str,
        body: &str,
        source_ids: &[String],
        assoc_ids: &[String],
    ) -> AppResult<MaterialSummary> {
        let (mut fm, rel) = materials::create_material(&self.ws, title, "kb/Inbox")?;
        fm.sparse = true;
        fm.extra.insert(
            serde_yaml::Value::String("source".into()),
            serde_yaml::Value::String("ai-workbench".into()),
        );
        fm.extra.insert(
            serde_yaml::Value::String("generated_from".into()),
            serde_yaml::Value::Sequence(
                source_ids.iter().map(|s| serde_yaml::Value::String(s.clone())).collect(),
            ),
        );
        materials::write_material(&self.ws, &rel, &fm, body)?;
        let m = FileMeta {
            id: fm.id.to_string(),
            kind: "material".into(),
            path: rel.clone(),
            title: fm.title.clone(),
            folder: materials::folder_of(&rel),
            status: "draft".into(),
            tags: "[]".into(),
            created_at: fm.created.clone(),
            updated_at: fm.updated.clone(),
            deleted_at: None,
            hash: String::new(),
            missing: false,
        };
        self.with_idx(|idx| Ok(idx.upsert_file(&m, body)?))?;
        for id in assoc_ids {
            self.update_assoc(&fm.id.to_string(), id, true)?;
        }
        self.with_idx(|idx| Ok(idx.update_ai_outcome(call_id, "saved", None)?))?;
        Ok(MaterialSummary {
            id: fm.id.to_string(),
            title: fm.title.clone(),
            path: rel,
            folder: m.folder,
            updated_at: fm.updated.clone(),
        })
    }

    /// 附件描述（pdf 文本 / 图片视觉）：流式推送，留痕 op=describe_attachment。
    pub fn ai_describe_attachment(
        &self,
        sink: Arc<dyn EventSink>,
        call_id: &str,
        material_id: &str,
        attachment: &str,
    ) -> AppResult<()> {
        let meta = self.meta_by_id(material_id)?;
        let (fm, _, _) = self.read_any(&meta.path)?;
        if !attachments_of(&fm.extra).iter().any(|n| n == attachment) {
            return Err(AppError::Ai(format!("资料没有附件 {attachment}")));
        }
        let bytes = std::fs::read(self.ws.root.join("_assets").join(attachment))?;
        let (context, images) = if ext_of(attachment) == "pdf" {
            match pdf_extract::extract_text_from_mem(&bytes) {
                Ok(t) if t.trim().is_empty() => {
                    return Err(AppError::Ai("未抽取到文本（扫描件暂不支持）".into()))
                }
                Ok(t) => (t, vec![]),
                Err(e) => return Err(AppError::Ai(format!("PDF 解析失败：{e}"))),
            }
        } else if let Some(mt) = media_type(&ext_of(attachment)) {
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            (String::new(), vec![VisionPart { b64, media_type: mt.into() }])
        } else {
            return Err(AppError::Ai("该附件类型不支持描述（支持 pdf 与图片）".into()));
        };
        let (system, user) = prompts::build(
            "describe_attachment",
            &OpParams { context: &context, ..Default::default() },
        )
        .map_err(AppError::Ai)?;
        let bundle = PromptBundle { system, user, images };
        let st = self.clone();
        let call_id_run = call_id.to_string();
        let target_ids =
            serde_json::to_string(&[material_id]).unwrap_or_else(|_| "[]".into());
        let register_id = call_id_run.clone();
        let fut = async move {
            run_stream(
                st,
                sink,
                call_id_run,
                "describe_attachment".into(),
                target_ids,
                bundle,
            )
            .await;
        };
        spawn_ai_task(self, &register_id, fut);
        Ok(())
    }

    /// 连接测试：1-token ping（不入流事件；结果直接返回；留痕 op=test_connection）。
    pub async fn ai_test_connection(&self, provider_id: &str) -> AppResult<ConnectionTest> {
        let cfg = config::read_ai(&self.ws)?;
        let p = cfg
            .providers
            .iter()
            .find(|p| p.id == provider_id)
            .ok_or_else(|| AppError::Ai(format!("找不到 provider {provider_id}")))?;
        let kind = ProviderKind::from_type(&p.ptype)
            .ok_or_else(|| AppError::Ai(format!("未知 provider 类型：{}", p.ptype)))?;
        let key = self.keys.get(provider_id).map_err(AppError::Ai)?;
        // 云端 provider 缺密钥时明确报错，而不是裸发请求吃一个难懂的 401
        if kind != ProviderKind::Ollama && key.as_deref().map_or(true, |k| k.trim().is_empty()) {
            return Err(AppError::Ai(
                "尚未保存 API 密钥——请先在密钥框输入并保存，再测试连接".into(),
            ));
        }
        let req = ChatRequest {
            model: p.model.clone(),
            messages: vec![ChatMessage::user("ping")],
            max_tokens: Some(1),
            temperature: None,
        };
        let started = Instant::now();
        let outcome = llm::stream_chat(&p.base_url, kind, key.as_deref(), &req, |_| {}).await;
        let (ok, message, tin, tout, row_outcome) = match &outcome {
            Ok(o) => (
                true,
                format!("连接成功（{}，回复 {} 字符）", p.model, o.text.trim().len()),
                o.tokens_in,
                o.tokens_out,
                "preview",
            ),
            Err(e) => (false, e.to_string(), 0, 0, "error"),
        };
        record_call(
            self,
            &AiCall {
                id: uuid::Uuid::new_v4().to_string(),
                ts: now_ts(),
                op: "test_connection".into(),
                target_ids: format!("[\"{provider_id}\"]"),
                model: p.model.clone(),
                provider: p.id.clone(),
                prompt_digest: "1-token ping".into(),
                note: None,
                tokens_in: tin,
                tokens_out: tout,
                duration_ms: started.elapsed().as_millis() as u64,
                outcome: row_outcome.into(),
            },
        );
        Ok(ConnectionTest { ok, message, tokens_in: tin, tokens_out: tout })
    }

    // ───── 配置 / 钥匙串 / 用量（薄封装）─────

    pub fn ai_list_providers(&self) -> AppResult<AiConfig> {
        Ok(config::read_ai(&self.ws)?)
    }

    pub fn ai_save_provider(&self, provider: &AiProvider) -> AppResult<()> {
        Ok(config::save_provider(&self.ws, provider)?)
    }

    pub fn ai_delete_provider(&self, id: &str) -> AppResult<()> {
        Ok(config::delete_provider(&self.ws, id)?)
    }

    pub fn ai_save_ai_config(
        &self,
        routes: &std::collections::BTreeMap<String, String>,
        fallbacks: &std::collections::BTreeMap<String, String>,
        budget: AiBudget,
    ) -> AppResult<()> {
        Ok(config::save_ai_config(&self.ws, routes, fallbacks, budget)?)
    }

    pub fn ai_set_key(&self, provider_id: &str, key: &str) -> AppResult<()> {
        // 粘贴常带首尾空白/换行，原样发送会被拒（验收反馈：DeepSeek 401）
        self.keys.set(provider_id, key.trim()).map_err(AppError::Ai)
    }

    pub fn ai_has_key(&self, provider_id: &str) -> AppResult<bool> {
        Ok(self.keys.get(provider_id).map_err(AppError::Ai)?.is_some())
    }

    pub fn ai_delete_key(&self, provider_id: &str) -> AppResult<()> {
        self.keys.delete(provider_id).map_err(AppError::Ai)
    }

    /// 用量聚合（month_scope=true 按月，否则按日）。
    pub fn ai_usage(&self, month_scope: bool) -> AppResult<Vec<UsageRow>> {
        let cfg = config::read_ai(&self.ws)?;
        let prices = config::price_map(&cfg);
        self.with_idx(|idx| Ok(idx.usage_stats(month_scope, &prices)?))
    }

    /// 一键清空留痕（§8.5）。
    pub fn ai_clear_calls(&self) -> AppResult<()> {
        self.with_idx(|idx| Ok(idx.clear_ai_calls()?))
    }

    /// 快捷搜索资料（Scope::Materials，仅 kind=material）。
    pub fn ai_search_materials(&self, query: &str) -> AppResult<Vec<SearchHit>> {
        self.with_idx(|idx| Ok(idx.search(query, Scope::Materials)?))
    }

    /// 润色/查错通用精确替换（修订决策 3；采纳计数由前端另记 note）。
    pub fn ai_apply_suggestions(&self, body: &str, items: &[Suggestion]) -> AppResult<ApplyOutcome> {
        let pairs: Vec<(String, String)> =
            items.iter().map(|s| (s.original.clone(), s.revised.clone())).collect();
        Ok(apply_suggestions(body, &pairs))
    }
}

/// 连接测试结果。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTest {
    pub ok: bool,
    pub message: String,
    pub tokens_in: u64,
    pub tokens_out: u64,
}

// ───── 测试 ─────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::Index;
    use crate::llm::mock;
    use crate::state::AppState;
    use crate::workspace::Workspace;
    use std::collections::HashMap;
    use std::sync::Mutex;

    fn state() -> (tempfile::TempDir, AppState) {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::init(dir.path()).unwrap();
        let state = AppState {
            keys: Arc::new(crate::llm::InMemoryKeyStore::default()),
            idx: Arc::new(Mutex::new(Index::open_in_memory().unwrap())),
            ai_tasks: Arc::new(Mutex::new(HashMap::new())),
            ws,
        };
        (dir, state)
    }

    fn provider(port: u16) -> AiProvider {
        AiProvider {
            id: "cloud".into(),
            ptype: "openai".into(),
            base_url: format!("http://127.0.0.1:{port}"),
            model: "test-model".into(),
            max_context: None,
            price_per_1k_in_cents: None,
            price_per_1k_out_cents: None,
        }
    }

    fn route_only(st: &AppState, op: &str) {
        let mut routes = std::collections::BTreeMap::new();
        routes.insert(op.to_string(), "cloud".to_string());
        config::save_ai_config(&st.ws, &routes, &Default::default(), AiBudget::default()).unwrap();
    }

    #[test]
    fn set_key_trims_whitespace() {
        let (_d, st) = state();
        st.ai_set_key("cloud", "  sk-abc\n").unwrap();
        assert_eq!(st.keys.get("cloud").unwrap().as_deref(), Some("sk-abc"));
    }

    #[tokio::test]
    async fn test_connection_missing_key_gives_clear_error() {
        let (_d, st) = state();
        let p = provider(1);
        config::save_provider(&st.ws, &p).unwrap();
        let err = st.ai_test_connection("cloud").await.unwrap_err();
        assert!(err.to_string().contains("尚未保存 API 密钥"), "{err}");
        // ollama 无密钥不拦（连接失败但不是密钥错误）
        let mut local = p.clone();
        local.id = "local".into();
        local.ptype = "ollama".into();
        local.base_url = "http://127.0.0.1:9".into();
        config::save_provider(&st.ws, &local).unwrap();
        let res = st.ai_test_connection("local").await;
        let msg = res.map(|c| c.message).unwrap_or_else(|e| e.to_string());
        assert!(!msg.contains("尚未保存"), "{msg}");
    }

    /// 录制式事件出口（测试替代 AppHandle）。
    struct RecordingSink(Mutex<Vec<(String, serde_json::Value)>>);

    impl RecordingSink {
        fn new() -> Self {
            Self(Mutex::new(Vec::new()))
        }
        fn payloads(&self, call_id: &str) -> Vec<serde_json::Value> {
            self.0
                .lock()
                .unwrap()
                .iter()
                .filter(|(e, _)| e == &format!("ai-stream:{call_id}"))
                .map(|(_, p)| p.clone())
                .collect()
        }
        fn deltas_text(&self, call_id: &str) -> String {
            self.payloads(call_id)
                .iter()
                .filter(|p| p["kind"] == "delta")
                .filter_map(|p| p["text"].as_str())
                .collect()
        }
        /// 等待终态事件 + 任务表清空（AI 任务收尾含留痕写在事件之后）。
        fn wait_terminal(&self, st: &AppState, call_id: &str) -> bool {
            for _ in 0..600 {
                let terminal = self
                    .payloads(call_id)
                    .iter()
                    .any(|p| p["kind"] == "done" || p["kind"] == "error");
                let drained =
                    !st.ai_tasks.lock().unwrap().contains_key(call_id);
                if terminal && drained {
                    return true;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            false
        }
        fn wait_kind(&self, call_id: &str, kind: &str) -> bool {
            for _ in 0..600 {
                if self.payloads(call_id).iter().any(|p| p["kind"] == kind) {
                    return true;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            false
        }
    }

    impl EventSink for RecordingSink {
        fn emit(&self, event: &str, payload: &serde_json::Value) {
            self.0.lock().unwrap().push((event.to_string(), payload.clone()));
        }
    }

    fn openai_sse() -> Vec<u8> {
        concat!(
            r#"data: {"choices":[{"delta":{"content":"总"}}]}"#,
            "\n\n",
            r#"data: {"choices":[{"delta":{"content":"结"}}]}"#,
            "\n\n",
            r#"data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}"#,
            "\n\n",
            "data: [DONE]\n\n",
        )
        .as_bytes()
        .to_vec()
    }

    // ── 精确替换 ──

    #[test]
    fn apply_suggestions_descending_and_out_of_order() {
        let body = "第一段甲。中间乙。第二段丙。";
        // 列表乱序给出，且换文长度不同
        let items = vec![
            ("第二段丙".to_string(), "结尾改写".to_string()),
            ("第一段甲".to_string(), "开头改写后的长文字".to_string()),
        ];
        let out = apply_suggestions(body, &items);
        assert_eq!(out.body, "开头改写后的长文字。中间乙。结尾改写。");
        assert_eq!(out.applied, vec![0, 1]);
        assert!(out.skipped.is_empty());
    }

    #[test]
    fn apply_suggestions_no_match_skipped_and_first_occurrence() {
        let body = "重复词与重复词。";
        let items = vec![
            ("不存在的原段".to_string(), "x".to_string()),
            ("重复词".to_string(), "唯一".to_string()),
        ];
        let out = apply_suggestions(body, &items);
        assert_eq!(out.body, "唯一与重复词。", "多处命中取第一处");
        assert_eq!(out.applied, vec![1]);
        assert_eq!(out.skipped, vec![0], "未命中条目标灰");
    }

    // ── 上下文装配 ──

    /// 生成带正确 xref 偏移的最小单页 PDF（内容 = text；Type1+WinAnsi 才能被抽取）。
    fn mini_pdf(text: &str) -> Vec<u8> {
        let content = format!("BT /F1 24 Tf 72 700 Td ({text}) Tj ET");
        let objs = vec![
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>".to_string(),
            format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".to_string(),
        ];
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (i, obj) in objs.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend_from_slice(format!("{} 0 obj\n{obj}\nendobj\n", i + 1).as_bytes());
        }
        let xref = pdf.len();
        pdf.extend_from_slice(format!("xref\n0 {}\n", objs.len() + 1).as_bytes());
        pdf.extend_from_slice(b"0000000000 65535 f \n");
        for off in offsets {
            pdf.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
        }
        pdf.extend_from_slice(
            format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objs.len() + 1)
                .as_bytes(),
        );
        pdf
    }

    #[test]
    fn load_contexts_post_material_version_and_attachments() {
        let (_d, st) = state();
        let p = st.create_post("深度工作", None).unwrap();
        st.save_post(&p.id, "文稿正文").unwrap();
        let m = st.create_material("研究笔记", "研究").unwrap();
        // 资料挂两个附件：真 pdf + 图片
        let (_, pdf_name) = crate::assets::save_asset(&st.ws, &mini_pdf("PDF EXTRACT TEXT"), "pdf").unwrap();
        let (_, img_name) = crate::assets::save_asset(&st.ws, b"fake-png", "png").unwrap();
        let m_path = st.ws.root.join(st.read_material(&m.id).unwrap().path);
        let (fm, body, _) = st.read_any(&st.read_material(&m.id).unwrap().path).unwrap();
        let mut fm = fm;
        fm.extra.insert(
            serde_yaml::Value::String("attachments".into()),
            serde_yaml::Value::Sequence(vec![
                serde_yaml::Value::String(pdf_name.clone()),
                serde_yaml::Value::String(img_name.clone()),
            ]),
        );
        std::fs::write(
            &m_path,
            fm.to_content(&body),
        )
        .unwrap();
        let _ = m;
        st.create_publish_version(&p.id, "wechat", None, Some("版本正文".into())).unwrap();

        let entries = vec![
            ContextEntry { kind: "post".into(), id: Some(p.id.clone()), ..Default::default() },
            ContextEntry { kind: "material".into(), id: Some(m.id.clone()), ..Default::default() },
            ContextEntry {
                kind: "version".into(),
                base: Some(p.id.clone()),
                target: Some("wechat".into()),
                ..Default::default()
            },
        ];
        let ctx = load_contexts(&st, &entries, true).unwrap();
        assert!(ctx.contains("## 深度工作"), "{ctx}");
        assert!(ctx.contains("文稿正文"));
        assert!(ctx.contains("### 附件："), "{ctx}");
        assert!(ctx.contains("PDF EXTRACT TEXT"), "pdf 抽取文本入上下文: {ctx}");
        assert!(ctx.contains("图片附件"), "图片给视觉提示注: {ctx}");
        assert!(ctx.contains("（wechat 版）"), "{ctx}");
        assert!(ctx.contains("版本正文"));
        // 不含附件原文时：无附件小节
        let ctx2 = load_contexts(&st, &entries, false).unwrap();
        assert!(!ctx2.contains("### 附件："));
    }

    #[test]
    fn load_contexts_scanned_pdf_errors_clearly() {
        let (_d, st) = state();
        let m = st.create_material("扫描件", "").unwrap();
        // 空正文页的合法 pdf（有结构但无文本）
        let (_, name) = crate::assets::save_asset(&st.ws, &mini_pdf(""), "pdf").unwrap();
        let path = st.ws.root.join(st.read_material(&m.id).unwrap().path);
        let (mut fm, body, _) = st.read_any(&st.read_material(&m.id).unwrap().path).unwrap();
        fm.extra.insert(
            serde_yaml::Value::String("attachments".into()),
            serde_yaml::Value::Sequence(vec![serde_yaml::Value::String(name)]),
        );
        std::fs::write(&path, fm.to_content(&body)).unwrap();
        let entries = vec![ContextEntry { kind: "material".into(), id: Some(m.id.clone()), ..Default::default() }];
        let err = load_contexts(&st, &entries, true).unwrap_err();
        assert!(err.to_string().contains("未抽取到文本"), "{err}");
        // 未知类型
        let err2 = load_contexts(
            &st,
            &[ContextEntry { kind: "ghost".into(), ..Default::default() }],
            false,
        )
        .unwrap_err();
        assert!(err2.to_string().contains("未知上下文类型"), "{err2}");
    }

    // ── 流式编排 ──

    #[test]
    fn run_op_streams_and_records_preview() {
        let (_d, st) = state();
        let port = mock::spawn(openai_sse(), 7, 0);
        config::save_provider(&st.ws, &provider(port)).unwrap();
        route_only(&st, "summarize");
        let p = st.create_post("深度工作", None).unwrap();
        st.save_post(&p.id, "材料正文内容").unwrap();

        let sink = Arc::new(RecordingSink::new());
        let entries = vec![ContextEntry { kind: "post".into(), id: Some(p.id.clone()), ..Default::default() }];
        st.ai_run_op(
            Arc::clone(&sink) as Arc<dyn EventSink>,
            "call-1",
            "summarize",
            &entries,
            RunParams::default(),
        )
        .unwrap();
        assert!(sink.wait_terminal(&st, "call-1"), "任务应到达终态");
        assert_eq!(sink.deltas_text("call-1"), "总结", "增量按序合并");
        let done = sink
            .payloads("call-1")
            .into_iter()
            .find(|p| p["kind"] == "done")
            .expect("done 事件");
        assert_eq!(done["tokensIn"], 12);
        assert_eq!(done["tokensOut"], 3);
        let row = st.idx.lock().unwrap().ai_call_outcome("call-1").unwrap().unwrap();
        assert_eq!(row.0, "preview");
        assert_eq!((row.1, row.2), (12, 3));
    }

    #[test]
    fn run_op_paused_budget_and_missing_route_error_events() {
        let (_d, st) = state();
        let port = mock::spawn(openai_sse(), 7, 0);
        config::save_provider(&st.ws, &provider(port)).unwrap();
        route_only(&st, "summarize");

        // 未配置路由的操作
        let sink = Arc::new(RecordingSink::new());
        st.ai_run_op(
            Arc::clone(&sink) as Arc<dyn EventSink>,
            "call-route",
            "translate",
            &[],
            RunParams { target_lang: Some("英文".into()), ..Default::default() },
        )
        .unwrap();
        assert!(sink.wait_terminal(&st, "call-route"));
        let err = sink.payloads("call-route").into_iter().find(|p| p["kind"] == "error").unwrap();
        assert!(err["text"].as_str().unwrap().contains("路由"), "{}", err["text"]);
        assert_eq!(
            st.idx.lock().unwrap().ai_call_outcome("call-route").unwrap().unwrap().0,
            "error"
        );

        // paused 短路
        let mut routes = std::collections::BTreeMap::new();
        routes.insert("summarize".to_string(), "cloud".to_string());
        config::save_ai_config(
            &st.ws,
            &routes,
            &Default::default(),
            AiBudget { daily_cents: 0, monthly_cents: 0, paused: true },
        )
        .unwrap();
        let sink2 = Arc::new(RecordingSink::new());
        st.ai_run_op(
            Arc::clone(&sink2) as Arc<dyn EventSink>,
            "call-paused",
            "summarize",
            &[],
            RunParams::default(),
        )
        .unwrap();
        assert!(sink2.wait_terminal(&st, "call-paused"));
        let err2 = sink2.payloads("call-paused").into_iter().find(|p| p["kind"] == "error").unwrap();
        assert!(err2["text"].as_str().unwrap().contains("暂停"), "{}", err2["text"]);

        // 未知操作同步报错
        assert!(st.ai_run_op(Arc::clone(&sink2) as Arc<dyn EventSink>, "c", "ghost", &[], RunParams::default()).is_err());
    }

    #[test]
    fn run_op_cancel_mid_stream_records_cancelled() {
        let (_d, st) = state();
        let mut body = Vec::new();
        for _ in 0..80 {
            body.extend_from_slice(
                "data: {\"choices\":[{\"delta\":{\"content\":\"字\"}}]}\n\n".as_bytes(),
            );
        }
        body.extend_from_slice(b"data: [DONE]\n\n");
        let port = mock::spawn(body, 20, 25); // 每块 25ms → 足够窗口中途取消
        config::save_provider(&st.ws, &provider(port)).unwrap();
        route_only(&st, "summarize");

        let sink = Arc::new(RecordingSink::new());
        st.ai_run_op(
            Arc::clone(&sink) as Arc<dyn EventSink>,
            "call-c",
            "summarize",
            &[],
            RunParams::default(),
        )
        .unwrap();
        assert!(sink.wait_kind("call-c", "delta"), "流应已开始");
        st.ai_cancel(&*sink, "call-c").unwrap();
        // 取消事件立即发出
        let cancelled = sink
            .payloads("call-c")
            .into_iter()
            .find(|p| p["kind"] == "error")
            .expect("取消事件");
        assert_eq!(cancelled["text"], "已取消");
        // 留痕翻转 cancelled（任务 abort 后不再自行收尾）
        for _ in 0..100 {
            if let Some((outcome, _, _)) = st.idx.lock().unwrap().ai_call_outcome("call-c").unwrap() {
                if outcome == "cancelled" {
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(
            st.idx.lock().unwrap().ai_call_outcome("call-c").unwrap().unwrap().0,
            "cancelled"
        );
        assert!(!st.ai_tasks.lock().unwrap().contains_key("call-c"));
        // 再次取消（已结束）为无操作
        st.ai_cancel(&*sink, "call-c").unwrap();
    }

    #[test]
    fn run_op_falls_back_when_primary_fails_before_output() {
        let (_d, st) = state();
        let bad = mock::spawn_error("HTTP/1.1 500 Server Error", r#"{"error":{"message":"down"}}"#);
        let good = mock::spawn(openai_sse(), 7, 0);
        config::save_provider(&st.ws, &provider(bad)).unwrap();
        let mut ok_provider = provider(good);
        ok_provider.id = "backup".into();
        config::save_provider(&st.ws, &ok_provider).unwrap();
        let mut routes = std::collections::BTreeMap::new();
        routes.insert("summarize".to_string(), "cloud".to_string());
        let mut fallbacks = std::collections::BTreeMap::new();
        fallbacks.insert("summarize".to_string(), "backup".to_string());
        config::save_ai_config(&st.ws, &routes, &fallbacks, AiBudget::default()).unwrap();

        let sink = Arc::new(RecordingSink::new());
        st.ai_run_op(
            Arc::clone(&sink) as Arc<dyn EventSink>,
            "call-fb",
            "summarize",
            &[],
            RunParams::default(),
        )
        .unwrap();
        assert!(sink.wait_terminal(&st, "call-fb"));
        assert_eq!(sink.deltas_text("call-fb"), "总结", "主路由 500 → fallback 接管");
        let row = st.idx.lock().unwrap().ai_call_outcome("call-fb").unwrap().unwrap();
        assert_eq!(row.0, "preview");
    }

    // ── 结果去向 ──

    #[test]
    fn adopt_discard_outcome_transitions() {
        let (_d, st) = state();
        let row = AiCall {
            id: "c1".into(),
            ts: now_ts(),
            op: "summarize".into(),
            target_ids: "[]".into(),
            model: "m".into(),
            provider: "p".into(),
            prompt_digest: "d".into(),
            note: None,
            tokens_in: 1,
            tokens_out: 1,
            duration_ms: 5,
            outcome: "preview".into(),
        };
        st.idx.lock().unwrap().record_ai_call(&row).unwrap();
        st.ai_adopt_result("c1", Some("采纳 3/5 条")).unwrap();
        assert_eq!(st.idx.lock().unwrap().ai_call_outcome("c1").unwrap().unwrap().0, "adopted");
        // 终态不可逆
        st.ai_discard_result("c1").unwrap();
        assert_eq!(st.idx.lock().unwrap().ai_call_outcome("c1").unwrap().unwrap().0, "adopted");
    }

    #[test]
    fn save_as_material_creates_container_with_source_and_assoc() {
        let (_d, st) = state();
        let p = st.create_post("深度工作", None).unwrap();
        st.idx.lock().unwrap().record_ai_call(&AiCall {
            id: "call-s".into(),
            ts: now_ts(),
            op: "summarize".into(),
            target_ids: "[]".into(),
            model: "m".into(),
            provider: "p".into(),
            prompt_digest: "d".into(),
            note: None,
            tokens_in: 0,
            tokens_out: 0,
            duration_ms: 0,
            outcome: "preview".into(),
        })
        .unwrap();
        let summary = st
            .ai_save_as_material("call-s", "AI 总结：深度工作", "总结正文", &[p.id.clone()], &[p.id.clone()])
            .unwrap();
        assert!(summary.path.starts_with("kb/Inbox/"), "{}", summary.path);
        let content = std::fs::read_to_string(st.ws.root.join(&summary.path)).unwrap();
        assert!(content.contains("source: ai-workbench"), "{content}");
        assert!(content.contains("generated_from:"), "{content}");
        assert!(content.contains(&p.id), "{content}");
        assert!(content.contains("总结正文"));
        // 关联双侧建立
        let pc = st.read_post(&p.id).unwrap();
        assert_eq!(pc.assoc.as_ref().unwrap().materials.len(), 1);
        // 留痕 → saved
        assert_eq!(st.idx.lock().unwrap().ai_call_outcome("call-s").unwrap().unwrap().0, "saved");
    }

    // ── 附件描述 ──

    #[test]
    fn describe_attachment_pdf_and_missing_name() {
        let (_d, st) = state();
        let port = mock::spawn(openai_sse(), 7, 0);
        config::save_provider(&st.ws, &provider(port)).unwrap();
        route_only(&st, "describe_attachment");
        let m = st.create_material("论文卡片", "").unwrap();
        let (_, name) = crate::assets::save_asset(&st.ws, &mini_pdf("附件论文正文"), "pdf").unwrap();
        let path = st.ws.root.join(st.read_material(&m.id).unwrap().path);
        let (mut fm, body, _) = st.read_any(&st.read_material(&m.id).unwrap().path).unwrap();
        fm.extra.insert(
            serde_yaml::Value::String("attachments".into()),
            serde_yaml::Value::Sequence(vec![serde_yaml::Value::String(name.clone())]),
        );
        std::fs::write(&path, fm.to_content(&body)).unwrap();

        // 不在附件表中的名字 → Err
        assert!(st.ai_describe_attachment(Arc::new(NoopSink), "c-x", &m.id, "ghost.pdf").is_err());

        let sink = Arc::new(RecordingSink::new());
        st.ai_describe_attachment(
            Arc::clone(&sink) as Arc<dyn EventSink>,
            "call-d",
            &m.id,
            &name,
        )
        .unwrap();
        assert!(sink.wait_terminal(&st, "call-d"));
        assert_eq!(sink.deltas_text("call-d"), "总结");
        let row = st.idx.lock().unwrap().ai_call_outcome("call-d").unwrap().unwrap();
        assert_eq!(row.0, "preview");
    }

    struct NoopSink;
    impl EventSink for NoopSink {
        fn emit(&self, _e: &str, _p: &serde_json::Value) {}
    }

    // ── 连接测试 / 钥匙串 / 用量 / 搜索 ──

    #[tokio::test]
    async fn test_connection_ok_and_failure() {
        let (_d, st) = state();
        st.ai_set_key("cloud", "sk-test").unwrap();
        st.ai_set_key("bad", "sk-bad").unwrap();
        let good = mock::spawn(openai_sse(), 7, 0);
        config::save_provider(&st.ws, &provider(good)).unwrap();
        let ok = st.ai_test_connection("cloud").await.unwrap();
        assert!(ok.ok, "{}", ok.message);
        assert_eq!(ok.tokens_in, 12);

        let bad = mock::spawn_error("HTTP/1.1 401 Unauthorized", r#"{"error":{"message":"bad key"}}"#);
        let mut bad_p = provider(bad);
        bad_p.id = "bad".into();
        config::save_provider(&st.ws, &bad_p).unwrap();
        let fail = st.ai_test_connection("bad").await.unwrap();
        assert!(!fail.ok);
        assert!(fail.message.contains("401"), "{}", fail.message);
        assert!(st.ai_test_connection("ghost").await.is_err());
    }

    #[test]
    fn key_store_and_usage_and_material_search() {
        let (_d, st) = state();
        assert!(!st.ai_has_key("cloud").unwrap());
        st.ai_set_key("cloud", "sk-test").unwrap();
        assert!(st.ai_has_key("cloud").unwrap());
        st.ai_delete_key("cloud").unwrap();
        assert!(!st.ai_has_key("cloud").unwrap());

        // 用量与清空
        st.ai_usage(false).unwrap();
        st.ai_clear_calls().unwrap();

        // 资料搜索（Scope::Materials）
        let p = st.create_post("正文文稿", None).unwrap();
        st.save_post(&p.id, "独有词条").unwrap();
        let m = st.create_material("资料一", "").unwrap();
        st.save_material(&m.id, "独有词条的资料版").unwrap();
        let hits = st.ai_search_materials("独有词条").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, m.id);
    }
}
