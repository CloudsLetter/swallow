#[derive(Debug, Clone, Copy)]
#[allow(dead_code)] // Json/Yaml 为文件读写 API 预留（当前仅 Toml 被使用，分支见 utils/file.rs）
pub enum FileFormat {
    Toml,
    Json,
    Yaml,
}
