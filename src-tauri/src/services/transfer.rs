//! 分类导入导出：统一的信封格式与脱敏约定。
//!
//! 取代原先的「全量备份 JSON」（`export_app_config` / `import_app_config`）。
//! 每个类目各自拥有三个命令，互不牵连——导出一类不会顺带带走其它类的秘密：
//!
//! ```text
//! export_<category>(include_secrets: bool) -> String
//! export_<category>_to(target_path: String, include_secrets: bool) -> usize
//! import_<category>_text(text: String) -> usize
//! ```
//!
//! 信封格式（所有类目一致，`app` + `category` 用于导入侧的双重校验）：
//!
//! ```json
//! {
//!   "app": "swallow",
//!   "category": "accounts",
//!   "version": 1,
//!   "exportedAt": "2026-09-17T17:30:00+08:00",
//!   "includeSecrets": false,
//!   "count": 3,
//!   "items": []
//! }
//! ```
//!
//! 脱敏约定：`include_secrets` 为 `false`（默认，即前端不勾选）时，password /
//! passphrase 这类秘密字段被置为 `null`，文件因此可以安全地进版本库或发给同事；
//! 需要真正迁移凭据时再显式打开。
//!
//! 导入语义：**追加**（清空 id 后逐条新建），与既有 `import_hosts_text` 一致。
//! 因此重复导入同一份文件会产生重复条目；它面向的场景是「迁到新机器 / 补一批」，
//! 不是「回滚到某个快照」。

use serde::{de::DeserializeOwned, Deserialize, Serialize};

/// 导出文件的应用标识，导入时校验，避免把别的应用的 JSON 喂进来。
pub const EXPORT_APP: &str = "swallow";

/// 信封结构版本。与各类目自身的字段演进无关——类目内的向后兼容
/// 由各自结构体上的 `#[serde(default)]` 承担。
pub const EXPORT_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportEnvelope<T> {
    pub app: String,
    pub category: String,
    pub version: u32,
    pub exported_at: String,
    /// 该文件是否包含秘密字段的明文；导入侧据此提示用户「密码需要重输」。
    #[serde(default)]
    pub include_secrets: bool,
    pub count: usize,
    pub items: Vec<T>,
}

/// 组装导出信封（pretty JSON，便于人工查看与 diff）。
pub fn build<T: Serialize>(
    category: &str,
    include_secrets: bool,
    items: Vec<T>,
) -> Result<String, String> {
    let envelope = ExportEnvelope {
        app: EXPORT_APP.to_string(),
        category: category.to_string(),
        version: EXPORT_VERSION,
        exported_at: crate::utils::sqlite::now_iso(),
        include_secrets,
        count: items.len(),
        items,
    };
    serde_json::to_string_pretty(&envelope).map_err(|e| e.to_string())
}

/// 解析导入文本，兼容三种形态：
///
/// 1. **新信封** —— 校验 `app` 与 `category`，并把 `include_secrets` 透传给调用方
/// 2. **裸数组** —— 本模块上线前 `export_hosts` 的格式（无信封，视为可能含明文）
/// 3. **单对象** —— 手工写的单条记录
///
/// 返回 `(items, include_secrets)`。失败时整批报错，不会写入半截数据。
pub fn parse<T: DeserializeOwned>(category: &str, text: &str) -> Result<(Vec<T>, bool), String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("导入内容为空".to_string());
    }
    if let Ok(envelope) = serde_json::from_str::<ExportEnvelope<T>>(trimmed) {
        if envelope.app != EXPORT_APP {
            return Err("无法识别：不是 Swallow 导出的文件".to_string());
        }
        if envelope.category != category {
            return Err(format!(
                "类别不匹配：该文件是「{}」，当前导入的是「{}」",
                envelope.category, category
            ));
        }
        return Ok((envelope.items, envelope.include_secrets));
    }
    // 兜底：老格式（裸数组 / 单对象）。没有信封就无法确认类别，
    // 只能依赖 serde 反序列化本身能否匹配字段。
    if let Ok(items) = serde_json::from_str::<Vec<T>>(trimmed) {
        return Ok((items, true));
    }
    if let Ok(item) = serde_json::from_str::<T>(trimmed) {
        return Ok((vec![item], true));
    }
    Err(format!("无法识别：不是 Swallow「{}」的导出文件", category))
}

/// 写入用户选择的路径并返回条数。
///
/// Tauri 2 下 `<a download>` 失效，导出统一由后端直接落盘
/// （与 `export_known_hosts_to` 的既有做法一致）。
pub fn write_to(target_path: &str, content: &str, count: usize) -> Result<usize, String> {
    std::fs::write(target_path, content).map_err(|e| e.to_string())?;
    Ok(count)
}

/// 脱敏：把秘密字段清为 `null`。
///
/// 置 `null` 而不是删字段，是为了让文件读者仍能看出「这里原本是一个秘密」。
pub fn scrub(secret: &mut Option<String>) {
    secret.take();
}
