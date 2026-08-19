use std::fmt;

use serde_yaml::Mapping;

/// 文稿/资料共用的 frontmatter（DESIGN §3.2）。
/// 已知字段抽出为类型；解析不了的已知字段原样留在 `extra`（无损往返）。
#[derive(Debug, Clone, PartialEq)]
pub struct Frontmatter {
    pub id: uuid::Uuid,
    pub title: String,
    pub folder: Option<String>,
    pub status: PostStatus,
    pub tags: Vec<String>,
    pub created: String,
    pub updated: String,
    pub extra: Mapping,
    /// 仅内存标记，不参与 YAML 解析/序列化（机制决策 5）：
    /// 资料稀疏序列化——status=draft 且 tags 为空时两字段省略。
    pub sparse: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PostStatus {
    Draft,
    Writing,
    Done,
    Archived,
}

impl Default for PostStatus {
    fn default() -> Self {
        PostStatus::Draft
    }
}

impl fmt::Display for PostStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            PostStatus::Draft => "draft",
            PostStatus::Writing => "writing",
            PostStatus::Done => "done",
            PostStatus::Archived => "archived",
        };
        f.write_str(s)
    }
}

impl Default for Frontmatter {
    fn default() -> Self {
        Self {
            id: uuid::Uuid::nil(),
            title: String::new(),
            folder: None,
            status: PostStatus::Draft,
            tags: Vec::new(),
            created: String::new(),
            updated: String::new(),
            extra: Mapping::new(),
            sparse: false,
        }
    }
}

impl Frontmatter {
    pub fn is_new(&self) -> bool {
        self.id == uuid::Uuid::nil()
    }

    /// 生成新文稿的 frontmatter（id/created/updated 就位）。
    pub fn new_post(title: &str, folder: Option<&str>) -> Self {
        let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
        Self {
            id: uuid::Uuid::new_v4(),
            title: title.to_string(),
            folder: folder.map(String::from),
            status: PostStatus::Draft,
            tags: Vec::new(),
            created: now.clone(),
            updated: now,
            extra: Mapping::new(),
            sparse: false,
        }
    }

    pub fn bump_updated(&mut self) {
        self.updated = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
    }

    /// 序列化为完整文件内容：固定字段顺序 + extra 原样跟在后面（DESIGN §3.2）。
    pub fn to_content(&self, body: &str) -> String {
        let mut out = String::from("---\n");
        out.push_str(&format!("id: {}\n", self.id));
        out.push_str(&format!("title: {}\n", yaml_scalar(&self.title)));
        if let Some(folder) = &self.folder {
            out.push_str(&format!("folder: {}\n", yaml_scalar(folder)));
        }
        // 稀疏序列化（机制决策 5）：资料省略默认 status/tags
        let omit_defaults = self.sparse && self.status == PostStatus::Draft && self.tags.is_empty();
        if !omit_defaults {
            out.push_str(&format!("status: {}\n", self.status));
            out.push_str(&format!("tags: [{}]\n", self.tags.iter().map(|t| yaml_scalar(t)).collect::<Vec<_>>().join(", ")));
        }
        if !self.created.is_empty() {
            out.push_str(&format!("created: {}\n", yaml_scalar(&self.created)));
        }
        if !self.updated.is_empty() {
            out.push_str(&format!("updated: {}\n", yaml_scalar(&self.updated)));
        }
        for (k, v) in &self.extra {
            if matches!(k, serde_yaml::Value::String(_)) {
                let mut single = Mapping::new();
                single.insert(k.clone(), v.clone());
                if let Ok(line) = serde_yaml::to_string(&serde_yaml::Value::Mapping(single)) {
                    out.push_str(line.trim_end());
                    out.push('\n');
                }
            }
        }
        out.push_str("---\n");
        out.push_str(body);
        out
    }
}

