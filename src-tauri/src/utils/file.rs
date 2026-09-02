use std::{fs, io};
use std::io::{ErrorKind, Write};
use std::path::PathBuf;
use tempfile::NamedTempFile;
use serde::de::DeserializeOwned;
use serde::Serialize;
use base64::Engine;
use crate::config::global_config;
use crate::config::global_enum::FileFormat;
use crate::utils::path::app_config_dir;
use crate::models;

/// 把本地图片文件读为 data URL，供前端 `<img>`/CSS 背景直接使用。
/// 仅接受图片扩展名，并限制大小，避免把任意大文件读进内存。
pub fn read_image_as_data_url(path: &str) -> io::Result<String> {
    const MAX_BYTES: u64 = 20 * 1024 * 1024; // 20MB

    let mime = match std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("svg") => "image/svg+xml",
        Some("ico") => "image/x-icon",
        Some("avif") => "image/avif",
        _ => {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "unsupported image format",
            ))
        }
    };

    let meta = fs::metadata(path)?;
    if meta.len() > MAX_BYTES {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            "image too large (max 20MB)",
        ));
    }

    let bytes = fs::read(path)?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}
#[allow(dead_code)] // 目录确保工具（预留，供云同步缓存/导出路径使用）
pub fn ensure_directory_exist(dir_path: &str) -> io::Result<()> {
    fs::create_dir_all(dir_path)?;
    Ok(())
}

pub fn read_file_generic<T: DeserializeOwned>(
    file_path: &str,
    format: FileFormat,
) -> io::Result<T> {
    let content = fs::read_to_string(file_path)?;
    let data: T = match format {
        FileFormat::Toml => {
            toml::from_str(&content)
                .map_err(|e| io::Error::new(ErrorKind::InvalidData, format!("TOML Deserialize Error: {}", e)))?
        }
        FileFormat::Json => {
            serde_json::from_str(&content)
                .map_err(|e| io::Error::new(ErrorKind::InvalidData, format!("JSON Deserialize Error: {}", e)))?
        }
        FileFormat::Yaml => {
            serde_yaml::from_str(&content)
                .map_err(|e| io::Error::new(ErrorKind::InvalidData, format!("YAML Deserialize Error: {}", e)))?
        }
    };

    Ok(data)
}
pub fn write_file_generic<T: Serialize>(
    file_path: &PathBuf,
    data: &T,
    format: FileFormat,
) -> io::Result<()> {
    let serialized_data = match format {
        FileFormat::Toml => {
            toml::to_string_pretty(data)
                .map_err(|e| io::Error::new(ErrorKind::Other, format!("TOML Serialize Error: {}", e)))?
        }
        FileFormat::Json => {
            serde_json::to_string_pretty(data)
                .map_err(|e| io::Error::new(ErrorKind::Other, format!("JSON Serialize Error: {}", e)))?
        }
        FileFormat::Yaml => {
            serde_yaml::to_string(data)
                .map_err(|e| io::Error::new(ErrorKind::Other, format!("YAML Serialize Error: {}", e)))?
        }
    };

    // 2. 文件 I/O：先写同目录临时文件，再原子替换目标文件，
    //    避免写入中途崩溃留下半截配置（Windows 上由 tempfile 使用覆盖语义）。
    let parent = file_path.parent().ok_or_else(|| {
        io::Error::new(
            ErrorKind::InvalidInput,
            format!("Invalid file path: {:?}", file_path),
        )
    })?;
    let mut tmp = NamedTempFile::new_in(parent)?;
    tmp.write_all(serialized_data.as_bytes())?;
    tmp.flush()?;
    tmp.persist(file_path).map_err(|e| e.error)?;
    Ok(())
}

pub fn init_config() -> io::Result<models::config::Config> {
    let config_dir = app_config_dir();
    let config_path = config_dir.join(global_config::CONFIG_FILE);

    if !config_path.exists() {
        let default_config = models::config::Config::default();
        write_file_generic(
            &config_path,
            &default_config,
            FileFormat::Toml,
        )?;
        return Ok(default_config);
    }

    let config = match read_file_generic::<models::config::Config>(
        config_path.to_str().unwrap(),
        FileFormat::Toml,
    ) {
        Ok(config) => config,
        Err(err) => {
            // 配置缺失字段已由 serde default 兜底；走到这里说明文件损坏或无法解析。
            // 先备份原文件，再回退默认配置，避免启动崩溃。
            eprintln!(
                "Failed to read config ({}), backing up and resetting to defaults",
                err
            );
            let backup_path = config_path.with_extension("toml.bak");
            let _ = fs::copy(&config_path, &backup_path);

            let default_config = models::config::Config::default();
            write_file_generic(
                &config_path,
                &default_config,
                FileFormat::Toml,
            )?;
            return Ok(default_config);
        }
    };

    let refreshed_config = config
        .clone()
        .refresh_builtin_themes()
        .refresh_builtin_terminal_themes();

    if toml::to_string(&config).ok() != toml::to_string(&refreshed_config).ok() {
        write_file_generic(
            &config_path,
            &refreshed_config,
            FileFormat::Toml,
        )?;
    }

    Ok(refreshed_config)
}
