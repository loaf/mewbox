use std::path::Path;

use sha2::{Digest, Sha256};

/// 附件指纹：sha256 前 16 位十六进制（DESIGN-REVIEW 复核细化：12–16 位，取 16）。
pub fn fingerprint(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    hex::encode(&digest[..8])
}

/// 保存附件到工作区级 _assets/ 池：指纹命名去重、写入后不可变
/// （已存在即复用，不覆盖）。返回 (指纹, 文件名)。
pub fn save_asset(
    ws: &crate::workspace::Workspace,
    bytes: &[u8],
    ext: &str,
) -> Result<(String, String), std::io::Error> {
    let fp = fingerprint(bytes);
    let filename = format!("{fp}.{ext}");
    let path = ws.root.join("_assets").join(&filename);
    if !path.exists() {
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(&tmp, &path)?;
    }
    Ok((fp, filename))
}

/// 从文稿路径指向附件的相对引用（/ 分隔，跨平台一致）。
/// posts/a.md → ../_assets/x.png；posts/2026/a.md → ../../_assets/x.png
pub fn relative_asset_path(post_path: &str, asset_name: &str) -> String {
    let post_dir = Path::new(post_path)
        .parent()
        .unwrap_or(Path::new(""));
    let target = Path::new("_assets").join(asset_name);
    let diff = pathdiff::diff_paths(&target, post_dir).unwrap_or_else(|| target.clone());
    diff.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::Workspace;

    #[test]
    fn same_bytes_dedup_to_one_file() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::init(dir.path()).unwrap();
        let (fp1, n1) = save_asset(&ws, b"image-bytes", "png").unwrap();
        let (fp2, n2) = save_asset(&ws, b"image-bytes", "png").unwrap();
        assert_eq!(fp1, fp2);
        assert_eq!(n1, n2);
        let count = std::fs::read_dir(ws.root.join("_assets")).unwrap().count();
        assert_eq!(count, 1);
    }

    #[test]
    fn different_bytes_two_files() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::init(dir.path()).unwrap();
        save_asset(&ws, b"aaa", "png").unwrap();
        save_asset(&ws, b"bbb", "png").unwrap();
        let count = std::fs::read_dir(ws.root.join("_assets")).unwrap().count();
        assert_eq!(count, 2);
    }

    #[test]
    fn relative_path_from_post() {
        assert_eq!(
            relative_asset_path("posts/a.md", "abc.png"),
            "../_assets/abc.png"
        );
        assert_eq!(
            relative_asset_path("posts/2026/a.md", "abc.png"),
            "../../_assets/abc.png"
        );
    }

    #[test]
    fn fingerprint_length_16_hex() {
        let fp = fingerprint(b"x");
        assert_eq!(fp.len(), 16);
        assert!(fp.chars().all(|c| c.is_ascii_hexdigit()));
        let (_, filename) = {
            let dir = tempfile::tempdir().unwrap();
            let ws = Workspace::init(dir.path()).unwrap();
            save_asset(&ws, b"x", "pdf").unwrap()
        };
        assert!(filename.ends_with(".pdf"));
        assert_eq!(filename.split('.').next().unwrap().len(), 16);
    }
}
