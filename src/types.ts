export const REPORT_SCHEMA_VERSION = 'public-runner-capability-v1' as const;
export const CALENDAR_SCHEMA_VERSION = 'tw-session-calendar-v1' as const;
export const REPORT_PREFIX = 'STOCK_RADAR_CAPABILITY_REPORT=' as const;
export const BUNDLE_VERSION = '0.1.0' as const;

export const SYMBOLS = ['TW:2330', 'TW:6488', 'TW:0050'] as const;
export type RunnerSymbol = typeof SYMBOLS[number];
export type Capability = 'historical_1d_raw' | 'historical_5m_raw' | 'historical_1d_adjusted' | 'rate_limit_headers';
export type CapabilityStatus = 'pass' | 'fail' | 'degraded' | 'unknown' | 'pending';
export type OverallStatus = Exclude<CapabilityStatus, 'pending'>;

export const FAILURE_CLASSES = [
  'auth_error', 'permission_error', 'entitlement_error', 'rate_limited', 'network_error',
  'server_error', 'timeout', 'not_found', 'unsupported', 'invalid_response', 'schema_error',
  'response_too_large', 'record_limit_exceeded', 'stale_data', 'data_gap',
  'missing_required_field', 'calendar_unknown', 'security_redaction_failure', 'unknown'
] as const;
export type FailureClass = typeof FAILURE_CLASSES[number];

export type Evidence = {
  session_date: string | null;
  schema_valid: boolean | null;
  timestamp_valid: boolean | null;
  freshness: 'fresh' | 'stale' | 'unknown' | null;
  continuity: 'continuous' | 'gap_suspected' | 'gap_confirmed' | 'no_trade' | 'not_applicable' | 'unknown' | null;
  source_volume_unit: 'share' | 'lot' | 'unknown' | null;
  source_volume_multiplier: '1' | '1000' | null;
  adjustment: 'raw' | 'adjusted' | 'unknown' | null;
  entitlement_observed: boolean | null;
  rate_limit_header_observed: boolean | null;
  record_count: number | null;
  response_bytes: number | null;
  http_attempts: number;
  first_timestamp: string | null;
  last_timestamp: string | null;
};

export type CapabilityEvidence = {
  capability: Capability;
  symbol: RunnerSymbol | null;
  status: CapabilityStatus;
  evidence: Evidence;
  failure_class: FailureClass | null;
};

export type CapabilityReport = {
  report_schema_version: typeof REPORT_SCHEMA_VERSION;
  run_id: string;
  provider: 'fugle';
  overall_status: OverallStatus;
  logical_operation_count: number;
  http_attempt_count: number;
  capabilities: CapabilityEvidence[];
  observed_at: string;
  runner_bundle_version: string;
  source_commit_sha: string;
};

export type ProbeDefinition = {
  capability: Exclude<Capability, 'rate_limit_headers'>;
  symbol: RunnerSymbol;
  providerSymbol: '2330' | '6488' | '0050';
  timeframe: 'D' | '5';
  adjustment: 'raw' | 'adjusted';
  exchange: 'TWSE' | 'TPEX';
  market: 'TSE' | 'OTC';
  instrumentTypes: readonly string[];
};

export const DATA_PROBES: readonly ProbeDefinition[] = [
  { capability: 'historical_1d_raw', symbol: 'TW:2330', providerSymbol: '2330', timeframe: 'D', adjustment: 'raw', exchange: 'TWSE', market: 'TSE', instrumentTypes: ['EQUITY'] },
  { capability: 'historical_1d_raw', symbol: 'TW:6488', providerSymbol: '6488', timeframe: 'D', adjustment: 'raw', exchange: 'TPEX', market: 'OTC', instrumentTypes: ['EQUITY'] },
  { capability: 'historical_1d_raw', symbol: 'TW:0050', providerSymbol: '0050', timeframe: 'D', adjustment: 'raw', exchange: 'TWSE', market: 'TSE', instrumentTypes: ['EQUITY'] },
  { capability: 'historical_5m_raw', symbol: 'TW:2330', providerSymbol: '2330', timeframe: '5', adjustment: 'raw', exchange: 'TWSE', market: 'TSE', instrumentTypes: ['EQUITY'] },
  { capability: 'historical_5m_raw', symbol: 'TW:6488', providerSymbol: '6488', timeframe: '5', adjustment: 'raw', exchange: 'TPEX', market: 'OTC', instrumentTypes: ['EQUITY'] },
  { capability: 'historical_5m_raw', symbol: 'TW:0050', providerSymbol: '0050', timeframe: '5', adjustment: 'raw', exchange: 'TWSE', market: 'TSE', instrumentTypes: ['EQUITY'] },
  { capability: 'historical_1d_adjusted', symbol: 'TW:2330', providerSymbol: '2330', timeframe: 'D', adjustment: 'adjusted', exchange: 'TWSE', market: 'TSE', instrumentTypes: ['EQUITY'] }
] as const;

export function emptyEvidence(): Evidence {
  return {
    session_date: null,
    schema_valid: null,
    timestamp_valid: null,
    freshness: null,
    continuity: null,
    source_volume_unit: null,
    source_volume_multiplier: null,
    adjustment: null,
    entitlement_observed: null,
    rate_limit_header_observed: null,
    record_count: null,
    response_bytes: null,
    http_attempts: 0,
    first_timestamp: null,
    last_timestamp: null
  };
}

export function pendingCapabilities(): CapabilityEvidence[] {
  return [
    ...DATA_PROBES.map((probe) => ({ capability: probe.capability, symbol: probe.symbol, status: 'pending' as const, evidence: emptyEvidence(), failure_class: null })),
    { capability: 'rate_limit_headers', symbol: null, status: 'pending', evidence: emptyEvidence(), failure_class: null }
  ];
}
