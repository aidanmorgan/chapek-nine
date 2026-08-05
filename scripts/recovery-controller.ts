// Classifies local inference failures before a response is committed. Only
// failures that are safe to retry receive one recovery attempt.
export function classifyFailure(error) {
  const message = String(error?.message || error || "");
  if (error?.name === "AbortError" || /aborted|cancelled/i.test(message))
    return { kind: "cancelled", retry: false };
  if (/out of memory|cuda.*memory|cuda.*alloc|oom|insufficient.*vram/i.test(message))
    return { kind: "oom", retry: true };
  if (/temperature|thermal|throttl/i.test(message)) return { kind: "thermal", retry: false };
  if (/timed out|timeout|ETIMEDOUT/i.test(message)) return { kind: "timeout", retry: true };
  if (/\b(?:502|503|504)\b|fetch failed|ECONNRESET|ECONNREFUSED/i.test(message))
    return { kind: "upstream", retry: true };
  return { kind: "other", retry: false };
}

export async function withRecovery(work, recover, onEvent) {
  try {
    return await work(0);
  } catch (error) {
    const failure = classifyFailure(error);
    onEvent?.({ phase: "detected", ...failure, error: String(error.message || error) });
    if (!failure.retry) throw error;
    await recover(failure, error);
    onEvent?.({ phase: "retry", ...failure });
    try {
      const value = await work(1);
      onEvent?.({ phase: "recovered", ...failure });
      return value;
    } catch (retryError) {
      onEvent?.({
        phase: "exhausted",
        ...classifyFailure(retryError),
        error: String(retryError.message || retryError),
      });
      throw retryError;
    }
  }
}
