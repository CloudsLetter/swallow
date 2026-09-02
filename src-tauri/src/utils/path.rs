use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::config::global_config::CODE;

/* ================= 系统级目录缓存 ================= */

static HOME_DIR: OnceLock<PathBuf> = OnceLock::new();
static CONFIG_DIR: OnceLock<PathBuf> = OnceLock::new();
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();
#[allow(dead_code)] // 缓存目录预留
static CACHE_DIR: OnceLock<PathBuf> = OnceLock::new();

/* ================= 应用级目录缓存 ================= */

static APP_CONFIG_DIR: OnceLock<PathBuf> = OnceLock::new();
static APP_DATA_DIR: OnceLock<PathBuf> = OnceLock::new();
#[allow(dead_code)] // 应用缓存目录预留
static APP_CACHE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// 用户 Home 目录
pub fn home_dir() -> &'static PathBuf {
    HOME_DIR.get_or_init(|| {
        dirs::home_dir()
            .expect("System home directory not available")
    })
}

/// 系统配置目录
pub fn config_dir() -> &'static PathBuf {
    CONFIG_DIR.get_or_init(|| {
        dirs::config_dir()
            .expect("System config directory not available")
    })
}

/// 系统数据目录
pub fn data_dir() -> &'static PathBuf {
    DATA_DIR.get_or_init(|| {
        dirs::data_dir()
            .expect("System data directory not available")
    })
}

/// 系统缓存目录
#[allow(dead_code)] // 缓存目录预留
pub fn cache_dir() -> &'static PathBuf {
    CACHE_DIR.get_or_init(|| {
        dirs::cache_dir()
            .expect("System cache directory not available")
    })
}

/// 确保目录存在
pub fn ensure_dir<P: AsRef<Path>>(path: P) {
    if let Err(e) = std::fs::create_dir_all(path.as_ref()) {
        panic!("Failed to create directory {:?}: {}", path.as_ref(), e);
    }
}

/// 应用配置目录
pub fn app_config_dir() -> &'static PathBuf {
    APP_CONFIG_DIR.get_or_init(|| {
        let dir = config_dir().join(CODE);
        ensure_dir(&dir);
        dir
    })
}

/// 应用数据目录
pub fn app_data_dir() -> &'static PathBuf {
    APP_DATA_DIR.get_or_init(|| {
        let dir = data_dir().join(CODE);
        ensure_dir(&dir);
        dir
    })
}

/// 应用缓存目录
#[allow(dead_code)] // 缓存目录预留
pub fn app_cache_dir() -> &'static PathBuf {
    APP_CACHE_DIR.get_or_init(|| {
        let dir = cache_dir().join(CODE);
        ensure_dir(&dir);
        dir
    })
}
