import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export type ChannelAccountSecret = Record<string, string | undefined>;

interface EncryptedSecretFile {
  version: 1;
  iv: string;
  tag: string;
  data: string;
  updated_at: string;
}

const CONFIG_DIR = path.join(DATA_DIR, 'config');
const SECRET_DIR = path.join(CONFIG_DIR, 'channel-accounts');
const KEY_FILE = path.join(CONFIG_DIR, 'claude-provider.key');
const SAFE_REF_RE = /^channel-account:[a-zA-Z0-9_-]+$/;

function getOrCreateKey(): Buffer {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.chmodSync(CONFIG_DIR, 0o700);
  const readExistingKey = (): Buffer => {
    fs.chmodSync(KEY_FILE, 0o600);
    const key = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
    if (key.length !== 32) throw new Error('Invalid encryption key file');
    return key;
  };
  if (fs.existsSync(KEY_FILE)) return readExistingKey();

  const key = crypto.randomBytes(32);
  const temporaryKeyFile = `${KEY_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryKeyFile, `${key.toString('hex')}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    // link(2) is an atomic no-replace publish. Unlike rename, it cannot
    // overwrite a key another HappyClaw process won the race to create.
    try {
      fs.linkSync(temporaryKeyFile, KEY_FILE);
      fs.chmodSync(KEY_FILE, 0o600);
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return readExistingKey();
    }
  } finally {
    fs.rmSync(temporaryKeyFile, { force: true });
  }
}

function refToPath(secretRef: string): string {
  if (!SAFE_REF_RE.test(secretRef)) throw new Error('Invalid secret reference');
  return path.join(
    SECRET_DIR,
    `${secretRef.slice('channel-account:'.length)}.json`,
  );
}

function atomicSecretWrite(filePath: string, body: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);
}

export function channelAccountSecretRef(accountId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(accountId))
    throw new Error('Invalid account ID');
  return `channel-account:${accountId}`;
}

export function saveChannelAccountSecret(
  secretRef: string,
  secret: ChannelAccountSecret,
): void {
  const key = getOrCreateKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(secret), 'utf8'),
    cipher.final(),
  ]);
  const payload: EncryptedSecretFile = {
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
    updated_at: new Date().toISOString(),
  };
  atomicSecretWrite(
    refToPath(secretRef),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
}

export function loadChannelAccountSecret(
  secretRef: string,
): ChannelAccountSecret | null {
  const filePath = refToPath(secretRef);
  if (!fs.existsSync(filePath)) return null;
  const payload = JSON.parse(
    fs.readFileSync(filePath, 'utf8'),
  ) as EncryptedSecretFile;
  if (payload.version !== 1) throw new Error('Unsupported secret version');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getOrCreateKey(),
    Buffer.from(payload.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(payload.data, 'base64')),
      decipher.final(),
    ]).toString('utf8'),
  ) as ChannelAccountSecret;
}

export function deleteChannelAccountSecret(secretRef: string): void {
  fs.rmSync(refToPath(secretRef), { force: true });
}

export function hasChannelAccountSecret(secretRef: string): boolean {
  return fs.existsSync(refToPath(secretRef));
}

/**
 * Seal a short secret for a database column with the same key as the
 * channel account files (AES-256-GCM): `v1:<iv>:<tag>:<data>`, base64.
 */
export function sealSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getOrCreateKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    data.toString('base64'),
  ].join(':');
}

export function openSecret(sealed: string): string {
  const [version, iv, tag, data] = sealed.split(':');
  if (version !== 'v1' || !iv || !tag || data === undefined) {
    throw new Error('Unsupported sealed secret');
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getOrCreateKey(),
    Buffer.from(iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
