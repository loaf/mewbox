//! config.toml：发布目标注册表（便利设施，不强制；DESIGN §5.1）
//! + [ai] 段（providers/路由/fallback/预算，DESIGN §8）。
//! 密钥永不写入 config（走钥匙串）。

use std::collections::BTreeMap;
use std::collections::HashMap;

use crate::llm::ProviderKind;
use crate::workspace::Workspace;

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("toml: {0}")]
    Toml(#[from] toml::ser::Error),
    #[error("toml 解析: {0}")]
    Parse(String),
    #[error("目标「{0}」已存在")]
    DuplicateTarget(String),
    #[error("目标 id 只允许小写字母、数字、- 与 _：{0}")]
    InvalidId(String),
    #[error("provider 配置无效：{0}")]
    InvalidProvider(String),
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishTarget {
    pub id: String,
    pub display: String,
    pub note: String,
}

fn read_doc(ws: &Workspace) -> Result<toml::Value, ConfigError> {
    let path = ws.root.join("config.toml");
    let raw = std::fs::read_to_string(&path).unwrap_or_default();
    toml::from_str(&raw)
        .map_err(|e| ConfigError::Parse(e.to_string()))
}

fn write_doc(ws: &Workspace, doc: &toml::Value) -> Result<(), ConfigError> {
    std::fs::write(ws.root.join("config.toml"), toml::to_string_pretty(doc)?)?;
    Ok(())
}

pub fn list_targets(ws: &Workspace) -> Result<Vec<PublishTarget>, ConfigError> {
    let doc = read_doc(ws)?;
    Ok(targets_of(&doc))
}

fn targets_of(doc: &toml::Value) -> Vec<PublishTarget> {
    doc.get("publish")
        .and_then(|p| p.get("targets"))
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .map(|t| PublishTarget {
                    id: t.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                    display: t.get("display").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                    note: t.get("note").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 新增目标。写回时以 toml::Value 透传编辑，保留 config.toml 其余段落。
pub fn add_target(ws: &Workspace, id: &str, display: &str, note: &str) -> Result<(), ConfigError> {
    let valid = !id.is_empty()
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
    if !valid {
        return Err(ConfigError::InvalidId(id.to_string()));
    }
    let mut doc = read_doc(ws)?;
    if targets_of(&doc).iter().any(|t| t.id == id) {
        return Err(ConfigError::DuplicateTarget(id.to_string()));
    }
    let publish = doc
        .as_table_mut()
        .unwrap()
        .entry("publish")
        .or_insert_with(|| toml::Value::Table(Default::default()));
    let targets = publish
        .as_table_mut()
        .unwrap()
        .entry("targets")
        .or_insert_with(|| toml::Value::Array(Default::default()));
    targets
        .as_array_mut()
        .unwrap()
        .push(toml::Value::Table({
            let mut t = toml::map::Map::new();
            t.insert("id".into(), toml::Value::String(id.to_string()));
            t.insert("display".into(), toml::Value::String(display.to_string()));
            t.insert("note".into(), toml::Value::String(note.to_string()));
            t
        }));
    write_doc(ws, &doc)
}

// ───── [ai] 段：模型配置（DESIGN §8，M4 T3）─────

/// 单个模型提供方。单价为美分/1k tokens（修订决策 6）；Ollama 恒免费。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProvider {
    pub id: String,
    #[serde(rename = "type")]
    pub ptype: String, // openai | anthropic | ollama
    pub base_url: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_context: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub price_per_1k_in_cents: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub price_per_1k_out_cents: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiBudget {
    /// 0 = 不限制
    pub daily_cents: u64,
    /// 0 = 不限制
    pub monthly_cents: u64,
    /// 暂停 AI：所有 AI 操作直接拒绝
    pub paused: bool,
}

impl Default for AiBudget {
    fn default() -> Self {
        Self { daily_cents: 0, monthly_cents: 0, paused: false }
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct AiConfig {
    pub providers: Vec<AiProvider>,
    /// op → "provider:model"（model 省略则用 provider 默认）
    pub routes: BTreeMap<String, String>,
    /// op → "provider:model,provider:model"
    pub fallbacks: BTreeMap<String, String>,
    pub budget: AiBudget,
}

/// 解析后的一跳路由。
#[derive(Debug, Clone, PartialEq)]
pub struct RouteHop {
    pub provider: String,
    pub model: String,
    pub kind: ProviderKind,
}

pub fn read_ai(ws: &Workspace) -> Result<AiConfig, ConfigError> {
    let doc = read_doc(ws)?;
    let mut cfg = AiConfig::default();
    if let Some(ai) = doc.get("ai") {
        if let Some(arr) = ai.get("providers").and_then(|p| p.as_array()) {
            for row in arr {
                if let Ok(p) = row.clone().try_into::<AiProvider>() {
                    cfg.providers.push(p);
                }
            }
        }
        if let Some(t) = ai.get("routes").and_then(|r| r.as_table()) {
            for (k, v) in t {
                if let Some(s) = v.as_str() {
                    cfg.routes.insert(k.clone(), s.to_string());
                }
            }
        }
        if let Some(t) = ai.get("fallbacks").and_then(|r| r.as_table()) {
            for (k, v) in t {
                if let Some(s) = v.as_str() {
                    cfg.fallbacks.insert(k.clone(), s.to_string());
                }
            }
        }
        if let Some(b) = ai.get("budget").and_then(|b| b.as_table()) {
            let get_u64 = |k: &str| b.get(k).and_then(|v| v.as_integer()).map(|v| v.max(0) as u64);
            cfg.budget = AiBudget {
                daily_cents: get_u64("daily_cents").unwrap_or(0),
                monthly_cents: get_u64("monthly_cents").unwrap_or(0),
                paused: b.get("paused").and_then(|v| v.as_bool()).unwrap_or(false),
            };
        }
    }
    Ok(cfg)
}

fn validate_provider(p: &AiProvider) -> Result<(), ConfigError> {
    let valid_id = !p.id.is_empty()
        && p.id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
    if !valid_id {
        return Err(ConfigError::InvalidId(p.id.clone()));
    }
    if ProviderKind::from_type(&p.ptype).is_none() {
        return Err(ConfigError::InvalidProvider(format!(
            "type 必须是 openai/anthropic/ollama：{}",
            p.ptype
        )));
    }
    if !p.base_url.starts_with("http://") && !p.base_url.starts_with("https://") {
        return Err(ConfigError::InvalidProvider(format!("base_url 必须以 http(s):// 开头：{}", p.base_url)));
    }
    if p.model.trim().is_empty() {
        return Err(ConfigError::InvalidProvider(format!("model 不能为空（provider {}）", p.id)));
    }
    Ok(())
}

fn ai_table_mut(doc: &mut toml::Value) -> &mut toml::map::Map<String, toml::Value> {
    doc.as_table_mut()
        .unwrap()
        .entry("ai")
        .or_insert_with(|| toml::Value::Table(Default::default()))
        .as_table_mut()
        .unwrap()
}

/// 新增/更新 provider（按 id upsert）。Ollama 恒免费（价格强制清空）。
/// 写回以 toml::Value 透传，保留 config.toml 其余段落。
pub fn save_provider(ws: &Workspace, provider: &AiProvider) -> Result<(), ConfigError> {
    let mut p = provider.clone();
    if p.ptype == "ollama" {
        p.price_per_1k_in_cents = None;
        p.price_per_1k_out_cents = None;
    }
    validate_provider(&p)?;
    let mut doc = read_doc(ws)?;
    let ai = ai_table_mut(&mut doc);
    let providers = ai
        .entry("providers")
        .or_insert_with(|| toml::Value::Array(Default::default()))
        .as_array_mut()
        .unwrap();
    providers.retain(|row| row.get("id").and_then(|v| v.as_str()) != Some(p.id.as_str()));
    providers.push(toml::Value::try_from(&p).map_err(|e| ConfigError::Parse(e.to_string()))?);
    write_doc(ws, &doc)
}

/// 删除 provider，并清理引用它的路由/fallback 项。
pub fn delete_provider(ws: &Workspace, id: &str) -> Result<(), ConfigError> {
    let mut doc = read_doc(ws)?;
    let cfg = ai_from_doc(&doc);
    let hops_reference = |value: &str| {
        parse_hop_ids(value).iter().any(|(pid, _)| pid == id)
    };
    {
        let ai = ai_table_mut(&mut doc);
        if let Some(arr) = ai.get_mut("providers").and_then(|p| p.as_array_mut()) {
            arr.retain(|row| row.get("id").and_then(|v| v.as_str()) != Some(id));
        }
        for key in ["routes", "fallbacks"] {
            if let Some(t) = ai.get_mut(key).and_then(|v| v.as_table_mut()) {
                let cfg_values: Vec<(String, String)> = match key {
                    "routes" => cfg.routes.clone().into_iter().collect(),
                    _ => cfg.fallbacks.clone().into_iter().collect(),
                };
                for (k, v) in cfg_values {
                    if hops_reference(&v) {
                        t.remove(&k);
                    }
                }
            }
        }
    }
    write_doc(ws, &doc)
}

/// 保存路由/fallback/预算（修订决策 2：ai_save_ai_config 写回）。
pub fn save_ai_config(
    ws: &Workspace,
    routes: &BTreeMap<String, String>,
    fallbacks: &BTreeMap<String, String>,
    budget: AiBudget,
) -> Result<(), ConfigError> {
    let mut doc = read_doc(ws)?;
    // 校验从宽：resolve_route 本身会跳过未知 provider（容错优先）
    let ai = ai_table_mut(&mut doc);
    ai.insert("routes".into(), str_table(routes));
    ai.insert("fallbacks".into(), str_table(fallbacks));
    let mut b = toml::map::Map::new();
    b.insert("daily_cents".into(), toml::Value::Integer(budget.daily_cents as i64));
    b.insert("monthly_cents".into(), toml::Value::Integer(budget.monthly_cents as i64));
    b.insert("paused".into(), toml::Value::Boolean(budget.paused));
    ai.insert("budget".into(), toml::Value::Table(b));
    write_doc(ws, &doc)
}

fn str_table(m: &BTreeMap<String, String>) -> toml::Value {
    let mut t = toml::map::Map::new();
    for (k, v) in m {
        t.insert(k.clone(), toml::Value::String(v.clone()));
    }
    toml::Value::Table(t)
}

fn ai_from_doc(doc: &toml::Value) -> AiConfig {
    let mut cfg = AiConfig::default();
    if let Some(ai) = doc.get("ai") {
        if let Some(arr) = ai.get("providers").and_then(|p| p.as_array()) {
            for row in arr {
                if let Ok(p) = row.clone().try_into::<AiProvider>() {
                    cfg.providers.push(p);
                }
            }
        }
        if let Some(t) = ai.get("routes").and_then(|r| r.as_table()) {
            for (k, v) in t {
                if let Some(s) = v.as_str() {
                    cfg.routes.insert(k.clone(), s.to_string());
                }
            }
        }
        if let Some(t) = ai.get("fallbacks").and_then(|r| r.as_table()) {
            for (k, v) in t {
                if let Some(s) = v.as_str() {
                    cfg.fallbacks.insert(k.clone(), s.to_string());
                }
            }
        }
    }
    cfg
}

/// "p1:m1,p2" → [(p1, Some(m1)), (p2, None)]（逗号分隔；model 冒号后整体）。
fn parse_hop_ids(value: &str) -> Vec<(String, Option<String>)> {
    value
        .split(',')
        .filter_map(|piece| {
            let piece = piece.trim();
            if piece.is_empty() {
                return None;
            }
            match piece.split_once(':') {
                Some((pid, model)) => {
                    let model = model.trim();
                    Some((pid.trim().to_string(), (!model.is_empty()).then(|| model.to_string())))
                }
                None => Some((piece.to_string(), None)),
            }
        })
        .collect()
}

/// 路由解析（修订决策 7）：主路由 + fallback 链（按序、去重、跳过未知 provider）。
/// 无路由 → 空链（调用方报「操作未配置路由」）。
pub fn resolve_route(cfg: &AiConfig, op: &str) -> Vec<RouteHop> {
    let by_id: HashMap<&str, &AiProvider> =
        cfg.providers.iter().map(|p| (p.id.as_str(), p)).collect();
    let mut hops: Vec<RouteHop> = Vec::new();
    let primary = cfg.routes.get(op).cloned();
    let chain = cfg.fallbacks.get(op).cloned().unwrap_or_default();
    for (pid, model) in parse_hop_ids(&primary.unwrap_or_default()) {
        push_hop(&mut hops, &by_id, &pid, model);
    }
    for (pid, model) in parse_hop_ids(&chain) {
        push_hop(&mut hops, &by_id, &pid, model);
    }
    hops
}

fn push_hop(hops: &mut Vec<RouteHop>, by_id: &HashMap<&str, &AiProvider>, pid: &str, model: Option<String>) {
    let Some(p) = by_id.get(pid) else { return };
    let Some(kind) = ProviderKind::from_type(&p.ptype) else { return };
    let model = model.unwrap_or_else(|| p.model.clone());
    if hops.iter().any(|h| h.provider == pid && h.model == model) {
        return; // 去重
    }
    hops.push(RouteHop { provider: pid.to_string(), model, kind });
}

/// 单价表（provider id → (in_cents, out_cents)）。Ollama 恒 0（不计费）。
pub fn price_map(cfg: &AiConfig) -> HashMap<String, (u64, u64)> {
    cfg.providers
        .iter()
        .map(|p| {
            let price = if p.ptype == "ollama" {
                (0, 0)
            } else {
                (
                    p.price_per_1k_in_cents.unwrap_or(0),
                    p.price_per_1k_out_cents.unwrap_or(0),
                )
            };
            (p.id.clone(), price)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn ws() -> (tempfile::TempDir, Workspace) {
        let dir = tempdir().unwrap();
        let w = Workspace::init(dir.path()).unwrap();
        (dir, w)
    }

    #[test]
    fn empty_config_lists_nothing() {
        let (_d, w) = ws();
        assert!(list_targets(&w).unwrap().is_empty());
    }

    #[test]
    fn add_then_list_and_duplicate_rejected() {
        let (_d, w) = ws();
        add_target(&w, "wechat", "微信公众号", "正文 300 字内").unwrap();
        let list = list_targets(&w).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "wechat");
        assert_eq!(list[0].display, "微信公众号");
        assert!(matches!(
            add_target(&w, "wechat", "x", ""),
            Err(ConfigError::DuplicateTarget(_))
        ));
    }

    #[test]
    fn invalid_id_rejected() {
        let (_d, w) = ws();
        assert!(matches!(
            add_target(&w, "WeChat!", "x", ""),
            Err(ConfigError::InvalidId(_))
        ));
    }

    #[test]
    fn writeback_preserves_other_sections() {
        let (_d, w) = ws();
        std::fs::write(
            w.root.join("config.toml"),
            "[editor]\nfont_size = 15\n",
        )
        .unwrap();
        add_target(&w, "blog", "博客", "").unwrap();
        let raw = std::fs::read_to_string(w.root.join("config.toml")).unwrap();
        assert!(raw.contains("[editor]"), "{raw}");
        assert!(raw.contains("font_size = 15"));
        assert!(raw.contains("id = \"blog\""));
    }

    // ───── [ai] 段（M4 T3）─────

    fn openai_p(id: &str, model: &str) -> AiProvider {
        AiProvider {
            id: id.into(),
            ptype: "openai".into(),
            base_url: "https://api.example.com/v1".into(),
            model: model.into(),
            max_context: Some(128000),
            price_per_1k_in_cents: Some(1),
            price_per_1k_out_cents: Some(2),
        }
    }

    #[test]
    fn ai_config_roundtrip_and_writeback_preserve() {
        let (_d, w) = ws();
        std::fs::write(w.root.join("config.toml"), "[editor]\nfont_size = 15\n").unwrap();
        save_provider(&w, &openai_p("cloud", "gpt-x")).unwrap();
        save_provider(
            &w,
            &AiProvider {
                id: "local".into(),
                ptype: "ollama".into(),
                base_url: "http://127.0.0.1:11434".into(),
                model: "qwen".into(),
                max_context: None,
                price_per_1k_in_cents: Some(99), // 应被强制清空
                price_per_1k_out_cents: Some(99),
            },
        )
        .unwrap();
        let mut routes = BTreeMap::new();
        routes.insert("summarize".into(), "cloud:gpt-x".into());
        let mut fallbacks = BTreeMap::new();
        fallbacks.insert("summarize".into(), "local".into());
        save_ai_config(
            &w,
            &routes,
            &fallbacks,
            AiBudget { daily_cents: 100, monthly_cents: 2000, paused: false },
        )
        .unwrap();
        let cfg = read_ai(&w).unwrap();
        assert_eq!(cfg.providers.len(), 2);
        assert_eq!(cfg.routes.get("summarize").unwrap(), "cloud:gpt-x");
        assert_eq!(cfg.budget.daily_cents, 100);
        assert_eq!(cfg.budget.monthly_cents, 2000);
        assert!(!cfg.budget.paused);
        // Ollama 价格写回时清空
        let local = cfg.providers.iter().find(|p| p.id == "local").unwrap();
        assert_eq!(local.price_per_1k_in_cents, None);
        // 透传保留其他段落
        let raw = std::fs::read_to_string(w.root.join("config.toml")).unwrap();
        assert!(raw.contains("[editor]"), "{raw}");
        assert!(raw.contains("font_size = 15"));
        assert!(raw.contains("[ai.budget]"));
        // 单价表：ollama 恒 0
        let prices = price_map(&cfg);
        assert_eq!(prices.get("cloud"), Some(&(1, 2)));
        assert_eq!(prices.get("local"), Some(&(0, 0)));
    }

    #[test]
    fn resolve_route_primary_fallback_dedup_and_skip_unknown() {
        let (_d, w) = ws();
        save_provider(&w, &openai_p("cloud", "gpt-x")).unwrap();
        save_provider(
            &w,
            &AiProvider {
                id: "local".into(),
                ptype: "ollama".into(),
                base_url: "http://127.0.0.1:11434".into(),
                model: "qwen".into(),
                max_context: None,
                price_per_1k_in_cents: None,
                price_per_1k_out_cents: None,
            },
        )
        .unwrap();
        let mut routes = BTreeMap::new();
        routes.insert("summarize".into(), "cloud".into()); // model 缺省
        let mut fallbacks = BTreeMap::new();
        // ghost 不存在；cloud:gpt-x 与主路由重复 → 去重；local 保留
        fallbacks.insert("summarize".into(), "ghost:m,cloud:gpt-x,local:qwen".into());
        save_ai_config(&w, &routes, &fallbacks, AiBudget::default()).unwrap();
        let cfg = read_ai(&w).unwrap();
        let hops = resolve_route(&cfg, "summarize");
        assert_eq!(hops.len(), 2, "{hops:?}");
        assert_eq!(hops[0].provider, "cloud");
        assert_eq!(hops[0].model, "gpt-x"); // 路由未带 model → provider 默认
        assert_eq!(hops[1].provider, "local");
        assert_eq!(hops[1].model, "qwen");
        // 无路由操作 → 空链
        assert!(resolve_route(&cfg, "qa").is_empty());
    }

    #[test]
    fn delete_provider_strips_routes_referencing_it() {
        let (_d, w) = ws();
        save_provider(&w, &openai_p("cloud", "gpt-x")).unwrap();
        save_provider(
            &w,
            &AiProvider {
                id: "local".into(),
                ptype: "ollama".into(),
                base_url: "http://127.0.0.1:11434".into(),
                model: "qwen".into(),
                max_context: None,
                price_per_1k_in_cents: None,
                price_per_1k_out_cents: None,
            },
        )
        .unwrap();
        let mut routes = BTreeMap::new();
        routes.insert("summarize".into(), "cloud".into());
        routes.insert("qa".into(), "local".into());
        let mut fallbacks = BTreeMap::new();
        fallbacks.insert("summarize".into(), "local".into());
        save_ai_config(&w, &routes, &fallbacks, AiBudget::default()).unwrap();
        delete_provider(&w, "cloud").unwrap();
        let cfg = read_ai(&w).unwrap();
        assert_eq!(cfg.providers.len(), 1);
        assert!(cfg.routes.get("summarize").is_none(), "引用 cloud 的主路由应被清理");
        // fallback 值为 local，不引用 cloud → 保留（resolve_route 仍可用）
        assert_eq!(cfg.fallbacks.get("summarize").unwrap(), "local");
        assert_eq!(cfg.routes.get("qa").unwrap(), "local");
    }

    #[test]
    fn invalid_provider_rejected() {
        let (_d, w) = ws();
        let mut p = openai_p("Bad!", "m");
        assert!(matches!(save_provider(&w, &p), Err(ConfigError::InvalidId(_))));
        p = openai_p("ok", "");
        p.model = " ".into();
        assert!(matches!(save_provider(&w, &p), Err(ConfigError::InvalidProvider(_))));
        p = openai_p("ok2", "m");
        p.ptype = "gemini".into();
        assert!(matches!(save_provider(&w, &p), Err(ConfigError::InvalidProvider(_))));
        p = openai_p("ok3", "m");
        p.base_url = "ftp://x".into();
        assert!(matches!(save_provider(&w, &p), Err(ConfigError::InvalidProvider(_))));
        // 路由引用不存在的 provider：保存从宽（resolve_route 跳过未知）
        let mut routes = BTreeMap::new();
        routes.insert("op".into(), "ghost".into());
        assert!(save_ai_config(&w, &routes, &BTreeMap::new(), AiBudget::default()).is_ok());
    }
}
