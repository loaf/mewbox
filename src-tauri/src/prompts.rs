//! Prompt 模板（DESIGN §8.3，M4 T5）：纯函数 `build(op, params) -> (system, user)`。
//! 每操作一个固定中文模板；自定义指令只能**附加**（铁律：单次受控调用，
//! 模板结构不可被用户指令覆盖）。润色建议/查错要求只输出 JSON，
//! 解析侧做容错（剥围栏/尾逗号/BOM/前置闲话）。

/// 各操作的输入参数（全部借用；组装零成本）。
#[derive(Debug, Default, Clone, Copy)]
pub struct OpParams<'a> {
    /// 上下文全文（多材料以标题分节拼好）
    pub context: &'a str,
    /// 选区文字（rewrite/expand/shorten/tone/polish 必填）
    pub selection: Option<&'a str>,
    /// 问答问题（qa 必填）
    pub question: Option<&'a str>,
    /// 多轮历史（当次窗口；(user, assistant) 交替）
    pub history: &'a [(String, String)],
    /// 目标语言（translate 必填）
    pub target_lang: Option<&'a str>,
    /// 目标语气（tone 可选，默认更正式自然）
    pub tone: Option<&'a str>,
    /// 自定义指令（custom 必填；其他操作作为附加要求）
    pub custom: Option<&'a str>,
}

/// 支持的操作集合（路由表按这些 op 配置）。
pub const OPS: &[&str] = &[
    "summarize",
    "keypoints",
    "translate",
    "compare",
    "qa",
    "rewrite",
    "expand",
    "shorten",
    "tone",
    "polish",
    "proofread_suggestions",
    "check_errors",
    "custom",
    "describe_attachment",
];

const SYSTEM_BASE: &str = "你是 MewBox 本地写作工作台的 AI 助手。\
严格按用户消息中的操作指令执行：直接输出结果正文，不要开场白、不要复述指令、不要解释你的思考过程。\
所有回答必须基于给定上下文，不编造材料中不存在的信息。";

const SYSTEM_JSON: &str = " 输出必须是合法 JSON（UTF-8 双引号语法），不要用 Markdown 代码围栏，不要输出 JSON 以外的任何文字。";

fn require<'a>(v: Option<&'a str>, what: &str) -> Result<&'a str, String> {
    let v = v.map(str::trim).filter(|s| !s.is_empty());
    v.ok_or_else(|| format!("操作缺少{what}"))
}

