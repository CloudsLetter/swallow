use std::sync::{Arc, RwLock};

#[allow(dead_code)] // 应用元信息（脚手架预留，暂未接入 UI/文档）
const APPLICATION_NAME: &str = "Swallow";
pub const CODE: &str = "Swallow";
pub const CONFIG_FILE: &str = "config.toml";

#[allow(dead_code)]
const AUTHOR: &str = "CloudsLetter";
#[allow(dead_code)]
const EMAIL: &str = "woiuchigua@gmail.com";
#[allow(dead_code)]
const VERSION: &str = "0.1.0";
#[allow(dead_code)]
const DESCRIPTIVE: &str = "Swallow Application Rust Backend";


pub struct GlobaConfig {
    pub config: Arc<RwLock<crate::models::config::Config>>,
}



