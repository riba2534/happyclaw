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
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';

import { WEB_SESSION_SECRET } from './config.js';
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

/**
 * The current Docker context's unix socket (honours DOCKER_HOST and
 * DOCKER_CONTEXT). Resolved for every volume, never cached: the docker CLI
 * that starts the container follows the current context, and a volume
 * created on another daemon would leave `docker run` to create an empty local
 * volume of the same name in place of the share.
 */
export function currentDockerSocket(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
      { encoding: 'utf8', timeout: 10_000 },
      (err, stdout) => {
        if (err) {
          reject(
            new Error(`Could not resolve the Docker context: ${err.message}`),
          );
          return;
        }
        const host = stdout.trim();
        if (!host.startsWith('unix://')) {
          reject(
            new Error(
              `SMB storage sources need a local Docker socket; the current context uses ${host || 'no endpoint'}`,
            ),
          );
          return;
        }
        resolve(host.slice('unix://'.length));
      },
    );
  });
}

/** Engine API requests over a unix socket; settles even if the daemon hangs up. */
export function createEngineRequest(
  socketPath: string,
  timeoutMs = 30_000,
): EngineRequest {
  return (method, requestPath, body) =>
    new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const request = http.request(
        {
          socketPath,
          path: requestPath,
          method,
          headers: payload
            ? {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
              }
            : {},
          timeout: timeoutMs,
        },
        (response) => {
          const chunks: Buffer[] = [];
          const cutOff = () =>
            fail(new Error('Docker Engine API response was cut off'));
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('aborted', cutOff);
          response.on('error', (err) => fail(err));
          response.on('close', () => {
            if (!response.complete) cutOff();
          });
          response.on('end', () => {
            if (settled) return;
            settled = true;
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        },
      );
      request.on('timeout', () =>
        request.destroy(new Error('Docker Engine API request timed out')),
      );
      request.on('error', fail);
      if (payload) request.write(payload);
      request.end();
    });
}

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
 * The named volume for an SMB mount. The first digest covers the share,
 * directory and options without the password; the second is the credential
 * version, an HMAC of the password under a server-side key, so a new password
 * gets a new volume while containers still holding the old one keep it.
 */
export function cifsVolumeName(
  storage: Extract<ResolvedStorage, { type: 'cifs' }>,
  password: string | undefined,
  credentialKey: string,
): string {
  const identity = crypto
    .createHash('sha256')
    .update(JSON.stringify(cifsDriverOptions(storage, undefined)))
    .digest('hex')
    .slice(0, 16);
  const credential = crypto
    .createHmac('sha256', credentialKey)
    .update(`happyclaw-storage-volume-credential\u0000${password ?? ''}`)
    .digest('hex')
    .slice(0, 8);
  return `happyclaw-storage-${storage.sourceId}-${identity}-${credential}`;
}

const volumeQueues = new Map<string, Promise<unknown>>();

/** Runs ensure steps for one volume name one at a time within this process. */
function serializedByVolume<T>(name: string, run: () => Promise<T>) {
  const previous = volumeQueues.get(name) ?? Promise.resolve();
  const current = previous.then(run, run);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  volumeQueues.set(name, settled);
  void settled.then(() => {
    if (volumeQueues.get(name) === settled) volumeQueues.delete(name);
  });
  return current;
}

export interface EnsureCifsVolumeDeps {
  /** Engine API transport; defaults to the current Docker context's socket. */
  request?: EngineRequest;
  resolveSocket?: () => Promise<string>;
  readPassword?: (file: string) => string;
  /** Key for the credential version in the volume name. */
  credentialKey?: string;
}

/**
 * Creates (or reuses) the named volume for an SMB mount, on the daemon of the
 * current Docker context. A volume of that name whose options differ is not
 * one HappyClaw made (most likely Docker created it empty because it was
 * missing when a container started): it is replaced when free and fails the
 * launch while in use, never mounted in place of the share.
 */
export async function ensureCifsVolume(
  storage: Extract<ResolvedStorage, { type: 'cifs' }>,
  deps: EnsureCifsVolumeDeps = {},
): Promise<string> {
  const readPassword = deps.readPassword ?? readPasswordFile;
  const password = storage.passwordFile
    ? readPassword(storage.passwordFile)
    : undefined;
  const options = cifsDriverOptions(storage, password);
  const name = cifsVolumeName(
    storage,
    password,
    deps.credentialKey ?? WEB_SESSION_SECRET,
  );
  const volumePath = `/volumes/${encodeURIComponent(name)}`;

  return serializedByVolume(name, async () => {
    const request =
      deps.request ??
      createEngineRequest(await (deps.resolveSocket ?? currentDockerSocket)());
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
        throw new Error(
          `Docker volume ${name} exists without the SMB mount options and is in use, so it is not the share. Remove the containers that use it (docker ps -a --filter volume=${name}) and then the volume (docker volume rm ${name})`,
        );
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
  });
}