/// 组装 (system, user)。未知操作 → Err。
pub fn build(op: &str, p: &OpParams) -> Result<(String, String), String> {
    let json_op = matches!(op, "proofread_suggestions" | "check_errors");
    let mut system = SYSTEM_BASE.to_string();
    if json_op {
        system.push_str(SYSTEM_JSON);
    }
    let user = match op {
        "summarize" => format!(
            "请对以下材料做整体总结。要求：\n- 200 字以内\n- 保留核心论点与关键结论\n\n材料：\n{}",
            p.context
        ),
        "keypoints" => format!(
            "请从以下材料中提取关键要点。要求：\n- 无序列表，每条一行，最多 10 条\n- 保持原意，不添加材料外的信息\n\n材料：\n{}",
            p.context
        ),
        "translate" => {
            let lang = require(p.target_lang, "目标语言（target_lang）")?;
            format!("请把以下内容翻译成{lang}。要求：保持原文语气与格式（列表/段落结构），不加解释。\n\n内容：\n{}", p.context)
        }
        "compare" => format!(
            "请对比以下多段材料的异同。要求：\n- 先各用一句话概括\n- 再分「相同点」「差异点」两节，无序列表\n- 只基于材料内容\n\n材料：\n{}",
            p.context
        ),
        "qa" => {
            let q = require(p.question, "问题（question）")?;
            let mut u = String::new();
            if !p.history.is_empty() {
                u.push_str("以下是本窗口的对话历史（仅供理解指代，不作为事实来源）：\n");
                for (i, (h_user, h_assistant)) in p.history.iter().enumerate() {
                    u.push_str(&format!("{}. 问：{}\n   答：{}\n", i + 1, h_user, h_assistant));
                }
                u.push('\n');
            }
            u.push_str(&format!(
                "请基于材料回答问题；材料中没有的信息明确说「材料中未提及」。\n\n材料：\n{}\n\n问题：{q}",
                p.context
            ));
            u
        }
        "rewrite" => sel(p, "请改写下面的选区文字。要求：保持原意，提升表达，不改变长度数量级，直接输出改写后的文字。"),
        "expand" => sel(p, "请扩写下面的选区文字。要求：围绕原意补充细节与论证，篇幅约为原文 1.5-2 倍，直接输出扩写后的文字。"),
        "shorten" => sel(p, "请缩写下面的选区文字。要求：保留核心信息，删减冗余，篇幅约为原文一半，直接输出缩写后的文字。"),
        "tone" => {
            let s = require(p.selection, "选区文本（selection）")?;
            let tone = p.tone.map(str::trim).filter(|t| !t.is_empty()).unwrap_or("更正式、更自然");
            format!("请调整下面选区文字的语气，目标语气：{tone}。要求：意思不变，直接输出调整后的文字。\n\n选区：\n{s}")
        }
        "polish" => sel(p, "请润色下面的选区文字：修正语病与错别字、优化用词与节奏，保持原意与格式，直接输出润色后的文字。"),
        "proofread_suggestions" => format!(
            "请审阅下面的全文，给出润色建议。输出 JSON 数组，每项格式：\n[{{\"原段\":\"...\",\"改段\":\"...\",\"理由\":\"...\"}}]\n要求：\n- 只针对确有问题的句子，最多 20 条\n- 「原段」必须是原文中连续出现的完整片段（用于精确定位与替换）\n- 只输出 JSON\n\n全文：\n{}",
            p.context
        ),
        "check_errors" => format!(
            "请检查下面全文的错误（错别字、标点、语法、事实疑点、链接/格式问题）。输出 JSON 数组，每项格式：\n[{{\"类型\":\"...\",\"定位\":\"...\",\"建议\":\"...\"}}]\n要求：\n- 「定位」引用原文中能唯一定位的关键片段（10 字左右）\n- 只基于原文，最多 20 条\n- 只输出 JSON\n\n全文：\n{}",
            p.context
        ),
        "custom" => {
            let instr = require(p.custom, "自定义指令（custom）")?;
            let mut u = format!("{instr}\n");
            if let Some(s) = p.selection.map(str::trim).filter(|s| !s.is_empty()) {
                u.push_str(&format!("\n选区：\n{s}\n"));
            }
            if !p.context.trim().is_empty() {
                u.push_str(&format!("\n上下文材料：\n{}\n", p.context));
            }
            u
        }
        "describe_attachment" => format!(
            "请为以下附件内容写一段 100 字左右的中文描述，概括其主题与要点，作为资料卡片的介绍段。直接输出描述文字，不要标题。\n\n附件内容：\n{}",
            p.context
        ),
        other => return Err(format!("未知 AI 操作：{other}")),
    };
    let mut user = user;
    // 自定义指令附加（custom 本身即指令，不重复附加）
    if op != "custom" {
        if let Some(c) = p.custom.map(str::trim).filter(|c| !c.is_empty()) {
            user.push_str(&format!("\n\n补充要求：{c}"));
        }
    }
    Ok((system, user))
}

fn sel(p: &OpParams, instruction: &str) -> String {
    let s = p.selection.unwrap_or("");
    format!("{instruction}\n\n选区：\n{s}")
}

// ───── 容错 JSON 解析（T5 输出协议）─────

/// 润色建议（润色建议面板逐条采纳）。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub original: String,
    pub revised: String,
    pub reason: String,
}

/// 查错条目。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub kind: String,
    pub location: String,
    pub advice: String,
}

/// 剥 ``` 围栏（含 ```json 语言行）。
fn strip_fence(t: &str) -> &str {
    let t = t.trim();
    let Some(rest) = t.strip_prefix("```") else { return t };
    let rest = rest.split_once('\n').map(|(_, r)| r.trim_start()).unwrap_or(rest);
    match rest.rfind("```") {
        Some(end) => rest[..end].trim(),
        None => rest.trim(),
    }
}

/// 去掉 ]/} 前的尾逗号（含中间空白）。
fn remove_trailing_commas(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut ws = String::new(); // 悬置逗号后累积的空白（决定去留前先缓存）
    let mut pending = false;
    for c in s.chars() {
        if pending {
            if c.is_whitespace() {
                ws.push(c);
                continue;
            }
            if c != ']' && c != '}' {
                out.push(',');
                out.push_str(&ws);
            } // 若是 ]/}：尾逗号与其后空白一并丢弃
            ws.clear();
            pending = false;
        }
        if c == ',' {
            pending = true;
        } else {
            out.push(c);
        }
    }
    if pending {
        out.push(',');
        out.push_str(&ws);
    }
    out
}

