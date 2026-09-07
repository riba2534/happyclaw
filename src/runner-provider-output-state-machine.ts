import { consumeProviderQuotaControlOutput } from './provider-quota-observation.js';
import { logger } from './logger.js';
import type { ContainerOutput } from './agent-runtime-contracts.js';

export interface RunnerProviderOutputState {
  healthyInputTurnCompleted: boolean | undefined;
  providerFailureReported: boolean;
  providerFailureMaintenance: boolean;
  providerFailureTerminal: boolean | undefined;
}

export function initialRunnerProviderOutputState(): RunnerProviderOutputState {
  return {
    healthyInputTurnCompleted: undefined,
    providerFailureReported: false,
    providerFailureMaintenance: false,
    providerFailureTerminal: undefined,
  };
}

export interface RunnerProviderOutputHandlerOptions {
  groupName: string;
  identifier: string; // containerName or processId
  mode: 'container' | 'host';
  selectedProfileId: string | null;
  providerQuotaEpoch?: number | null;
  modelSelectionPinned?: boolean;
  onOutput?: (output: ContainerOutput) => Promise<void> | void;
  resetTimeout: () => void;
  stopTarget: (reason: string) => void;
  onBeforeDispatch?: (output: ContainerOutput) => void;
  quarantineFromOutput: (profileId: string, output: ContainerOutput) => void;
  applyDisposition: (
    output: ContainerOutput,
    profileId: string | null,
    allowFailover: boolean,
  ) => boolean;
  dispositionLogMessage: (output: ContainerOutput, terminal: boolean) => string;
}

/**
 * Shared output state machine for both Host and Container execution modes.
 * Enforces provider quota controls, provider failure quarantines, maintenance
 * terminations, and terminal state transitions while allowing execution-specific
 * stopTarget adaptations.
 */
export function createRunnerProviderOutputHandler(
  state: RunnerProviderOutputState,
  options: RunnerProviderOutputHandlerOptions,
): (output: ContainerOutput) => Promise<void> {
  const {
    groupName,
    identifier,
    mode,
    selectedProfileId,
    providerQuotaEpoch,
    modelSelectionPinned = false,
    onOutput,
    resetTimeout,
    stopTarget,
    onBeforeDispatch,
    quarantineFromOutput,
    applyDisposition,
    dispositionLogMessage,
  } = options;

  return async (output: ContainerOutput): Promise<void> => {
    onBeforeDispatch?.(output);

    if (
      selectedProfileId &&
      consumeProviderQuotaControlOutput(
        selectedProfileId,
        output,
        providerQuotaEpoch ?? undefined,
      )
    ) {
      if (onOutput) await onOutput(output);
      resetTimeout();
      return;
    }

    if (!onOutput) return;

    if (!output.providerFailure && output.inputTurnCompleted !== undefined) {
      state.healthyInputTurnCompleted = output.inputTurnCompleted;
    }

    if (output.providerFailureRetrying) {
      if (output.providerFailure && selectedProfileId) {
        if (!state.providerFailureReported) {
          state.providerFailureReported = true;
          quarantineFromOutput(selectedProfileId, output);
          logger.warn(
            {
              group: groupName,
              [mode === 'container' ? 'containerName' : 'processId']:
                identifier,
              providerId: selectedProfileId,
            },
            'Provider failure detected; agent runner is retrying the failed turn with fallback model',
          );
        }
      }
      return;
    }

    if (output.providerFailure && selectedProfileId) {
      if (!state.providerFailureReported) {
        state.providerFailureReported = true;
        quarantineFromOutput(selectedProfileId, output);
        logger.warn(
          {
            group: groupName,
            [mode === 'container' ? 'containerName' : 'processId']: identifier,
            providerId: selectedProfileId,
            result: output.result,
          },
          mode === 'container'
            ? 'Provider failure detected from streamed output, stopping container'
            : 'Provider failure detected from streamed output, stopping host agent',
        );
      }
    }

    if (output.providerFailureMaintenance && state.healthyInputTurnCompleted) {
      state.providerFailureMaintenance = true;
      logger.warn(
        {
          group: groupName,
          [mode === 'container' ? 'containerName' : 'processId']: identifier,
          providerId: selectedProfileId,
        },
        'Provider failed during internal maintenance; quarantining without user projection or replay',
      );
      logger.warn(
        'Provider failed after scheduled input completed; suppressing replay',
      );
      stopTarget('maintenance_provider_failure');
      return;
    }

    if (output.providerFailureMaintenance) {
      logger.warn(
        {
          group: groupName,
          [mode === 'container' ? 'containerName' : 'processId']: identifier,
          providerId: selectedProfileId,
        },
        'Maintenance query failed before durable input completion; treating as replayable provider failure',
      );
    }

    if (output.providerFailure) {
      const terminal = applyDisposition(
        output,
        selectedProfileId,
        !modelSelectionPinned,
      );
      state.providerFailureTerminal = terminal;
      logger.warn(
        {
          group: groupName,
          [mode === 'container' ? 'containerName' : 'processId']: identifier,
          providerId: selectedProfileId,
          terminal,
        },
        dispositionLogMessage(output, terminal),
      );
    }

    await onOutput(output);
    resetTimeout();

    if (output.providerFailure) {
      stopTarget('provider_failure');
    }
  };
}
