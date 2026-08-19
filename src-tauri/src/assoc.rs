//! 尾部关联块（DESIGN §7.1）：文件末尾的应用维护区。
//! 「没有关联就没有块」；块整体由应用重渲染，手动改动会被覆盖。

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssocEntry {
    pub title: String,
    /// 目标文件的工作区相对路径（/ 分隔）
    pub target: String,
}

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssocBlock {
    pub posts: Vec<AssocEntry>,
    pub materials: Vec<AssocEntry>,
    /// 发布版本区（仅文稿侧；自动维护，指向 .versions/{id}/publish/{target}.md）
    pub versions: Vec<AssocEntry>,
}

impl AssocBlock {
    pub fn is_empty(&self) -> bool {
        self.posts.is_empty() && self.materials.is_empty() && self.versions.is_empty()
    }
    /// 按目标路径移除（跨区；解除关联用）
    pub fn remove_target(&mut self, target: &str) {
        self.posts.retain(|e| e.target != target);
        self.materials.retain(|e| e.target != target);
        self.versions.retain(|e| e.target != target);
    }
}

pub const BEGIN_MARK: &str = "<!-- wb:assoc begin（应用维护区，手动修改会被覆盖） -->";
pub const END_MARK: &str = "<!-- wb:assoc end -->";

/// 从文件内容中剥出关联块：返回 (不含块的正文（trim_end）, 块)。无块 → (原文, None)。
pub fn strip_assoc(content: &str) -> (String, Option<AssocBlock>) {
    let Some(begin_idx) = content.find(BEGIN_MARK) else {
        return (content.to_string(), None);
    };
    let Some(end_rel) = content[begin_idx..].find(END_MARK) else {
        return (content.to_string(), None);
    };
    let end_idx = begin_idx + end_rel + END_MARK.len();
    let block_text = &content[begin_idx..end_idx];
    let before = content[..begin_idx].trim_end();
    // 块前的分隔线（---）也归应用管理，一并剥掉
    let before = before.strip_suffix("---").unwrap_or(before).trim_end();
    let after = content[end_idx..].trim_start_matches('\n');
    let mut clean = before.to_string();
    if !after.trim().is_empty() {
        clean.push('\n');
        clean.push_str(after.trim_end());
    }
    (clean, Some(parse_block(block_text)))
}

#[derive(Clone, Copy)]
enum Section {
    Posts,
    Materials,
    Versions,
}

fn parse_entries_into(vec: &mut Vec<AssocEntry>, line: &str) {
    let mut rest = line;
    while let Some(open) = rest.find('[') {
        let after_open = &rest[open + 1..];
        let Some(close) = after_open.find("](") else { break };
        let title = &after_open[..close];
        let after_link = &after_open[close + 2..];
        let Some(end) = after_link.find(')') else { break };
        let path = &after_link[..end];
        if !title.is_empty() && !path.is_empty() {
            vec.push(AssocEntry {
                title: title.to_string(),
                target: path.to_string(),
            });
        }
        rest = &after_link[end + 1..];
    }
}

fn parse_block(text: &str) -> AssocBlock {
    let mut block = AssocBlock::default();
    let mut cur: Option<Section> = None;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with(BEGIN_MARK) || t.starts_with(END_MARK) || t == "## 关联" || t == "---" {
            cur = None;
            continue;
        }
        if t.starts_with("**关联文稿**") {
            cur = Some(Section::Posts);
            parse_entries_into(&mut block.posts, t);
        } else if t.starts_with("**关联资料**") {
            cur = Some(Section::Materials);
            parse_entries_into(&mut block.materials, t);
        } else if t.starts_with("**发布版本**") {
            cur = Some(Section::Versions);
            parse_entries_into(&mut block.versions, t);
        } else if let Some(sec) = cur {
            match sec {
                Section::Posts => parse_entries_into(&mut block.posts, t),
                Section::Materials => parse_entries_into(&mut block.materials, t),
                Section::Versions => parse_entries_into(&mut block.versions, t),
            }
        }
    }
    block
}

