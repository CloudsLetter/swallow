use crate::utils::secrets;

pub(crate) fn store_secret_or_clear(key: &str, value: Option<&str>) -> Result<(), String> {
    match value {
        Some(v) if !v.is_empty() => secrets::set_secret(key, v),
        _ => secrets::delete_secret(key),
    }
}

/// 读取凭据：DB 中的明文优先（尚未迁移的旧数据），否则从密钥链取回。

pub(crate) fn resolve_secret(db_value: Option<String>, key: &str) -> Option<String> {
    if let Some(v) = db_value {
        if !v.is_empty() {
            return Some(v);
        }
    }
    match secrets::get_secret(key) {
        Ok(value) => value,
        Err(e) => {
            eprintln!("Failed to read secret from keyring ({key}): {e}");
            None
        }
    }
}


pub(crate) fn parse_tags(tags_json: Option<String>) -> Option<Vec<String>> {
    tags_json
        .and_then(|value| serde_json::from_str::<Vec<String>>(&value).ok())
        .filter(|value| !value.is_empty())
}


pub(crate) fn to_tags_json(tags: &Option<Vec<String>>) -> Option<String> {
    tags.as_ref()
        .filter(|value| !value.is_empty())
        .and_then(|value| serde_json::to_string(value).ok())
}
