export function createScheduler({ maxDepth = 8 } = {}) {
  const pending = []; let running = false; let sequence = 0;
  const pump = () => { if (running || !pending.length) return; running = true; const next = pending.sort((a,b) => b.priority - a.priority || a.sequence - b.sequence).shift(); next.work().then(next.resolve, next.reject).finally(() => { running = false; pump(); }); };
  return { submit(work, priority = 0) { if (pending.length >= maxDepth) return Promise.reject(new Error("scheduler capacity reached")); return new Promise((resolve, reject) => { pending.push({ work, priority, sequence: sequence++, resolve, reject }); pump(); }); }, snapshot() { return { pending: pending.length, running }; } };
}
