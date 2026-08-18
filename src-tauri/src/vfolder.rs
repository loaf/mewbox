use std::collections::BTreeMap;

/// 未分类桶名（固定排在树的最后）。
pub const UNCATEGORIZED: &str = "未分类";

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostRef {
    pub id: String,
    pub title: String,
    pub folder: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub name: String,
    pub children: BTreeMap<String, TreeNode>,
    pub posts: Vec<PostRef>,
}

#[derive(Debug, thiserror::Error)]
pub enum VFolderError {
    #[error("不能把目录移动到它自己的子目录下")]
    IntoDescendant,
}

/// folder 值规范（DESIGN-REVIEW 二轮 9）：
/// trim、去首尾 `/`、折叠连续 `//`；空 → None（未分类）。
pub fn normalize_folder(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let collapsed = trimmed
        .split('/')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    if collapsed.is_empty() {
        None
    } else {
        Some(collapsed)
    }
}

/// 由全体文稿的 folder 聚合生成虚拟目录树（DESIGN §4.4）。
/// 未分类固定为最后一个根节点（仅当存在未分类文稿时出现）。
pub fn build_tree(posts: &[PostRef]) -> Vec<TreeNode> {
    let mut roots: BTreeMap<String, TreeNode> = BTreeMap::new();
    let mut uncategorized: Vec<PostRef> = Vec::new();

    for p in posts {
        match normalize_folder(p.folder.as_deref().unwrap_or("")) {
            None => uncategorized.push(p.clone()),
            Some(path) => {
                let segs: Vec<&str> = path.split('/').collect();
                insert(&mut roots, &segs, p);
            }
        }
    }

    let mut result: Vec<TreeNode> = roots.into_values().collect();
    if !uncategorized.is_empty() {
        result.push(TreeNode {
            name: UNCATEGORIZED.to_string(),
            children: BTreeMap::new(),
            posts: uncategorized,
        });
    }
    result
}

fn insert(level: &mut BTreeMap<String, TreeNode>, segs: &[&str], p: &PostRef) {
    let (first, rest) = (segs[0], &segs[1..]);
    if rest.is_empty() {
        level
            .entry(first.to_string())
            .or_insert_with(|| TreeNode {
                name: first.to_string(),
                ..Default::default()
            })
            .posts
            .push(p.clone());
    } else {
        let child = level
            .entry(first.to_string())
            .or_insert_with(|| TreeNode {
                name: first.to_string(),
                ..Default::default()
            });
        insert(&mut child.children, rest, p);
    }
}

/// 重命名虚拟目录：整段等于 `from` 或以 `from/` 开头的 folder 才替换（防前缀误伤）。
/// `from` 是 `to` 的祖先时报错（不允许把目录挪进自己的子目录）。
pub fn rename_folder(
    posts: &[PostRef],
    from: &str,
    to: &str,
) -> Result<Vec<PostRef>, VFolderError> {
    let from = normalize_folder(from).ok_or(VFolderError::IntoDescendant)?;
    let to = normalize_folder(to).ok_or(VFolderError::IntoDescendant)?;
    let ancestor_prefix = format!("{}/", from);
    if to == from || to.starts_with(&ancestor_prefix) {
        return Err(VFolderError::IntoDescendant);
    }
    Ok(posts
        .iter()
        .map(|p| {
            let mut p = p.clone();
            if let Some(f) = &p.folder {
                let f = normalize_folder(f).unwrap_or_default();
                let new = if f == from {
                    to.clone()
                } else if let Some(rest) = f.strip_prefix(&ancestor_prefix) {
                    format!("{}/{}", to, rest)
                } else {
                    f
                };
                p.folder = Some(new);
            }
            p
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn post(id: &str, folder: Option<&str>) -> PostRef {
        PostRef {
            id: id.into(),
            title: format!("t{id}"),
            folder: folder.map(String::from),
        }
    }

    #[test]
    fn builds_tree_with_uncategorized_bucket() {
        let tree = build_tree(&[
            post("1", Some("技术/分布式")),
            post("2", Some("技术")),
            post("3", None),
        ]);
        assert_eq!(tree.len(), 2);
        assert_eq!(tree[0].name, "技术");
        assert!(tree[0].children.contains_key("分布式"));
        assert_eq!(tree[0].posts.len(), 1); // 直属 技术 的 post 2
        assert_eq!(
            tree[0].children["分布式"].posts,
            vec![post("1", Some("技术/分布式"))]
        );
        assert_eq!(tree[1].name, UNCATEGORIZED); // 未分类固定最后
        assert_eq!(tree[1].posts.len(), 1);
    }

    #[test]
    fn normalizes_folder_values() {
        assert_eq!(normalize_folder(" /技术//分布式/ "), Some("技术/分布式".into()));
        assert_eq!(normalize_folder(""), None);
        assert_eq!(normalize_folder("/"), None);
        assert_eq!(normalize_folder("技术"), Some("技术".into()));
    }

    #[test]
    fn rename_folder_batch_updates_prefix() {
        let items = vec![
            post("1", Some("技术/分布式")),
            post("2", Some("技术")),
            post("3", Some("技术前沿")),
        ];
        // 目标不能是 from 的子孙（防环）：改为同级新名
        let updated = rename_folder(&items, "技术", "后端笔记").unwrap();
        assert_eq!(updated[0].folder.as_deref(), Some("后端笔记/分布式"));
        assert_eq!(updated[1].folder.as_deref(), Some("后端笔记"));
        assert_eq!(updated[2].folder.as_deref(), Some("技术前沿")); // 前缀整段匹配，不误伤
    }

    #[test]
    fn rename_into_descendant_rejected() {
        let items = vec![post("1", Some("技术"))];
        assert!(rename_folder(&items, "技术", "技术/子").is_err());
        assert!(rename_folder(&items, "技术", "技术").is_err()); // 同名也不允许
    }
}
