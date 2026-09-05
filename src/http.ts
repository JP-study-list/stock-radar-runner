import { RunnerFailure } from './failure.js';
import type { FailureClass } from './types.js';

export const HTTP_LIMITS = {
  logicalOperations: 7,
  totalAttempts: 14,
  attemptsPerOperation: 2,
  responseBytes: 512 * 1024,
  records: 100,
  requestTimeoutMs: 15_000,
  jobTimeoutMs: 180_000,
  pages: 1
} as const;

export type HttpLimits = {
  logicalOperations: number;
  totalAttempts: number;
  attemptsPerOperation: number;
  responseBytes: number;
  records: number;
  requestTimeoutMs: number;
  jobTimeoutMs: number;
  pages: number;
};

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class RequestBudget {
  logicalOperationCount = 0;
  httpAttemptCount = 0;

  constructor(private readonly limits: Pick<HttpLimits, 'logicalOperations' | 'totalAttempts'> = HTTP_LIMITS) {}

  beginOperation(): void {
    if (this.logicalOperationCount >= this.limits.logicalOperations) throw new RunnerFailure('unknown');
    this.logicalOperationCount += 1;
  }

  beginAttempt(): void {
    if (this.httpAttemptCount >= this.limits.totalAttempts) throw new RunnerFailure('unknown');
    this.httpAttemptCount += 1;
  }
}

export type BoundedJsonResult = {
  body: unknown;
  responseBytes: number;
  attempts: number;
  rateLimitHeaderObserved: boolean;
};

type BoundedFetchOptions = {
  fetchImpl: FetchLike;
  budget: RequestBudget;
  wait?: (milliseconds: number) => Promise<void>;
  classifyForbidden?: (response: Response) => 'permission_error' | 'entitlement_error' | 'unknown';
  deadlineAt?: number;
  clock?: () => number;
  limits?: HttpLimits;
};

function classifyStatus(response: Response, classifyForbidden?: BoundedFetchOptions['classifyForbidden']): FailureClass {
  if (response.status === 401) return 'auth_error';
  if (response.status === 403) return classifyForbidden?.(response) ?? 'unknown';
  if (response.status === 404) return 'not_found';
  if (response.status === 405 || response.status === 501) return 'unsupported';
  if (response.status === 429) return 'rate_limited';
  if (response.status >= 500) return 'server_error';
  return 'invalid_response';
}

function retryable(failureClass: FailureClass): boolean {
  return failureClass === 'rate_limited' || failureClass === 'network_error' || failureClass === 'server_error';
}

function retryDelay(response: Response | null, attempt: number, requestTimeoutMs: number): number {
  const raw = response?.headers.get('retry-after');
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, requestTimeoutMs);
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), requestTimeoutMs));
  }
  return attempt * 250;
}

function hasRateLimitHeader(headers: Headers): boolean {
  return ['ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after']
    .some((name) => headers.has(name));
}

async function readBoundedBody(response: Response, responseBytes: number): Promise<{ text: string; bytes: number }> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > responseBytes) {
    await response.body?.cancel();
    throw new RunnerFailure('response_too_large', { responseBytes: declared });
  }
  if (!response.body) throw new RunnerFailure('invalid_response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > responseBytes) {
        await reader.cancel();
        throw new RunnerFailure('response_too_large', { responseBytes: bytes });
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return { text, bytes };
  } catch (error) {
    if (error instanceof RunnerFailure) throw error;
    if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw new RunnerFailure('timeout', { responseBytes: bytes });
    }
    throw new RunnerFailure('invalid_response', { responseBytes: bytes });
  }
}

function timeoutSignal(milliseconds: number): AbortSignal {
  return AbortSignal.timeout(milliseconds);
}

export async function fetchBoundedJson(url: URL, init: RequestInit, options: BoundedFetchOptions): Promise<BoundedJsonResult> {
  options.budget.beginOperation();
  const limits = options.limits ?? HTTP_LIMITS;
  const wait = options.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const clock = options.clock ?? Date.now;
  let observedRateLimit = false;
  for (let attempt = 1; attempt <= limits.attemptsPerOperation; attempt += 1) {
    const remaining = options.deadlineAt === undefined ? limits.requestTimeoutMs : options.deadlineAt - clock();
    if (remaining <= 0) throw new RunnerFailure('timeout', { httpAttempts: attempt - 1 });
    options.budget.beginAttempt();
    let response: Response;
    try {
      response = await options.fetchImpl(url, {
        ...init,
        redirect: 'manual',
        signal: timeoutSignal(Math.max(1, Math.min(limits.requestTimeoutMs, remaining)))
      });
    } catch (error) {
      const isTimeout = error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError');
      const failureClass: FailureClass = isTimeout ? 'timeout' : 'network_error';
      if (!retryable(failureClass) || attempt === limits.attemptsPerOperation) {
        throw new RunnerFailure(failureClass, { httpAttempts: attempt });
      }
      await wait(Math.min(retryDelay(null, attempt, limits.requestTimeoutMs), Math.max(0, (options.deadlineAt ?? Number.POSITIVE_INFINITY) - clock())));
      continue;
    }

    observedRateLimit ||= hasRateLimitHeader(response.headers);
    if (!response.ok) {
      await response.body?.cancel();
      const failureClass = classifyStatus(response, options.classifyForbidden);
      if (!retryable(failureClass) || attempt === limits.attemptsPerOperation) {
        throw new RunnerFailure(failureClass, { httpAttempts: attempt });
      }
      await wait(Math.min(retryDelay(response, attempt, limits.requestTimeoutMs), Math.max(0, (options.deadlineAt ?? Number.POSITIVE_INFINITY) - clock())));
      continue;
    }

    if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) {
      await response.body?.cancel();
      throw new RunnerFailure('invalid_response', { httpAttempts: attempt });
    }

    const { text, bytes } = await readBoundedBody(response, limits.responseBytes);
    try {
      return { body: JSON.parse(text) as unknown, responseBytes: bytes, attempts: attempt, rateLimitHeaderObserved: observedRateLimit };
    } catch {
      throw new RunnerFailure('invalid_response', { httpAttempts: attempt, responseBytes: bytes });
    }
  }
  throw new RunnerFailure('unknown');
}
