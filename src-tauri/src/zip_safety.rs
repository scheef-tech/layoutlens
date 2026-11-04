//! Guards gallery ZIP imports against "Zip Slip" path traversal.
//!
//! Gallery ZIPs are exchanged between people (export_gallery / import_gallery), so entry
//! names are untrusted. Joining a name like `../../Library/LaunchAgents/x.plist` or an
//! absolute path onto the output directory would write outside of it.

use std::path::{Component, Path, PathBuf};

/// Returns the destination for `entry_name` inside `out_dir`, or `None` when the entry
/// would escape `out_dir` (absolute paths, `..` components, drive prefixes, NUL bytes).
pub fn safe_extract_path(out_dir: &Path, entry_name: &str) -> Option<PathBuf> {
    if entry_name.is_empty() || entry_name.contains('\0') {
        return None;
    }
    let mut relative = PathBuf::new();
    for component in Path::new(entry_name).components() {
        match component {
            Component::Normal(part) => relative.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    if relative.as_os_str().is_empty() {
        return None;
    }
    Some(out_dir.join(relative))
}

#[cfg(test)]
mod tests {
    use super::safe_extract_path;
    use std::path::{Path, PathBuf};

    const OUT: &str = "/data/runs/import-1";

    #[test]
    fn keeps_regular_entries_inside_out_dir() {
        let out = Path::new(OUT);
        assert_eq!(
            safe_extract_path(out, "de/375.png"),
            Some(PathBuf::from("/data/runs/import-1/de/375.png"))
        );
        assert_eq!(
            safe_extract_path(out, "./manifest.json"),
            Some(PathBuf::from("/data/runs/import-1/manifest.json"))
        );
        assert_eq!(
            safe_extract_path(out, "de/"),
            Some(PathBuf::from("/data/runs/import-1/de"))
        );
    }

    #[test]
    fn rejects_parent_dir_traversal() {
        let out = Path::new(OUT);
        assert_eq!(safe_extract_path(out, "../evil.sh"), None);
        assert_eq!(safe_extract_path(out, "de/../../evil.sh"), None);
        assert_eq!(
            safe_extract_path(out, "../../../../Library/LaunchAgents/x.plist"),
            None
        );
    }

    #[test]
    fn rejects_absolute_empty_and_nul_entries() {
        let out = Path::new(OUT);
        assert_eq!(safe_extract_path(out, "/etc/passwd"), None);
        assert_eq!(safe_extract_path(out, ""), None);
        assert_eq!(safe_extract_path(out, "."), None);
        assert_eq!(safe_extract_path(out, "a\0b"), None);
    }
}
