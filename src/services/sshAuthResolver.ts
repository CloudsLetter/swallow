import type { Host, Account, Key, Certificate } from './dataService';
import i18n from '../i18n/i18n';

export type SshAuthType = 'password' | 'key' | 'certificate' | 'none';

export interface HostSshAuth {
  authType: SshAuthType;
  username: string;
  password?: string;
  /** 密钥认证用的数据库密钥记录 ID（后端据此读取密钥内容做内存认证） */
  keyId?: string;
  /** 证书认证用的数据库证书记录 ID（后端据此读取证书与配套私钥内容） */
  certId?: string;
  /** 解析失败原因，非空时不可发起连接 */
  error?: string;
}

/**
 * 统一解析主机的 SSH 认证信息：优先使用关联账号，回退到主机自身字段。
 * 返回 error 时表示当前配置无法发起连接（由调用方负责提示）。
 */
export function resolveHostSshAuth(
  host: Host,
  accounts: Account[],
  keys: Key[],
  certs: Certificate[],
): HostSshAuth {
  const account = host.accountId ? accounts.find((item) => item.id === host.accountId) : undefined;
  const rawAuthType = account?.authType || host.authType;
  const username = account?.username || host.username;

  if (rawAuthType === 'certificate') {
    const certId = account?.certificateId ?? host.certificateId;
    const cert = certId ? certs.find((item) => item.id === certId) : undefined;
    if (!cert?.id) {
      return {
        authType: 'certificate',
        username,
        error: i18n.t('auth.certDeleted'),
      };
    }
    if (!cert.hasPrivateKey) {
      return {
        authType: 'certificate',
        username,
        error: i18n.t('auth.certNoKey'),
      };
    }
    return { authType: 'certificate', username, certId: cert.id };
  }

  if (rawAuthType === 'key') {
    const keyId = account?.keyId ?? host.keyId;
    const key = keyId ? keys.find((item) => item.id === keyId) : undefined;
    if (!key?.id) {
      return { authType: 'key', username, error: i18n.t('auth.noKey') };
    }
    return { authType: 'key', username, keyId: key.id };
  }

  if (rawAuthType === 'password') {
    return { authType: 'password', username, password: account?.password ?? host.password };
  }

  return {
    authType: 'none',
    username,
    error: i18n.t('auth.noAuthInfo'),
  };
}
