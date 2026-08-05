// A single local GPU cannot safely decode several requests at once.  This
// scheduler serialises inference while still favouring interactive continuation
// turns and preventing background work from starvation through ageing.
export function createScheduler({
  maxDepth = 8,
  agingMs = 15_000,
  now = () => performance.now(),
} = {}) {
  const pending = [];
  let running = false;
  let sequence = 0;
  let completed = 0;

  const effectivePriority = (item, at) =>
    item.priority + Math.floor((at - item.queuedAt) / agingMs);
  const nextItem = () => {
    const at = now();
    return pending
      .map((item) => ({ item, effective: effectivePriority(item, at) }))
      .sort((a, b) => b.effective - a.effective || a.item.sequence - b.item.sequence)[0]?.item;
  };
  const pump = () => {
    if (running || !pending.length) return;
    running = true;
    const next = nextItem();
    pending.splice(pending.indexOf(next), 1);
    Promise.resolve()
      .then(next.work)
      .then(next.resolve, next.reject)
      .finally(() => {
        completed += 1;
        running = false;
        pump();
      });
  };

  return {
    submit(work, priority = 0) {
      if (pending.length >= maxDepth)
        return Promise.reject(new Error("scheduler capacity reached"));
      return new Promise((resolve, reject) => {
        pending.push({
          work,
          priority: Number(priority) || 0,
          queuedAt: now(),
          sequence: sequence++,
          resolve,
          reject,
        });
        pump();
      });
    },
    snapshot() {
      const at = now();
      return {
        maxDepth,
        pending: pending.length,
        running,
        completed,
        oldestWaitMs: pending.length
          ? Math.round(Math.max(...pending.map((item) => at - item.queuedAt)))
          : 0,
        priorities: Object.fromEntries(
          pending.reduce((counts, item) => {
            const key = String(item.priority);
            counts.set(key, (counts.get(key) || 0) + 1);
            return counts;
          }, new Map()),
        ),
      };
    },
  };
}