/// 从模型输出中提取 JSON 数组文本（容错：BOM/围栏/前置闲话/尾逗号）。
fn extract_json_text(raw: &str) -> Option<String> {
    let t = raw.trim_start_matches('\u{feff}').trim();
    let t = strip_fence(t).trim();
    let start = t.find('[')?;
    let end = t.rfind(']')?;
    if end <= start {
        return None;
    }
    Some(remove_trailing_commas(&t[start..=end]))
}

fn value_array(raw: &str) -> Vec<serde_json::Value> {
    let Some(text) = extract_json_text(raw) else { return vec![] };
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(serde_json::Value::Array(a)) => a,
        _ => vec![],
    }
}

fn field<'v>(obj: &'v serde_json::Value, keys: &[&str]) -> String {
    for k in keys {
        if let Some(s) = obj.get(*k).and_then(|v| v.as_str()) {
            return s.trim().to_string();
        }
    }
    String::new()
}

/// 解析润色建议：`[{"原段","改段","理由"}]`；原段/改段缺一即跳过该条。
pub fn parse_suggestions(raw: &str) -> Vec<Suggestion> {
    value_array(raw)
        .into_iter()
        .filter_map(|v| {
            let original = field(&v, &["原段", "original"]);
            let revised = field(&v, &["改段", "revised"]);
            if original.is_empty() || revised.is_empty() || original == revised {
                return None;
            }
            Some(Suggestion {
                original,
                revised,
                reason: field(&v, &["理由", "reason"]),
            })
        })
        .collect()
}

