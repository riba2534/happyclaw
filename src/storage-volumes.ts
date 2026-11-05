/**
 * Docker side of network storage mounts.
 *
 * NFS carries no secret, so it is an anonymous `local` volume spelled out in
 * the `--mount` argument and removed with the container (`--rm`).
 *
 * SMB needs a password, and everything in docker argv reaches `ps`, the
 * debug log and the per-run container log. The share therefore becomes a
 * named `local` volume created through the Docker Engine API, with the
 * password only in the request body, and the container mounts it by name.
 * Docker itself keeps volume options in its data directory (0600, root) and
 * returns them from `docker volume inspect`, so the SMB account should be a
 * dedicated one with no more rights than the mounts need; the Agent never
 * gets the Docker socket.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';

import { logger } from './logger.js';
import {
  cifsDriverOptions,
  readPasswordFile,
  type ResolvedStorage,
} from './storage-sources.js';

export const STORAGE_VOLUME_LABEL = 'io.happyclaw.storage-source';

/** How a VolumeMount reaches the container when it is not a host bind. */
export type VolumeMountStorage =
  | Extract<ResolvedStorage, { type: 'nfs' }>
  | Extract<ResolvedStorage, { type: 'cifs' }>
  | { type: 'named'; name: string };

/** Quotes one field of Docker's CSV-encoded `--mount` value. */
function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** The `--mount` value for a storage mount. A CIFS mount must be named first. */
export function storageMountArg(
  storage: VolumeMountStorage,
  containerPath: string,
  readonly: boolean,
): string {
  if (storage.type === 'cifs') {
    throw new Error(
      'An SMB mount must be created as a named volume before docker run',
    );
  }
  const head = ['type=volume'];
  if (storage.type === 'named') head.push(`src=${storage.name}`);
  head.push(`dst=${containerPath}`);
  if (readonly) head.push('readonly');
  const fields =
    storage.type === 'nfs'
      ? [
          ...head,
          'volume-driver=local',
          'volume-opt=type=nfs',
          `volume-opt=device=:${storage.device}`,
          `volume-opt=o=addr=${storage.server},${storage.options}`,
        ]
      : head;
  return fields.map(csvField).join(',');
}

interface EngineResponse {
  status: number;
  body: string;
}

export type EngineRequest = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<EngineResponse>;

let cachedSocketPath: string | null = null;

/** The current Docker context's unix socket (honours DOCKER_HOST/DOCKER_CONTEXT). */
function dockerSocketPath(): string {
  if (cachedSocketPath) return cachedSocketPath;
  const host = execFileSync(
    'docker',
    ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
    { encoding: 'utf8', timeout: 10_000 },
  ).trim();
  if (!host.startsWith('unix://')) {
    throw new Error(
      `SMB storage sources need a local Docker socket; the current context uses ${host || 'no endpoint'}`,
    );
  }
  cachedSocketPath = host.slice('unix://'.length);
  return cachedSocketPath;
}

const engineRequest: EngineRequest = (method, path, body) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request(
      {
        socketPath: dockerSocketPath(),
        path,
        method,
        headers: payload
          ? {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
            }
          : {},
        timeout: 30_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.on('timeout', () =>
      request.destroy(new Error('Docker Engine API request timed out')),
    );
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });

function engineMessage(response: EngineResponse): string {
  try {
    const parsed = JSON.parse(response.body) as { message?: unknown };
    if (typeof parsed.message === 'string') return parsed.message;
  } catch {
    // fall through to the status
  }
  return `HTTP ${response.status}`;
}

function sameOptions(
  actual: unknown,
  expected: Record<string, string>,
): boolean {
  if (typeof actual !== 'object' || actual === null) return false;
  const entries = Object.entries(actual as Record<string, unknown>);
  return (
    entries.length === Object.keys(expected).length &&
    entries.every(([key, value]) => expected[key] === value)
  );
}

/**
 * Creates (or reuses) the named volume for an SMB mount. The name hashes the
 * share, directory and options without the password, so a changed password
 * finds the same volume and replaces it once no container still uses it.
 */
export async function ensureCifsVolume(
  storage: Extract<ResolvedStorage, { type: 'cifs' }>,
  request: EngineRequest = engineRequest,
  readPassword: (file: string) => string = readPasswordFile,
): Promise<string> {
  const password = storage.passwordFile
    ? readPassword(storage.passwordFile)
    : undefined;
  const options = cifsDriverOptions(storage, password);
  const identity = cifsDriverOptions(storage, undefined);
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify(identity))
    .digest('hex')
    .slice(0, 16);
  const name = `happyclaw-storage-${storage.sourceId}-${digest}`;
  const volumePath = `/volumes/${encodeURIComponent(name)}`;

  const existing = await request('GET', volumePath);
  if (existing.status === 200) {
    let current: unknown;
    try {
      current = (JSON.parse(existing.body) as { Options?: unknown }).Options;
    } catch {
      current = undefined;
    }
    if (sameOptions(current, options)) return name;
    const removed = await request('DELETE', volumePath);
    if (removed.status === 409) {
      // A running container still has the share mounted with the old
      // credentials; it keeps working, and the next launch after it exits
      // picks up the new ones.
      logger.warn(
        { volume: name },
        'SMB credentials changed while the volume is in use; reusing it until it is free',
      );
      return name;
    }
    if (removed.status !== 204 && removed.status !== 404) {
      throw new Error(
        `Could not replace SMB volume ${name}: ${engineMessage(removed)}`,
      );
    }
  } else if (existing.status !== 404) {
    throw new Error(
      `Could not inspect SMB volume ${name}: ${engineMessage(existing)}`,
    );
  }

  const created = await request('POST', '/volumes/create', {
    Name: name,
    Driver: 'local',
    DriverOpts: options,
    Labels: { [STORAGE_VOLUME_LABEL]: storage.sourceId },
  });
  if (created.status !== 201 && created.status !== 200) {
    throw new Error(
      `Could not create SMB volume ${name}: ${engineMessage(created)}`,
    );
  }
  return name;
}