/// 简单标量的 YAML 输出：含特殊字符时交给 serde_yaml 处理，否则原样。
fn yaml_scalar(s: &str) -> String {
    if s.is_empty()
        || s.contains(':')
        || s.contains('#')
        || s.contains('\n')
        || s.trim() != s
        || s.starts_with('[')
        || s.starts_with('{')
        || s.starts_with('\'')
        || s.starts_with('"')
    {
        serde_yaml::to_string(s).unwrap_or_default().trim().to_string()
    } else {
        s.to_string()
    }
}

/// 解析文件内容 → (frontmatter, body)。无 frontmatter 时返回空 fm + 全文为 body。
pub fn parse(content: &str) -> Result<(Frontmatter, String), serde_yaml::Error> {
    let (yaml_part, body) = split(content);
    let yaml_part = match yaml_part {
        Some(y) => y,
        None => return Ok((Frontmatter::default(), content.to_string())),
    };
    let value: serde_yaml::Value = serde_yaml::from_str(&yaml_part)?;
    let mapping = match value {
        serde_yaml::Value::Mapping(m) => m,
        _ => return Ok((Frontmatter::default(), body)),
    };
    let mut fm = Frontmatter::default();
    let mut extra = Mapping::new();
    for (k, v) in mapping {
        let key = match &k {
            serde_yaml::Value::String(s) => s.clone(),
            _ => continue,
        };
        match key.as_str() {
            "id" => match v.as_str().and_then(|s| uuid::Uuid::parse_str(s).ok()) {
                Some(id) => fm.id = id,
                None => {
                    extra.insert(k, v);
                }
            },
            "title" => match v.as_str() {
                Some(t) => fm.title = t.to_string(),
                None => {
                    extra.insert(k, v);
                }
            },
            "folder" => match &v {
                serde_yaml::Value::Null => {}
                serde_yaml::Value::String(s) => fm.folder = Some(s.clone()),
                _ => {
                    extra.insert(k, v);
                }
            },
            "status" => match v.as_str().and_then(parse_status) {
                Some(s) => fm.status = s,
                None => {
                    extra.insert(k, v);
                }
            },
            "tags" => match v.as_sequence().map(|seq| {
                seq.iter()
                    .map(|t| t.as_str().map(String::from))
                    .collect::<Option<Vec<_>>>()
            }) {
                Some(Some(tags)) => fm.tags = tags,
                _ => {
                    extra.insert(k, v);
                }
            },
            "created" => match v.as_str() {
                Some(t) => fm.created = t.to_string(),
                None => {
                    extra.insert(k, v);
                }
            },
            "updated" => match v.as_str() {
                Some(t) => fm.updated = t.to_string(),
                None => {
                    extra.insert(k, v);
                }
            },
            _ => {
                extra.insert(k, v);
            }
        }
    }
    fm.extra = extra;
    Ok((fm, body))
}

fn parse_status(s: &str) -> Option<PostStatus> {
    match s {
        "draft" => Some(PostStatus::Draft),
        "writing" => Some(PostStatus::Writing),
        "done" => Some(PostStatus::Done),
        "archived" => Some(PostStatus::Archived),
        _ => None,
    }
}