/// 解析查错条目：`[{"类型","定位","建议"}]`；三字段全空即跳过。
pub fn parse_issues(raw: &str) -> Vec<Issue> {
    value_array(raw)
        .into_iter()
        .filter_map(|v| {
            let issue = Issue {
                kind: field(&v, &["类型", "kind"]),
                location: field(&v, &["定位", "location"]),
                advice: field(&v, &["建议", "advice"]),
            };
            let all_empty = issue.kind.is_empty()
                && issue.location.is_empty()
                && issue.advice.is_empty();
            if all_empty { None } else { Some(issue) }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params<'a>(context: &'a str) -> OpParams<'a> {
        OpParams { context, ..Default::default() }
    }

    // ── build ──

    #[test]
    fn build_summarize_contains_context_and_custom() {
        let p = OpParams { custom: Some("重点看第二段"), ..params("深度工作的材料全文") };
        let (system, user) = build("summarize", &p).unwrap();
        assert!(system.contains("MewBox"), "{system}");
        assert!(user.contains("深度工作的材料全文"), "{user}");
        assert!(user.contains("补充要求：重点看第二段"), "{user}");
        assert!(!user.contains("只输出 JSON"));
    }

    #[test]
    fn build_translate_requires_target_lang() {
        let err = build("translate", &params("x")).unwrap_err();
        assert!(err.contains("目标语言"), "{err}");
        let (_, user) = build("translate", &OpParams { target_lang: Some("英文"), ..params("内容") }).unwrap();
        assert!(user.contains("翻译成英文"), "{user}");
    }

    #[test]
    fn build_qa_includes_history_and_question() {
        let p = OpParams {
            question: Some("作者怎么定义注意力残留？"),
            history: &[("什么是深度工作".into(), "一种无干扰的专注模式".into())],
            ..params("材料正文")
        };
        let (_, user) = build("qa", &p).unwrap();
        assert!(user.contains("问：什么是深度工作"), "{user}");
        assert!(user.contains("答：一种无干扰的专注模式"), "{user}");
        assert!(user.contains("问题：作者怎么定义注意力残留？"), "{user}");
        assert!(build("qa", &params("材料")).is_err(), "qa 缺问题报错");
    }

    #[test]
    fn build_selection_ops_use_selection() {
        for op in ["rewrite", "expand", "shorten", "polish"] {
            let p = OpParams { selection: Some("被选中的句子"), ..params("") };
            let (_, user) = build(op, &p).unwrap();
            assert!(user.contains("选区：\n被选中的句子"), "{op}: {user}");
        }
    }

    #[test]
    fn build_tone_default_and_custom() {
        let p = OpParams { selection: Some("句子"), ..Default::default() };
        let (_, user) = build("tone", &p).unwrap();
        assert!(user.contains("更正式、更自然"), "{user}");
        let p2 = OpParams { selection: Some("句子"), tone: Some("轻松幽默"), ..Default::default() };
        let (_, user2) = build("tone", &p2).unwrap();
        assert!(user2.contains("目标语气：轻松幽默"), "{user2}");
    }

    #[test]
    fn json_ops_demand_json_only() {
        for op in ["proofread_suggestions", "check_errors"] {
            let (system, user) = build(op, &params("全文内容")).unwrap();
            assert!(system.contains("只输出 JSON") || system.contains("不要输出 JSON 以外的任何文字"), "{op}");
            assert!(user.contains("只输出 JSON"), "{op}: {user}");
        }
        let (_, user) = build("proofread_suggestions", &params("全文")).unwrap();
        assert!(user.contains("\"原段\""), "{user}");
        let (_, user2) = build("check_errors", &params("全文")).unwrap();
        assert!(user2.contains("\"定位\""), "{user2}");
    }

    #[test]
    fn build_custom_requires_instruction_and_appends_context() {
        assert!(build("custom", &params("材料")).is_err());
        let p = OpParams { custom: Some("列出所有日期"), selection: Some("选段"), ..params("上下文") };
        let (_, user) = build("custom", &p).unwrap();
        assert!(user.starts_with("列出所有日期"), "{user}");
        assert!(user.contains("选区：\n选段"), "{user}");
        assert!(user.contains("上下文材料：\n上下文"), "{user}");
        // custom 不重复附加补充要求
        assert!(!user.contains("补充要求"), "{user}");
    }

    #[test]
    fn build_unknown_op_rejected() {
        assert!(build("ghost_op", &params("")).is_err());
    }

    // ── 容错解析 ──

    #[test]
    fn parse_suggestions_clean_json() {
        let raw = r#"[{"原段":"这个句子有语病","改段":"这个句子没有语病","理由":"搭配不当"}]"#;
        assert_eq!(
            parse_suggestions(raw),
            vec![Suggestion {
                original: "这个句子有语病".into(),
                revised: "这个句子没有语病".into(),
                reason: "搭配不当".into()
            }]
        );
    }

    #[test]
    fn parse_suggestions_fenced_trailing_comma_and_prose() {
        let raw = "好的，以下是润色建议：\n```json\n[\n{\"原段\":\"甲\",\"改段\":\"乙\",\"理由\":\"r\",},\n{\"原段\":\"丙\",\"改段\":\"丁\",\"理由\":\"\"},\n]\n```\n希望有帮助";
        let out = parse_suggestions(raw);
        assert_eq!(out.len(), 2, "{out:?}");
        assert_eq!(out[0].original, "甲");
        assert_eq!(out[1].revised, "丁");
    }

    #[test]
    fn parse_suggestions_skips_incomplete_and_unchanged() {
        let raw = r#"[{"原段":"","改段":"乙"},{"原段":"同","改段":"同"},"垃圾条目",{"reason":"没有原文"}]"#;
        assert!(parse_suggestions(raw).is_empty());
        // 合法条目仍保留（中英混排内容）
        let ok = r#"[{"原段":"the quick brown fox","改段":"敏捷的棕色狐狸","理由":"术语统一"}]"#;
        assert_eq!(parse_suggestions(ok).len(), 1);
    }

    #[test]
    fn parse_suggestions_english_keys_and_bom() {
        let raw = "\u{feff}[{\"original\":\"a\",\"revised\":\"b\",\"reason\":\"c\"}]";
        assert_eq!(parse_suggestions(raw).len(), 1);
    }

    #[test]
    fn parse_issues_tolerant_mixed() {
        let raw = "检查结果：\n```json\n[{\"类型\":\"错别字\",\"定位\":\"深度工做\",\"建议\":\"应为「深度工作」\",},]\n```";
        let out = parse_issues(raw);
        assert_eq!(
            out,
            vec![Issue {
                kind: "错别字".into(),
                location: "深度工做".into(),
                advice: "应为「深度工作」".into()
            }]
        );
    }

    #[test]
    fn parse_issues_skips_all_empty_and_garbage_is_empty() {
        assert!(parse_issues(r#"[{"类型":"","定位":"","建议":""}]"#).is_empty());
        assert!(parse_issues("完全不是 JSON").is_empty());
        assert!(parse_suggestions("[]").is_empty());
        // 单对象（非数组）也容错：不支持 → 空
        assert!(parse_issues(r#"{"类型":"x"}"#).is_empty());
    }

    #[test]
    fn remove_trailing_commas_only_before_close() {
        assert_eq!(remove_trailing_commas(r#"[1, 2,]"#), r#"[1, 2]"#);
        assert_eq!(remove_trailing_commas(r#"{"a":1,}"#), r#"{"a":1}"#);
        assert_eq!(remove_trailing_commas(r#"[1, 2]"#), r#"[1, 2]"#);
        assert_eq!(remove_trailing_commas("[1, ] ,"), "[1] ,");
    }
}
