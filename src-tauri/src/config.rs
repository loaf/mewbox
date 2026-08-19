//! config.toml：发布目标注册表（便利设施，不强制；DESIGN §5.1）。

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
}
