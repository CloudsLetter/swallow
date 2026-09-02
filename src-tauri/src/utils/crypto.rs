use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use pbkdf2::pbkdf2_hmac;
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::Sha256;

/// 加密负载结构：salt + nonce + ciphertext，全部以 base64 拼成单一字符串。
/// 格式：`v1.{salt_b64}.{nonce_b64}.{cipher_b64}`

const PBKDF2_ITERATIONS: u32 = 100_000;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;

/// 从 server_key（用户输入的「服务器密钥」）经 PBKDF2-SHA256 派生 32 字节 AES 密钥。
fn derive_key(server_key: &str, salt: &[u8]) -> [u8; KEY_LEN] {
    let mut key = [0u8; KEY_LEN];
    pbkdf2_hmac::<Sha256>(
        server_key.as_bytes(),
        salt,
        PBKDF2_ITERATIONS,
        &mut key,
    );
    key
}

/// 加密明文数据，返回 `v1.{salt}.{nonce}.{cipher}` 格式的字符串。
pub fn encrypt(server_key: &str, plaintext: &[u8]) -> Result<String, String> {
    if server_key.is_empty() {
        return Err("服务器密钥为空，无法加密".to_string());
    }

    let mut salt = [0u8; SALT_LEN];
    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce_bytes);

    let key = derive_key(server_key, &salt);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| format!("加密失败: {e}"))?;

    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine as _;
    Ok(format!(
        "v1.{}.{}.{}",
        B64.encode(salt),
        B64.encode(nonce_bytes),
        B64.encode(ciphertext)
    ))
}

/// 解密 `v1.{salt}.{nonce}.{cipher}` 格式的字符串，返回明文。
pub fn decrypt(server_key: &str, payload: &str) -> Result<Vec<u8>, String> {
    if server_key.is_empty() {
        return Err("服务器密钥为空，无法解密".to_string());
    }

    let parts: Vec<&str> = payload.split('.').collect();
    if parts.len() != 4 || parts[0] != "v1" {
        return Err("数据包格式无效".to_string());
    }

    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine as _;

    let salt = B64.decode(parts[1]).map_err(|e| format!("salt 解码失败: {e}"))?;
    let nonce_bytes = B64
        .decode(parts[2])
        .map_err(|e| format!("nonce 解码失败: {e}"))?;
    let ciphertext = B64
        .decode(parts[3])
        .map_err(|e| format!("密文解码失败: {e}"))?;

    if nonce_bytes.len() != NONCE_LEN {
        return Err("nonce 长度无效".to_string());
    }

    let key = derive_key(server_key, &salt);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|_| "解密失败：服务器密钥不匹配或数据已损坏".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_encrypt_decrypt() {
        let key = "my-secret-key";
        let plaintext = "hello cloud sync 你好".as_bytes();
        let enc = encrypt(key, plaintext).expect("encrypt");
        let dec = decrypt(key, &enc).expect("decrypt");
        assert_eq!(dec, plaintext);
    }

    #[test]
    fn wrong_key_fails() {
        let enc = encrypt("correct-key", b"secret").expect("encrypt");
        assert!(decrypt("wrong-key", &enc).is_err());
    }

    #[test]
    fn empty_key_rejected() {
        assert!(encrypt("", b"x").is_err());
        assert!(decrypt("", "v1.xx.yy.zz").is_err());
    }

    #[test]
    fn unique_salt_and_nonce() {
        let a = encrypt("k", b"same").expect("a");
        let b = encrypt("k", b"same").expect("b");
        assert_ne!(a, b, "每次加密应产生不同密文（随机 salt/nonce）");
    }
}
