import { describe, expect, test } from 'vitest';
import {
  applyChannelAccountRegistrationFallback,
  resolveChannelAccountFallbackWorkspace,
} from '../src/channel-account-routing.js';
import type { ChannelAccount } from '../src/types.js';

const baseGroup = {
  name: 'IM group',
  folder: 'home',
  added_at: '2026-07-14T00:00:00.000Z',
};

describe('channel account registration fallback', () => {
  test('applies account workspace only to an unbound first registration', () => {
    expect(
      applyChannelAccountRegistrationFallback(
        baseGroup,
        'bot-a',
        'web:account-default',
      ),
    ).toMatchObject({
      channel_account_id: 'bot-a',
      target_main_jid: 'web:account-default',
    });
  });

  test('preserves explicit workspace and session bindings on later messages', () => {
    const workspaceBound = applyChannelAccountRegistrationFallback(
      {
        ...baseGroup,
        channel_account_id: 'bot-a',
        target_main_jid: 'web:user-selected',
      },
      'bot-a',
      'web:account-default',
    );
    expect(workspaceBound.target_main_jid).toBe('web:user-selected');

    const sessionBound = applyChannelAccountRegistrationFallback(
      {
        ...baseGroup,
        channel_account_id: 'bot-a',
        target_agent_id: 'conversation-123',
      },
      'bot-a',
      'web:account-default',
    );
    expect(sessionBound).toMatchObject({
      target_agent_id: 'conversation-123',
      channel_account_id: 'bot-a',
    });
    expect(sessionBound.target_main_jid).toBeUndefined();
  });

  test('returns the identical object for an already-attached group', () => {
    // Callers use reference equality to skip persistence on the per-message
    // hot path; a value-equal copy would silently rewrite the row each time.
    const attached = {
      ...baseGroup,
      channel_account_id: 'bot-a',
      target_main_jid: 'web:user-selected',
    };
    expect(
      applyChannelAccountRegistrationFallback(
        attached,
        'bot-a',
        'web:account-default',
      ),
    ).toBe(attached);

    const fallbackBound = {
      ...baseGroup,
      channel_account_id: 'bot-a',
      target_main_jid: 'web:account-default',
    };
    expect(
      applyChannelAccountRegistrationFallback(
        fallbackBound,
        'bot-a',
        'web:account-default',
      ),
    ).toBe(fallbackBound);
  });

  test('does not bind an unbound direct chat to the account default workspace', () => {
    expect(
      applyChannelAccountRegistrationFallback(
        baseGroup,
        'bot-a',
        'web:account-default',
        'direct',
      ),
    ).toMatchObject({
      channel_account_id: 'bot-a',
    });
    expect(
      applyChannelAccountRegistrationFallback(
        baseGroup,
        'bot-a',
        'web:account-default',
        'direct',
      ).target_main_jid,
    ).toBeUndefined();
  });

  test('still binds an unbound group chat to the account default workspace', () => {
    expect(
      applyChannelAccountRegistrationFallback(
        baseGroup,
        'bot-a',
        'web:account-default',
        'group',
      ),
    ).toMatchObject({
      channel_account_id: 'bot-a',
      target_main_jid: 'web:account-default',
    });
  });

  test('preserves a manual workspace or session bind on a direct chat', () => {
    const workspaceBound = {
      ...baseGroup,
      channel_account_id: 'bot-a',
      target_main_jid: 'web:user-selected',
    };
    expect(
      applyChannelAccountRegistrationFallback(
        workspaceBound,
        'bot-a',
        'web:account-default',
        'direct',
      ),
    ).toBe(workspaceBound);

    const sessionBound = {
      ...baseGroup,
      channel_account_id: 'bot-a',
      target_agent_id: 'conversation-123',
    };
    expect(
      applyChannelAccountRegistrationFallback(
        sessionBound,
        'bot-a',
        'web:account-default',
        'direct',
      ),
    ).toBe(sessionBound);
  });

  test('uses explicit workspace then home, never an Agent first-workspace fallback', () => {
    const account = {
      owner_user_id: 'owner',
      default_agent_profile_id: 'deprecated-agent-default',
      default_workspace_jid: null,
    } as ChannelAccount;
    expect(
      resolveChannelAccountFallbackWorkspace(account, {
        getGroup: () => undefined,
        getHome: () => ({ ...baseGroup, jid: 'web:owner-home' }),
      }),
    ).toEqual({ jid: 'web:owner-home', folder: 'home' });

    expect(
      resolveChannelAccountFallbackWorkspace(
        { ...account, default_workspace_jid: 'web:selected' },
        {
          getGroup: () => ({
            ...baseGroup,
            folder: 'selected-folder',
            created_by: 'owner',
          }),
          getHome: () => ({ ...baseGroup, jid: 'web:owner-home' }),
        },
      ),
    ).toEqual({ jid: 'web:selected', folder: 'selected-folder' });
  });
});
