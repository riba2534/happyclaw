// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  CrossOriginImageError,
  DownloadError,
  fetchImageFile,
  saveImageFile,
} from './download';
import {
  PNG,
  captureDownloads,
  respondWith,
  stubShare,
  unstubShare,
} from './download-test-utils';

const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46];
const GIF = [...'GIF89a'].map((c) => c.charCodeAt(0));
const WEBP = [...'RIFF\0\0\0\0WEBPVP8 '].map((c) => c.charCodeAt(0));

const fetchMock = vi.fn<typeof fetch>();
let downloads: string[] = [];

const serve = (bytes: number[], type?: string) =>
  fetchMock.mockImplementation(respondWith(bytes, type));

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  downloads = captureDownloads();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetchMock.mockReset();
  unstubShare();
  document.head.querySelector('base')?.remove();
});

describe('fetchImageFile', () => {
  test('an octet-stream JPEG is typed image/jpeg and named .jpg', async () => {
    serve(JPEG);
    const file = await fetchImageFile('/api/groups/w/files/download/eA');
    expect(file.type).toBe('image/jpeg');
    expect(file.name).toMatch(/^image-\d+\.jpg$/);
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual(JPEG);

    expect((await fetchImageFile('/x', '月报')).name).toBe('月报.jpg');
    // The bytes win over a name that says otherwise.
    expect((await fetchImageFile('/x', 'chart.png')).name).toBe('chart.jpg');
  });

  test.each([
    ['PNG', PNG, 'image/png', 'png'],
    ['GIF', GIF, 'image/gif', 'gif'],
    ['WebP', WEBP, 'image/webp', 'webp'],
  ])('reads a %s from its first bytes', async (_, bytes, type, ext) => {
    serve(bytes);
    const file = await fetchImageFile('/x', 'shot');
    expect(file.type).toBe(type);
    expect(file.name).toBe(`shot.${ext}`);
  });

  test('bytes it cannot read are typed by the name, then the URL', async () => {
    serve([0x3c, 0x73, 0x76, 0x67]);
    const named = await fetchImageFile('/x', 'diagram.svg');
    expect(named.type).toBe('image/svg+xml');
    expect(named.name).toBe('diagram.svg');

    const fromUrl = await fetchImageFile('/media/plot.avif');
    expect(fromUrl.type).toBe('image/avif');
    expect(fromUrl.name).toMatch(/^image-\d+\.avif$/);
  });

  test('a declared image type stands, and a name that matches it', async () => {
    serve(PNG, 'image/jpeg');
    const file = await fetchImageFile('/x', 'photo.jpeg');
    expect(file.type).toBe('image/jpeg');
    expect(file.name).toBe('photo.jpeg');
  });

  test('resolves src as the <img> does, cookies to this origin only', async () => {
    serve(PNG, 'image/png');
    const base = document.createElement('base');
    base.href = 'http://localhost:3000/claw/';
    document.head.appendChild(base);

    await fetchImageFile('/api/groups/w/messages/m/attachments/0/original');
    await fetchImageFile('api/files/a.png');
    await fetchImageFile('https://img.example.com/a.png');

    expect(
      fetchMock.mock.calls.map(([url, init]) => [url, init?.credentials]),
    ).toEqual([
      [
        'http://localhost:3000/api/groups/w/messages/m/attachments/0/original',
        'same-origin',
      ],
      ['http://localhost:3000/claw/api/files/a.png', 'same-origin'],
      ['https://img.example.com/a.png', 'omit'],
    ]);
  });

  test('another site that blocks the read is told apart', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(
      fetchImageFile('https://img.example.com/a.png'),
    ).rejects.toBeInstanceOf(CrossOriginImageError);
    // On this origin the same failure is the network's.
    await expect(fetchImageFile('/x')).rejects.toBeInstanceOf(TypeError);
  });

  test('an error status fails with the server message', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: 'File not found' }, { status: 404 }),
    );
    const err = await fetchImageFile('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DownloadError);
    expect(err).toMatchObject({ status: 404, message: 'File not found' });
  });
});

describe('saveImageFile', () => {
  const file = () =>
    new File([new Uint8Array(PNG)], 'a.png', { type: 'image/png' });

  test('off iOS it downloads, even where the share sheet takes files', async () => {
    const share = stubShare(undefined, { iOS: false });
    await saveImageFile(file());
    expect(share).not.toHaveBeenCalled();
    expect(downloads).toEqual(['a.png']);
  });

  test('on iOS it opens the share sheet with the file', async () => {
    const share = stubShare();
    const saved = file();
    await saveImageFile(saved);
    expect(share).toHaveBeenCalledWith({ files: [saved] });
    expect(downloads).toEqual([]);
  });

  test('a sheet refused for want of a tap falls back to the download', async () => {
    stubShare(async () => {
      throw new DOMException('no activation', 'NotAllowedError');
    });
    await saveImageFile(file());
    expect(downloads).toEqual(['a.png']);
  });

  test('a sheet the user dismisses ends quietly', async () => {
    stubShare(async () => {
      throw new DOMException('cancelled', 'AbortError');
    });
    await expect(saveImageFile(file())).resolves.toBeUndefined();
    expect(downloads).toEqual([]);
  });

  test('any other share failure is reported', async () => {
    stubShare(async () => {
      throw new DOMException('bad file', 'DataError');
    });
    await expect(saveImageFile(file())).rejects.toMatchObject({
      name: 'DataError',
    });
    expect(downloads).toEqual([]);
  });
});
