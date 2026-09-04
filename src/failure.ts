import type { FailureClass } from './types.js';

export type FailureMetrics = {
  httpAttempts?: number;
  responseBytes?: number;
};

export class RunnerFailure extends Error {
  readonly failureClass: FailureClass;
  readonly metrics: FailureMetrics;

  constructor(failureClass: FailureClass, metrics: FailureMetrics = {}) {
    super(`runner failure: ${failureClass}`);
    this.name = 'RunnerFailure';
    this.failureClass = failureClass;
    this.metrics = metrics;
  }
}

export function asRunnerFailure(error: unknown): RunnerFailure {
  return error instanceof RunnerFailure ? error : new RunnerFailure('unknown');
}