/// 渲染关联块（含前置分隔线）；空块 → 空串。
pub fn render_assoc(block: &AssocBlock) -> String {
    if block.is_empty() {
        return String::new();
    }
    let mut out = String::from("---\n\n");
    out.push_str(BEGIN_MARK);
    out.push('\n');
    out.push_str("## 关联\n\n");
    let section = |out: &mut String, label: &str, entries: &[AssocEntry]| {
        if entries.is_empty() {
            return;
        }
        out.push_str(&format!(
            "**{label}**：{}\n\n",
            entries
                .iter()
                .map(|e| format!("[{}]({})", e.title, e.target))
                .collect::<Vec<_>>()
                .join("、")
        ));
    };
    section(&mut out, "关联文稿", &block.posts);
    section(&mut out, "关联资料", &block.materials);
    section(&mut out, "发布版本", &block.versions);
    out.push_str(END_MARK);
    out.push('\n');
    out
}

/// 纯正文 + 块 → 完整文件内容（body 已不含块；空块则原样）。
pub fn append_assoc(body: &str, block: &AssocBlock) -> String {
    let rendered = render_assoc(block);
    if rendered.is_empty() {
        return body.to_string();
    }
    format!("{}\n\n{}", body.trim_end(), rendered)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(t: &str, p: &str) -> AssocEntry {
        AssocEntry { title: t.into(), target: p.into() }
    }

    #[test]
    fn strip_and_reappend_roundtrip() {
        let mut block = AssocBlock {
            posts: vec![entry("深度工作", "posts/a.md")],
            materials: vec![entry("设计笔记", "kb/p/n.md")],
            versions: vec![],
        };
        let full = append_assoc("正文内容\n\n第二段", &block);
        let (clean, Some(parsed)) = strip_assoc(&full) else { unreachable!() };
        assert_eq!(clean, "正文内容\n\n第二段");
        assert_eq!(parsed, block);
        assert_eq!(append_assoc(&clean, &parsed), full);

        // 空块 → 没有块
        block.posts.clear();
        block.materials.clear();
        let empty = append_assoc("正文", &block);
        assert!(!empty.contains(BEGIN_MARK));
        assert_eq!(strip_assoc(&empty).1, None);
    }

    #[test]
    fn empty_sections_omitted() {
        let block = AssocBlock {
            posts: vec![],
            materials: vec![entry("资料", "kb/a.md")],
            versions: vec![entry("公众号版", ".versions/x/publish/wechat.md")],
        };
        let rendered = render_assoc(&block);
        assert!(!rendered.contains("**关联文稿**"));
        assert!(rendered.contains("**关联资料**：[资料](kb/a.md)"));
        assert!(rendered.contains("**发布版本**：[公众号版](.versions/x/publish/wechat.md)"));
    }

    #[test]
    fn manual_noise_inside_block_is_overwritten() {
        // 手动塞进块的杂项在重渲染后消失（块是应用维护区）
        let full = "正文\n\n---\n\n<!-- wb:assoc begin（应用维护区，手动修改会被覆盖） -->\n## 关联\n\n**关联文稿**：[A](posts/a.md) 还有手写的东西\n\n<!-- wb:assoc end -->\n";
        let (clean, Some(block)) = strip_assoc(full) else { unreachable!() };
        assert_eq!(clean, "正文");
        assert_eq!(block.posts, vec![entry("A", "posts/a.md")]);
        let re = render_assoc(&block);
        assert!(!re.contains("手写的东西"));
    }

    #[test]
    fn remove_target_across_sections() {
        let mut block = AssocBlock {
            posts: vec![entry("A", "posts/a.md"), entry("B", "posts/b.md")],
            materials: vec![entry("M", "kb/m.md")],
            versions: vec![entry("V", ".versions/a/publish/w.md")],
        };
        block.remove_target("posts/a.md");
        block.remove_target("kb/m.md");
        assert_eq!(block.posts, vec![entry("B", "posts/b.md")]);
        assert!(block.materials.is_empty());
        assert_eq!(block.versions.len(), 1);
    }

    #[test]
    fn block_after_body_with_trailing_newlines() {
        let full = "正文\n\n\n---\n\n<!-- wb:assoc begin（应用维护区，手动修改会被覆盖） -->\n## 关联\n\n**关联文稿**：[A](posts/a.md)\n\n<!-- wb:assoc end -->\n\n\n";
        let (clean, Some(_)) = strip_assoc(full) else { unreachable!() };
        assert_eq!(clean, "正文");
    }
}