/// 切出 (yaml 段, body 段)。以 `---` 行开头、下一个纯 `---` 行结束；
/// body 从**原文**切片（CRLF 保真），yaml 段单独拷出。
fn split(content: &str) -> (Option<String>, String) {
    let mut lines = content.split_inclusive('\n');
    let first = match lines.next() {
        Some(l) if l.trim_end_matches(['\r', '\n']) == "---" => l,
        _ => return (None, content.to_string()),
    };
    let yaml_start = first.len();
    let mut offset = yaml_start;
    for line in lines {
        let len = line.len();
        if line.trim_end_matches(['\r', '\n']) == "---" {
            let yaml = content[yaml_start..offset].to_string();
            let body = content[offset + len..].to_string();
            return (Some(yaml), body);
        }
        offset += len;
    }
    // 没有闭合分隔线：整个文件按正文处理
    (None, content.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "---\nid: 3f2c0000-0000-0000-0000-000000000001\ntitle: 深度工作\ntags: [essay]\nstatus: draft\ncreated: 2026-08-18T10:00:00\nupdated: 2026-08-18T12:30:00\n---\n\n正文A\r\n第二行\n";

    #[test]
    fn parses_and_roundtrips_with_extra_keys() {
        let src = SAMPLE.replace("tags: [essay]", "tags: [essay]\nrating: 5");
        let (fm, body) = parse(&src).unwrap();
        assert_eq!(fm.id.to_string(), "3f2c0000-0000-0000-0000-000000000001");
        assert_eq!(fm.title, "深度工作");
        assert_eq!(fm.folder, None);
        assert_eq!(fm.tags, vec!["essay".to_string()]);
        let out = fm.to_content(&body);
        let (fm2, body2) = parse(&out).unwrap();
        assert_eq!(fm2.id, fm.id);
        assert_eq!(body2, body);
        assert!(out.contains("rating: 5"));
    }

    #[test]
    fn content_without_frontmatter_is_all_body() {
        let (fm, body) = parse("就是正文").unwrap();
        assert!(fm.is_new());
        assert_eq!(body, "就是正文");
    }

    #[test]
    fn serialize_is_canonical_order() {
        let (fm, body) = parse(SAMPLE).unwrap();
        let out = fm.to_content(&body);
        let id_pos = out.find("id:").unwrap();
        let title_pos = out.find("title:").unwrap();
        let updated_pos = out.find("updated:").unwrap();
        assert!(id_pos < title_pos && title_pos < updated_pos);
    }

    #[test]
    fn unparsable_known_field_is_preserved_in_extra() {
        let src = "---\nid: not-a-uuid\ntitle: X\n---\nbody\n";
        let (fm, body) = parse(src).unwrap();
        assert!(fm.is_new());
        let out = fm.to_content(&body);
        assert!(out.contains("id: not-a-uuid"), "原始值必须透传: {out}");
    }

    #[test]
    fn crlf_frontmatter_and_body_survive() {
        let src = "---\r\ntitle: C\r\n---\r\nB\r\n";
        let (fm, body) = parse(src).unwrap();
        assert_eq!(fm.title, "C");
        assert_eq!(body, "B\r\n");
    }

    #[test]
    fn new_post_has_id_and_timestamps() {
        let fm = Frontmatter::new_post("随笔", Some("技术/分布式"));
        assert!(!fm.is_new());
        assert_eq!(fm.folder.as_deref(), Some("技术/分布式"));
        assert!(!fm.created.is_empty());
        assert_eq!(fm.created, fm.updated);
    }

    #[test]
    fn sparse_serialization_omits_defaults_only() {
        let mut fm = Frontmatter::new_post("设计素材", None);
        fm.sparse = true;
        let out = fm.to_content("正文");
        assert!(!out.contains("status:"), "默认 status 应省略: {out}");
        assert!(!out.contains("tags:"), "空 tags 应省略: {out}");
        // 解析回来仍是 Draft/空 tags
        let (fm2, body) = parse(&out).unwrap();
        assert_eq!(fm2.status, PostStatus::Draft);
        assert!(fm2.tags.is_empty());
        assert_eq!(body, "正文");

        // 非默认状态不省略
        fm.status = PostStatus::Writing;
        assert!(fm.to_content("x").contains("status: writing"));
        // 有 tags 不省略
        fm.status = PostStatus::Draft;
        fm.tags = vec!["参考".into()];
        assert!(fm.to_content("x").contains("tags: [参考]"));

        // 非 sparse（文稿）全量序列化
        fm.tags.clear();
        fm.sparse = false;
        let full = fm.to_content("x");
        assert!(full.contains("status: draft"));
        assert!(full.contains("tags: []"));
    }
}
