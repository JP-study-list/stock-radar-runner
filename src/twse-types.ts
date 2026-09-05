import type { CapabilityStatus, FailureClass, OverallStatus } from './types.js';

export const TWSE_REPORT_SCHEMA_VERSION = 'public-runner-twse-capability-v1' as const;
export const TWSE_REPORT_PREFIX = 'STOCK_RADAR_TWSE_CAPABILITY_REPORT=' as const;
export const TWSE_SYMBOLS = ['TW:2330', 'TW:0050'] as const;
export const COMPARISON_FIELDS = ['open', 'high', 'low', 'close', 'volume'] as const;

export type TwseSymbol = typeof TWSE_SYMBOLS[number];
export type ComparisonField = typeof COMPARISON_FIELDS[number];
export type ComparisonFailureClass = FailureClass | 'cross_source_mismatch';

export type NormalizedDailyValues = Record<ComparisonField, string>;

export type TwseCapabilityEvidence = {
  capability: 'official_1d_raw';
  symbol: TwseSymbol;
  status: CapabilityStatus;
  evidence: {
    session_date: string | null;
    schema_valid: boolean | null;
    timestamp_valid: boolean | null;
    freshness: 'fresh' | 'stale' | 'unknown' | null;
    source_volume_unit: 'share' | null;
    source_volume_multiplier: '1' | null;
    adjustment: 'raw' | null;
    target_present: boolean | null;
    record_count: number | null;
    response_bytes: number | null;
    http_attempts: number;
  };
  failure_class: FailureClass | null;
};

export type TwseComparisonEvidence = {
  capability: 'cross_source_1d_raw';
  symbol: TwseSymbol;
  status: CapabilityStatus;
  evidence: {
    session_date: string | null;
    matched_fields: ComparisonField[];
    mismatch_fields: ComparisonField[];
    mismatch_count: number | null;
    http_attempts: number;
  };
  failure_class: ComparisonFailureClass | null;
};

export type TwseCapabilityReport = {
  report_schema_version: typeof TWSE_REPORT_SCHEMA_VERSION;
  run_id: string;
  provider: 'twse';
  session_date: string;
  overall_status: OverallStatus;
  logical_operation_count: number;
  http_attempt_count: number;
  capabilities: TwseCapabilityEvidence[];
  comparisons: TwseComparisonEvidence[];
  observed_at: string;
  runner_bundle_version: string;
  source_commit_sha: string;
};

export function emptyTwseCapabilityEvidence(): TwseCapabilityEvidence['evidence'] {
  return {
    session_date: null,
    schema_valid: null,
    timestamp_valid: null,
    freshness: null,
    source_volume_unit: null,
    source_volume_multiplier: null,
    adjustment: null,
    target_present: null,
    record_count: null,
    response_bytes: null,
    http_attempts: 0
  };
}

export function pendingTwseCapabilities(): TwseCapabilityEvidence[] {
  return TWSE_SYMBOLS.map((symbol) => ({
    capability: 'official_1d_raw', symbol, status: 'pending',
    evidence: emptyTwseCapabilityEvidence(), failure_class: null
  }));
}

export function pendingTwseComparisons(): TwseComparisonEvidence[] {
  return TWSE_SYMBOLS.map((symbol) => ({
    capability: 'cross_source_1d_raw', symbol, status: 'pending',
    evidence: { session_date: null, matched_fields: [], mismatch_fields: [], mismatch_count: null, http_attempts: 0 },
    failure_class: null
  }));
}
