use serde::Serialize;
use std::path::Path;

/// 本机目录条目。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
}

/// 本机目录列表结果：entries 为按「目录优先 + 名称」排序的直接子项。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDirListing {
    pub path: String,
    /// 上级目录路径（根为 None / 顶层盘符视界为 None）
    pub parent: Option<String>,
    pub entries: Vec<LocalFsEntry>,
}

fn file_meta(p: &Path) -> (bool, u64, u64) {
    match p.metadata() {
        Ok(m) => (
            m.is_dir(),
            m.len(),
            m.modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0),
        ),
        Err(_) => (false, 0, 0),
    }
}

/// 列出本机目录。path 为空时：Windows 返回可访问的盘符根，其他平台返回 "/"。
/// 供 SFTP 双栏（本机 ⇄ 远程）浏览本地目录使用。
#[tauri::command]
pub fn list_local_directory(path: String) -> Result<LocalDirListing, String> {
    // 顶层视界：Windows 盘符 / Unix 根
    if path.trim().is_empty() {
        let mut entries = Vec::new();
        #[cfg(target_os = "windows")]
        for letter in b'A'..=b'Z' {
            let drive = format!("{}:\\", char::from(letter));
            let p = Path::new(&drive);
            if p.is_dir() {
                let (_, _, modified) = file_meta(p);
                entries.push(LocalFsEntry {
                    name: drive.clone(),
                    path: drive,
                    is_dir: true,
                    size: 0,
                    modified,
                });
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            entries.push(LocalFsEntry {
                name: "/".into(),
                path: "/".into(),
                is_dir: true,
                size: 0,
                modified: 0,
            });
        }
        if entries.is_empty() {
            return Err("未找到可访问的磁盘".into());
        }
        return Ok(LocalDirListing {
            path: String::new(),
            parent: None,
            entries,
        });
    }

    let dir = Path::new(&path);
    let read = std::fs::read_dir(dir).map_err(|e| format!("无法读取 {}: {e}", dir.display()))?;
    let mut entries: Vec<LocalFsEntry> = Vec::new();
    for item in read.flatten() {
        let name = item.file_name().to_string_lossy().into_owned();
        let child = item.path();
        let (is_dir, size, modified) = file_meta(&child);
        entries.push(LocalFsEntry {
            name,
            path: child.to_string_lossy().into_owned(),
            is_dir,
            size,
            modified,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    let parent = dir.parent().map(|p| p.to_string_lossy().into_owned());
    Ok(LocalDirListing {
        path: path.clone(),
        parent,
        entries,
    })
}
