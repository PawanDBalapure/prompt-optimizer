import type { MetricsRegistry } from './metrics.js';

/**
 * Minimal OTLP-flavoured metric exporter for environments that already pipe
 * a sidecar (Vector / OpenTelemetry Collector / Fluent Bit) listening for
 * line-protocol JSON on stdout or HTTP.
 *
 * We deliberately avoid the `@opentelemetry/*` SDK to keep the engine
 * dependency-free; the wire format we emit is the same shape the
 * `OTLP/JSON over HTTP` collector ingests for Sum metrics.  An enterprise
 * deployment that wants full traces can either:
 *   1. point an OTel Collector at the JSON we produce, or
 *   2. reimplement this exporter against the SDK behind the same env flag.
 */

interface OtlpDataPoint {
  attributes: Array<{ key: string; value: { stringValue: string } }>;
  startTimeUnixNano: string;
  timeUnixNano: string;
  asInt: string;
}

interface OtlpMetric {
  name: string;
  description: string;
  unit: string;
  sum: {
    aggregationTemporality: 2; // CUMULATIVE
    isMonotonic: true;
    dataPoints: OtlpDataPoint[];
  };
}

export interface OtlpExportEnvelope {
  resourceMetrics: Array<{
    resource: { attributes: Array<{ key: string; value: { stringValue: string } }> };
    scopeMetrics: Array<{
      scope: { name: string; version: string };
      metrics: OtlpMetric[];
    }>;
  }>;
}

const SCOPE_NAME = 'prompt-optimizer';
const SCOPE_VERSION = '1';

export function snapshotAsOtlp(metrics: MetricsRegistry, scopeVersion = SCOPE_VERSION): OtlpExportEnvelope {
  const counters = metrics.snapshot();
  const startTimeUnixNano = '0';
  return {
    resourceMetrics: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: SCOPE_NAME } },
          { key: 'service.namespace', value: { stringValue: 'prompt-optimizer' } },
        ],
      },
      scopeMetrics: [{
        scope: { name: SCOPE_NAME, version: scopeVersion },
        metrics: counters.map<OtlpMetric>((c) => ({
          name: c.metric,
          description: '',
          unit: '1',
          sum: {
            aggregationTemporality: 2,
            isMonotonic: true,
            dataPoints: [{
              attributes: [],
              startTimeUnixNano,
              timeUnixNano: String(BigInt(c.last_at) * 1_000_000n),
              asInt: String(c.count),
            }],
          },
        })),
      }],
    }],
  };
}

/**
 * POST the snapshot to an OTLP/HTTP endpoint (`/v1/metrics`).  Uses Node's
 * native `fetch` (Node 18+).  Errors are returned, never thrown — the engine
 * must keep optimizing even if the collector is offline.
 */
export async function pushOtlp(
  endpoint: string,
  envelope: OtlpExportEnvelope,
  timeoutMs = 5000,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // eslint-disable-next-line no-undef
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
