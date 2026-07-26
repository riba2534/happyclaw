import { describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enabledProviders: [
    { id: 'provider-a', enabled: true, weight: 1 },
    { id: 'provider-b', enabled: true, weight: 1 },
  ],
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../src/runtime-config.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/runtime-config.js')
  >('../src/runtime-config.js');
  return {
    ...actual,
    getEnabledProviders: () => mocks.enabledProviders,
  };
});

const { runAgentWithModelFallback } =
  await import('../src/container-runner.js');
type AgentRunner = import('../src/container-runner.js').AgentRunner;
type ContainerOutput = import('../src/container-runner.js').ContainerOutput;

const group = {
  jid: 'web:scheduled-provider-fallback',
  name: 'scheduled-provider-fallback',
  folder: 'scheduled-provider-fallback',
} as never;

describe('scheduled provider fallback', () => {
  test('does not replay a scheduled prompt after its durable input completed', async () => {
    const projected: ContainerOutput[] = [];
    const runFn = vi.fn(
      async (
        _group: unknown,
        _input: unknown,
        _onProcess: unknown,
        onOutput?: (output: ContainerOutput) => Promise<void>,
      ): Promise<ContainerOutput> => {
        await onOutput?.({
          status: 'success',
          result: 'task completed',
          inputTurnCompleted: true,
        });
        await onOutput?.({
          status: 'success',
          result: null,
          providerFailure: true,
          providerFailureTerminal: true,
        });
        return {
          status: 'success',
          result: null,
          providerFailure: true,
          providerFailureTerminal: true,
        };
      },
    );

    const output = await runAgentWithModelFallback(
      runFn as unknown as AgentRunner,
      group,
      {
        prompt: 'perform one external side effect',
        groupFolder: group.folder,
        chatJid: group.jid,
        isMain: false,
        isHome: false,
        isAdminHome: false,
        isScheduledTask: true,
      },
      () => {},
      async (item) => {
        projected.push({ ...item });
      },
    );

    expect(runFn).toHaveBeenCalledTimes(1);
    expect(projected).toEqual([
      {
        status: 'success',
        result: 'task completed',
        inputTurnCompleted: true,
      },
    ]);
    expect(output).toMatchObject({
      status: 'success',
      result: null,
      providerFailure: false,
      inputTurnCompleted: true,
    });
  });

  test('still retries when the scheduled input failed before completion', async () => {
    const projected: ContainerOutput[] = [];
    const runFn = vi
      .fn()
      .mockImplementationOnce(
        async (
          _group: unknown,
          _input: unknown,
          _onProcess: unknown,
          onOutput?: (output: ContainerOutput) => Promise<void>,
        ) => {
          const failure: ContainerOutput = {
            status: 'success',
            result: null,
            providerFailure: true,
            providerFailureTerminal: false,
          };
          await onOutput?.(failure);
          return failure;
        },
      )
      .mockImplementationOnce(
        async (
          _group: unknown,
          _input: unknown,
          _onProcess: unknown,
          onOutput?: (output: ContainerOutput) => Promise<void>,
        ) => {
          const success: ContainerOutput = {
            status: 'success',
            result: 'completed on fallback',
            inputTurnCompleted: true,
          };
          await onOutput?.(success);
          return success;
        },
      );

    const output = await runAgentWithModelFallback(
      runFn as unknown as AgentRunner,
      group,
      {
        prompt: 'retryable scheduled prompt',
        groupFolder: group.folder,
        chatJid: group.jid,
        isMain: false,
        isHome: false,
        isAdminHome: false,
        isScheduledTask: true,
      },
      () => {},
      async (item) => {
        projected.push({ ...item });
      },
    );

    expect(runFn).toHaveBeenCalledTimes(2);
    expect(projected).toEqual([
      {
        status: 'success',
        result: 'completed on fallback',
        inputTurnCompleted: true,
      },
    ]);
    expect(output).toMatchObject({
      status: 'success',
      result: 'completed on fallback',
      inputTurnCompleted: true,
    });
  });

  test('does not mistake maintenance after an incomplete partial for success', async () => {
    const projected: ContainerOutput[] = [];
    const runFn = vi
      .fn()
      .mockImplementationOnce(
        async (
          _group: unknown,
          _input: unknown,
          _onProcess: unknown,
          onOutput?: (output: ContainerOutput) => Promise<void>,
        ) => {
          await onOutput?.({
            status: 'success',
            result: 'incomplete partial',
            inputTurnCompleted: false,
          });
          const failure: ContainerOutput = {
            status: 'success',
            result: null,
            providerFailure: true,
            providerFailureTerminal: false,
            providerFailureMaintenance: true,
          };
          await onOutput?.(failure);
          return failure;
        },
      )
      .mockImplementationOnce(
        async (
          _group: unknown,
          _input: unknown,
          _onProcess: unknown,
          onOutput?: (output: ContainerOutput) => Promise<void>,
        ) => {
          const success: ContainerOutput = {
            status: 'success',
            result: 'completed after replay',
            inputTurnCompleted: true,
          };
          await onOutput?.(success);
          return success;
        },
      );

    const output = await runAgentWithModelFallback(
      runFn as unknown as AgentRunner,
      group,
      {
        prompt: 'must finish before success',
        groupFolder: group.folder,
        chatJid: group.jid,
        isMain: false,
        isHome: false,
        isAdminHome: false,
        isScheduledTask: true,
      },
      () => {},
      async (item) => {
        projected.push({ ...item });
      },
    );

    expect(runFn).toHaveBeenCalledTimes(2);
    expect(projected).toEqual([
      {
        status: 'success',
        result: 'incomplete partial',
        inputTurnCompleted: false,
      },
      {
        status: 'success',
        result: 'completed after replay',
        inputTurnCompleted: true,
      },
    ]);
    expect(output).toMatchObject({
      status: 'success',
      result: 'completed after replay',
      inputTurnCompleted: true,
    });
  });
});
