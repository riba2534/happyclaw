import { describe, expect, test } from 'vitest';

import {
  createHostDirectoryMountDraft,
  toAdditionalMountInputs,
  validateHostDirectoryMounts,
} from './HostDirectoryMountEditor';

describe('storage source mounts', () => {
  test('serialize with source, sub path and read-write choice', () => {
    const host = {
      ...createHostDirectoryMountDraft(),
      hostPath: '/srv/data',
      containerPath: 'data',
    };
    const storage = {
      ...createHostDirectoryMountDraft('storage', 'nas'),
      subPath: 'projects/alpha/',
      readonly: false,
      containerPath: 'alpha',
    };
    expect(validateHostDirectoryMounts([host, storage])).toEqual({});
    expect(toAdditionalMountInputs([host, storage])).toEqual([
      { host_path: '/srv/data', container_path: 'data', readonly: true },
      {
        source: 'nas',
        sub_path: 'projects/alpha',
        container_path: 'alpha',
        readonly: false,
      },
    ]);
  });

  test('default to the source id and reject unsafe sub paths', () => {
    const storage = createHostDirectoryMountDraft('storage', 'nas');
    expect(storage.containerPath).toBe('nas');
    expect(storage.readonly).toBe(true);
    for (const subPath of ['/abs', 'a/../b', '..', 'a\\b']) {
      expect(
        validateHostDirectoryMounts([{ ...storage, subPath }])[
          'additional_mounts.0.sub_path'
        ],
      ).toBeTruthy();
    }
    expect(
      validateHostDirectoryMounts([{ ...storage, source: '' }])[
        'additional_mounts.0.source'
      ],
    ).toBe('请选择存储源');
  });
});
