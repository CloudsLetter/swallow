use keyring::Entry;

/// 系统密钥链服务名（稳定即可，与具体实体无关）。
const KEYRING_SERVICE: &str = "swallow";

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, key)
        .map_err(|e| format!("Failed to open keyring entry {key}: {e}"))
}

/// 保存秘密到系统密钥链。
pub fn set_secret(key: &str, value: &str) -> Result<(), String> {
    entry(key)?
        .set_password(value)
        .map_err(|e| format!("Failed to store secret in keyring ({key}): {e}"))
}

/// 读取秘密；条目不存在时返回 None。
pub fn get_secret(key: &str) -> Result<Option<String>, String> {
    match entry(key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Failed to read secret from keyring ({key}): {e}")),
    }
}

/// 删除秘密；条目不存在时视为成功。
pub fn delete_secret(key: &str) -> Result<(), String> {
    match entry(key)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Failed to delete secret from keyring ({key}): {e}")),
    }
}
