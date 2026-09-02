import { describe, it, expect } from 'vitest';
import { resolveHostSshAuth } from './sshAuthResolver';
import type { Host, Account, Key, Certificate } from './dataService';

function makeHost(partial: Partial<Host> = {}): Host {
  return {
    id: 'h1',
    name: 'test-host',
    host: 'example.com',
    port: 22,
    username: 'root',
    status: 'disconnected',
    ...partial,
  };
}

function makeAccount(partial: Partial<Account> = {}): Account {
  return {
    id: 'a1',
    name: 'test-account',
    username: 'deploy',
    authType: 'password',
    createdAt: '2026-01-01T00:00:00Z',
    ...partial,
  };
}

function makeKey(partial: Partial<Key> = {}): Key {
  return {
    id: 'k1',
    name: 'test-key',
    type: 'ED25519',
    fingerprint: 'SHA256:abc',
    createdAt: '2026-01-01T00:00:00Z',
    size: 256,
    ...partial,
  };
}

function makeCert(partial: Partial<Certificate> = {}): Certificate {
  return {
    id: 'c1',
    name: 'test-cert',
    certType: 'user',
    type: 'ED25519',
    fingerprint: 'SHA256:def',
    createdAt: '2026-01-01T00:00:00Z',
    principals: ['deploy'],
    hasPrivateKey: true,
    ...partial,
  };
}

describe('resolveHostSshAuth', () => {
  it('主机自身密码认证', () => {
    const host = makeHost({ authType: 'password', password: 'secret' });
    const result = resolveHostSshAuth(host, [], [], []);
    expect(result.authType).toBe('password');
    expect(result.username).toBe('root');
    expect(result.password).toBe('secret');
    expect(result.error).toBeUndefined();
  });

  it('账号优先：使用关联账号的认证信息', () => {
    const host = makeHost({ accountId: 'a1', authType: 'password', password: 'host-pass' });
    const account = makeAccount({ id: 'a1', username: 'deploy', password: 'account-pass' });
    const result = resolveHostSshAuth(host, [account], [], []);
    expect(result.username).toBe('deploy');
    expect(result.password).toBe('account-pass');
  });

  it('账号回退：关联账号不存在时回退主机自身', () => {
    const host = makeHost({ accountId: 'missing', authType: 'password', password: 'host-pass' });
    const result = resolveHostSshAuth(host, [], [], []);
    expect(result.username).toBe('root');
    expect(result.password).toBe('host-pass');
  });

  it('key 认证成功', () => {
    const host = makeHost({ authType: 'key', keyId: 'k1' });
    const key = makeKey({ id: 'k1' });
    const result = resolveHostSshAuth(host, [], [key], []);
    expect(result.authType).toBe('key');
    expect(result.keyId).toBe('k1');
    expect(result.error).toBeUndefined();
  });

  it('key 认证失败：密钥不存在', () => {
    const host = makeHost({ authType: 'key', keyId: 'missing' });
    const result = resolveHostSshAuth(host, [], [], []);
    expect(result.error).toBeTruthy();
  });

  it('certificate 认证成功（含私钥）', () => {
    const host = makeHost({ authType: 'certificate', certificateId: 'c1' });
    const cert = makeCert({ id: 'c1', hasPrivateKey: true });
    const result = resolveHostSshAuth(host, [], [], [cert]);
    expect(result.authType).toBe('certificate');
    expect(result.certId).toBe('c1');
    expect(result.error).toBeUndefined();
  });

  it('certificate 认证失败：证书不存在', () => {
    const host = makeHost({ authType: 'certificate', certificateId: 'missing' });
    const result = resolveHostSshAuth(host, [], [], []);
    expect(result.error).toBeTruthy();
  });

  it('certificate 认证失败：证书未绑定私钥', () => {
    const host = makeHost({ authType: 'certificate', certificateId: 'c1' });
    const cert = makeCert({ id: 'c1', hasPrivateKey: false });
    const result = resolveHostSshAuth(host, [], [], [cert]);
    expect(result.error).toBeTruthy();
  });

  it('无认证信息时报错', () => {
    const host = makeHost({});
    const result = resolveHostSshAuth(host, [], [], []);
    expect(result.authType).toBe('none');
    expect(result.error).toBeTruthy();
  });
});
