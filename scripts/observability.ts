import { metrics, trace } from "@opentelemetry/api";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import fs from "node:fs";
import path from "node:path";

const localDir = path.resolve(process.env.CHAPEK_OTEL_DIR || ".otel");
fs.mkdirSync(localDir, { recursive: true });
class JsonlSpanExporter {
  export(spans, callback) {
    fs.appendFileSync(
      path.join(localDir, "traces.jsonl"),
      spans
        .map((span) =>
          JSON.stringify({
            at: new Date().toISOString(),
            name: span.name,
            attributes: span.attributes,
            status: span.status,
            durationNs: Number(span.duration[0]) * 1e9 + span.duration[1],
          }),
        )
        .join("\n") + "\n",
    );
    callback({ code: 0 });
  }
  shutdown() {
    return Promise.resolve();
  }
  forceFlush() {
    return Promise.resolve();
  }
}
class JsonlMetricExporter {
  export(data, callback) {
    fs.appendFileSync(
      path.join(localDir, "metrics.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), resource: data.resource?.attributes, scopeMetrics: data.scopeMetrics })}\n`,
    );
    callback({ code: 0 });
  }
  shutdown() {
    return Promise.resolve();
  }
  forceFlush() {
    return Promise.resolve();
  }
}

const prom = new PrometheusExporter({
  port: Number(process.env.CHAPEK_PROMETHEUS_PORT || 9464),
  endpoint: "/metrics",
});
const readers = [
  prom,
  new PeriodicExportingMetricReader({
    exporter: new JsonlMetricExporter(),
    exportIntervalMillis: 5000,
  }),
];
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT)
  readers.push(
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "")}/v1/metrics`,
      }),
    }),
  );
const provider = new MeterProvider({ readers });
metrics.setGlobalMeterProvider(provider);
const spanProcessors = [new BatchSpanProcessor(new JsonlSpanExporter())];
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT)
  spanProcessors.push(
    new BatchSpanProcessor(
      new OTLPTraceExporter({
        url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "")}/v1/traces`,
      }),
    ),
  );
const tracerProvider = new NodeTracerProvider({ spanProcessors });
tracerProvider.register();
const meter = metrics.getMeter("chapek-nine-proxy");
const tracer = trace.getTracer("chapek-nine-proxy");
const routes = meter.createCounter("chapek.routes", { description: "Model route selections" });
const duration = meter.createHistogram("chapek.request.duration", { unit: "ms" });
const lifecycle = meter.createHistogram("chapek.model.lifecycle.duration", { unit: "ms" });
const worker = meter.createHistogram("chapek.worker.duration", { unit: "ms" });
const queueWait = meter.createHistogram("chapek.queue.wait", { unit: "ms" });
const cache = meter.createCounter("chapek.cache.operations");
const errors = meter.createCounter("chapek.errors");
const coordinator = meter.createCounter("chapek.coordinator.decisions");
const outcomes = meter.createCounter("chapek.request.outcomes");
const tps = meter.createHistogram("chapek.tokens_per_second", { unit: "1/s" });
const recovery = meter.createCounter("chapek.recovery.operations", {
  description: "Model recovery controller actions",
});
const headroom = meter.createObservableGauge("chapek.calibration.vram_headroom", { unit: "By" });
let calibratedHeadroom = {};
headroom.addCallback((o) => {
  for (const [model, bytes] of Object.entries(calibratedHeadroom)) o.observe(bytes, { model });
});
const gauge = meter.createObservableGauge("chapek.runtime.resources", {
  description: "Runtime resource values",
});
let resource = {};
gauge.addCallback((o) => {
  for (const [k, v] of Object.entries(resource))
    if (Number.isFinite(v)) o.observe(v, { resource: k });
});
export {
  tracer,
  meter,
  routes,
  duration,
  lifecycle,
  worker,
  queueWait,
  cache,
  errors,
  coordinator,
  outcomes,
  tps,
  recovery,
};
export function setCalibrationHeadroom(entries) {
  calibratedHeadroom = entries;
}
export function setResourceGauges(sample, queueDepth) {
  resource = {
    ram_free_bytes: (sample.freeRamGiB || 0) * 2 ** 30,
    gpu_vram_free_bytes: (sample.gpu?.freeMiB || 0) * 1048576,
    gpu_temperature_celsius: sample.gpu?.temperatureC,
    gpu_power_watts: sample.gpu?.powerW,
    queue_depth: queueDepth,
  };
}
