function normalize(values, reverse = false) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return values.map(() => 0);
  const minimum = Math.min(...finite);
  const maximum = Math.max(...finite);
  if (maximum === minimum) return values.map((value) => (Number.isFinite(value) ? 1 : 0));
  return values.map((value) => {
    if (!Number.isFinite(value)) return 0;
    const scaled = (value - minimum) / (maximum - minimum);
    return reverse ? 1 - scaled : scaled;
  });
}

export function calibratedHeadroom(calibration) {
  if (!calibration?.benchmark) return 0.5;
  const ram = Math.max(0, Math.min(1, Number(calibration.benchmark.minFreeRamGiB || 0) / 2));
  const vram = Math.max(0, Math.min(1, Number(calibration.benchmark.minFreeVramMiB || 0) / 1024));
  return Math.sqrt(ram * vram);
}

export function assignUtilities(rows, objective) {
  const byTask = new Map();
  for (const row of rows) {
    const group = byTask.get(row.taskId) || [];
    group.push(row);
    byTask.set(row.taskId, group);
  }
  for (const taskRows of byTask.values()) {
    const weights = objective.tiers[taskRows[0].tier] || objective.tiers.moderate;
    const decode = normalize(taskRows.map((row) => Number(row.generationTps)));
    const latency = normalize(taskRows.map((row) => Number(row.latencyMs)), true);
    for (let index = 0; index < taskRows.length; index += 1) {
      const row = taskRows[index];
      const memoryHeadroom = Number(row.memoryHeadroom ?? 0.5);
      row.utilityComponents = {
        quality: row.score,
        decodeTps: decode[index],
        latency: latency[index],
        memoryHeadroom,
      };
      row.utility =
        weights.quality * row.utilityComponents.quality +
        weights.decodeTps * row.utilityComponents.decodeTps +
        weights.latency * row.utilityComponents.latency +
        weights.memoryHeadroom * row.utilityComponents.memoryHeadroom;
      if (memoryHeadroom < objective.minimumMemoryHeadroom) {
        row.utility = 0;
        row.memoryRejected = true;
      }
    }
  }
  return rows;
}
