import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [repo, quant, outputDir] = process.argv.slice(2);
if (!repo || !quant || !outputDir) {
  console.error("Usage: node download-hf.mjs <owner/repo> <quant> <output-dir>");
  process.exit(2);
}

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
fs.mkdirSync(outputDir, { recursive: true });

// Only one process may mutate a profile's partial file. A second bootstrap
// waits for the active owner instead of opening the same byte ranges twice.
const lockPath = path.join(outputDir, ".download.lock");
let ownsLock = false;
function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
async function acquireLock() {
  let lastReport = 0;
  for (;;) {
    try {
      const descriptor = fs.openSync(lockPath, "wx");
      fs.writeFileSync(
        descriptor,
        `${JSON.stringify({ pid: process.pid, started: new Date().toISOString() })}\n`,
      );
      fs.closeSync(descriptor);
      ownsLock = true;
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner;
      try {
        owner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      } catch {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > 5 * 60 * 1000) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      }
      if (owner && !processIsAlive(Number(owner.pid))) {
        fs.rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() - lastReport > 30_000) {
        console.log(
          `Another download${owner?.pid ? ` (PID ${owner.pid})` : ""} owns ${outputDir}; waiting...`,
        );
        lastReport = Date.now();
      }
      await delay(5_000);
    }
  }
}
function releaseLock() {
  if (!ownsLock) return;
  try {
    const owner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (Number(owner.pid) === process.pid) fs.rmSync(lockPath, { force: true });
  } catch {
    // Never remove an unreadable lock that may have been replaced.
  }
  ownsLock = false;
}
process.on("exit", releaseLock);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));
await acquireLock();

const userAgent = "local-pi-hybrid-harness/1.0";
async function fetchWithRetry(url, options, label) {
  let consecutiveFailures = 0;
  for (;;) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(10 * 60 * 1000),
      });
      const retryable =
        [408, 425, 429].includes(response.status) || response.status >= 500;
      if (!retryable) return response;
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    } catch (error) {
      consecutiveFailures += 1;
      const waitMs = Math.min(30_000, 500 * 2 ** Math.min(6, consecutiveFailures));
      console.warn(
        `${label}: connection attempt ${consecutiveFailures} failed (${error.message}); ` +
          `retrying in ${(waitMs / 1000).toFixed(1)}s.`,
      );
      await delay(waitMs);
    }
  }
}

const apiUrl =
  `https://huggingface.co/api/models/${repo}/tree/main` +
  "?recursive=true&expand=false&limit=1000";
const treeResponse = await fetchWithRetry(apiUrl, {
  headers: { "User-Agent": userAgent },
}, `Listing ${repo}`);
if (!treeResponse.ok) {
  throw new Error(
    `Could not list ${repo}: HTTP ${treeResponse.status} ${treeResponse.statusText}`,
  );
}

const tree = await treeResponse.json();
const quantKey = quant.toLowerCase();
const candidates = tree.filter((entry) => {
  const name = path.basename(entry.path ?? "").toLowerCase();
  return (
    entry.type === "file" &&
    name.endsWith(".gguf") &&
    !name.startsWith("mmproj") &&
    name.includes(quantKey)
  );
});
if (candidates.length === 0) {
  throw new Error(`No GGUF matching quantization '${quant}' was found in ${repo}.`);
}

const shardPattern = /-\d{5}-of-\d{5}\.gguf$/i;
const shardCandidates = candidates.filter((entry) => shardPattern.test(entry.path));
const selected = shardCandidates.length > 0 ? shardCandidates : candidates;
selected.sort((a, b) => a.path.localeCompare(b.path));
if (shardCandidates.length === 0 && selected.length !== 1) {
  throw new Error(
    `Quantization '${quant}' matched ${selected.length} unrelated GGUF files in ${repo}. ` +
      "Use a more specific quantization selector.",
  );
}

const manifestPath = path.join(outputDir, "manifest.json");
let oldManifest = {};
try {
  oldManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch {
  // Missing or incomplete manifests simply cause a full validation.
}

async function sha256(file) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function validate(file, entry, mayTrustManifest) {
  if (!fs.existsSync(file)) return false;
  const expectedSize = Number(entry.lfs?.size ?? entry.size ?? 0);
  if (expectedSize && fs.statSync(file).size !== expectedSize) return false;
  const expectedHash = entry.lfs?.oid;
  if (!expectedHash) return true;
  if (
    mayTrustManifest &&
    oldManifest.repo === repo &&
    oldManifest.files?.some(
      (item) =>
        item.path === path.basename(file) &&
        item.size === expectedSize &&
        item.sha256 === expectedHash,
    )
  ) {
    return true;
  }
  console.log(`Validating SHA-256 for ${path.basename(file)}...`);
  return (await sha256(file)) === expectedHash;
}

async function downloadSegmented(url, partialPath, expectedSize, fileName) {
  const segmentCount = Math.min(8, Math.ceil(expectedSize / (256 * 1024 * 1024)));
  const segmentSize = Math.ceil(expectedSize / segmentCount);
  const statePath = `${partialPath}.state.json`;
  const backupStatePath = `${statePath}.bak`;
  let completed;
  const oldSize = fs.existsSync(partialPath) ? fs.statSync(partialPath).size : 0;

  for (const candidate of [statePath, backupStatePath]) {
    try {
      const state = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (
        state.expectedSize === expectedSize &&
        state.segmentCount === segmentCount &&
        oldSize === expectedSize
      ) {
        completed = state.completed;
        break;
      }
    } catch {
      // Try the last-known-good backup before migrating a serial partial.
    }
  }

  if (!Array.isArray(completed) || completed.length !== segmentCount) {
    const serialBytes = Math.min(oldSize, expectedSize);
    completed = Array.from({ length: segmentCount }, (_, index) => {
      const start = index * segmentSize;
      const end = Math.min(expectedSize, start + segmentSize);
      return Math.max(0, Math.min(end - start, serialBytes - start));
    });
    const fd = fs.openSync(partialPath, fs.existsSync(partialPath) ? "r+" : "w+");
    fs.ftruncateSync(fd, expectedSize);
    fs.closeSync(fd);
  }

  const segmentLength = (index) => {
    const start = index * segmentSize;
    return Math.min(expectedSize, start + segmentSize) - start;
  };
  for (let index = 0; index < segmentCount; index += 1) {
    completed[index] = Math.max(
      0,
      Math.min(Number(completed[index]) || 0, segmentLength(index)),
    );
  }

  const persistState = () => {
    const nextStatePath = `${statePath}.next`;
    fs.writeFileSync(
      nextStatePath,
      `${JSON.stringify({ expectedSize, segmentCount, completed })}\n`,
    );
    if (fs.existsSync(statePath)) {
      fs.copyFileSync(statePath, backupStatePath);
    }
    try {
      fs.renameSync(nextStatePath, statePath);
    } catch {
      fs.rmSync(statePath, { force: true });
      fs.renameSync(nextStatePath, statePath);
    }
  };
  persistState();

  const file = await fs.promises.open(partialPath, "r+");
  const report = () => {
    const received = completed.reduce((sum, value) => sum + value, 0);
    const pct = ((received / expectedSize) * 100).toFixed(1);
    console.log(`${fileName}: ${pct}% (${(received / 1e9).toFixed(2)} GB, ${segmentCount} streams)`);
    persistState();
  };
  const reporter = setInterval(report, 5000);

  try {
    await Promise.all(
      completed.map(async (alreadyComplete, index) => {
        const start = index * segmentSize;
        const length = segmentLength(index);
        const rangeEnd = start + length - 1;
        let consecutiveNoProgress = 0;
        while (completed[index] < length) {
          const rangeStart = start + completed[index];
          const progressBeforeAttempt = completed[index];
          try {
            const response = await fetch(url, {
              headers: {
                "User-Agent": userAgent,
                Range: `bytes=${rangeStart}-${rangeEnd}`,
              },
              redirect: "follow",
              signal: AbortSignal.timeout(10 * 60 * 1000),
            });
            if (response.status !== 206 || !response.body) {
              await response.body?.cancel();
              const error = new Error(
                `HTTP Range was not honored: ${response.status} ${response.statusText}`,
              );
              error.fatal =
                response.status >= 400 &&
                response.status < 500 &&
                ![408, 425, 429].includes(response.status);
              throw error;
            }
            const reader = response.body.getReader();
            let position = rangeStart;
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              let offset = 0;
              while (offset < value.byteLength) {
                const result = await file.write(
                  value,
                  offset,
                  value.byteLength - offset,
                  position,
                );
                offset += result.bytesWritten;
                position += result.bytesWritten;
                completed[index] += result.bytesWritten;
              }
            }
            if (completed[index] < length) {
              throw new Error("remote stream ended before the requested range completed");
            }
          } catch (error) {
            persistState();
            if (error.fatal) throw error;
            const madeProgress = completed[index] > progressBeforeAttempt;
            consecutiveNoProgress = madeProgress ? 0 : consecutiveNoProgress + 1;
            const waitMs = madeProgress
              ? 250
              : Math.min(30_000, 500 * 2 ** Math.min(6, consecutiveNoProgress));
            console.warn(
              `${fileName}: retrying segment ${index + 1}/${segmentCount} ` +
                `from byte ${start + completed[index]} in ${(waitMs / 1000).toFixed(1)}s ` +
                `(${error.message}).`,
            );
            await delay(waitMs);
          }
        }
        persistState();
      }),
    );
  } finally {
    clearInterval(reporter);
    persistState();
    await file.close();
  }

  report();
  if (completed.some((value, index) => value !== segmentLength(index))) {
    throw new Error(`Incomplete segmented download for ${fileName}.`);
  }
  fs.rmSync(statePath, { force: true });
  fs.rmSync(backupStatePath, { force: true });
  fs.rmSync(`${statePath}.next`, { force: true });
}

async function download(entry) {
  const fileName = path.basename(entry.path);
  const finalPath = path.join(outputDir, fileName);
  const partialPath = `${finalPath}.partial`;
  const expectedSize = Number(entry.lfs?.size ?? entry.size ?? 0);
  if (await validate(finalPath, entry, true)) {
    console.log(`Verified cached file ${fileName}.`);
    return finalPath;
  }
  if (fs.existsSync(finalPath)) {
    const invalidPath = `${finalPath}.invalid-${Date.now()}`;
    fs.renameSync(finalPath, invalidPath);
    console.warn(`Preserved invalid existing file as ${path.basename(invalidPath)}.`);
  }

  // Older harness versions used llama.cpp's Hugging Face cache. Adopt a
  // completed blob with an NTFS hard link, so upgrades never duplicate a
  // multi-gigabyte model on disk.
  const legacyRepoDir = path.join(
    path.dirname(outputDir),
    "cache",
    `models--${repo.replaceAll("/", "--")}`,
  );
  const legacyCandidates = [];
  if (entry.lfs?.oid) {
    legacyCandidates.push(path.join(legacyRepoDir, "blobs", entry.lfs.oid));
  }
  const snapshotsDir = path.join(legacyRepoDir, "snapshots");
  if (fs.existsSync(snapshotsDir)) {
    for (const revision of fs.readdirSync(snapshotsDir)) {
      legacyCandidates.push(path.join(snapshotsDir, revision, entry.path));
    }
  }
  const legacyBlob = legacyCandidates.find(
    (candidate) =>
      fs.existsSync(candidate) &&
      (!expectedSize || fs.statSync(candidate).size === expectedSize),
  );
  if (legacyBlob && (await validate(legacyBlob, entry, false))) {
    try {
      fs.linkSync(legacyBlob, finalPath);
      console.log(`Adopted verified llama.cpp cache blob for ${fileName} without copying.`);
      return finalPath;
    } catch (error) {
      console.warn(`Could not hard-link the legacy cache blob: ${error.message}`);
    }
  }

  if (fs.existsSync(partialPath) && expectedSize) {
    const partialSize = fs.statSync(partialPath).size;
    if (partialSize > expectedSize) fs.rmSync(partialPath);
    if (
      partialSize === expectedSize &&
      !fs.existsSync(`${partialPath}.state.json`) &&
      !fs.existsSync(`${partialPath}.state.json.bak`)
    ) {
      if (!(await validate(partialPath, entry, false))) {
        fs.rmSync(partialPath);
        throw new Error(`SHA-256 mismatch for completed partial file ${fileName}.`);
      }
      fs.renameSync(partialPath, finalPath);
      return finalPath;
    }
  }

  const existing = fs.existsSync(partialPath) ? fs.statSync(partialPath).size : 0;
  const url =
    `https://huggingface.co/${repo}/resolve/main/` +
    entry.path.split("/").map(encodeURIComponent).join("/");
  if (expectedSize >= 1024 * 1024 * 1024) {
    await downloadSegmented(url, partialPath, expectedSize, fileName);
    if (!(await validate(partialPath, entry, false))) {
      throw new Error(`SHA-256 mismatch for ${fileName}.`);
    }
    fs.renameSync(partialPath, finalPath);
    return finalPath;
  }
  let received = existing;
  let lastReport = 0;
  do {
    const attemptHeaders = { "User-Agent": userAgent };
    if (received > 0) attemptHeaders.Range = `bytes=${received}-`;
    const response = await fetchWithRetry(
      url,
      { headers: attemptHeaders, redirect: "follow" },
      `Downloading ${fileName}`,
    );
    if (!response.ok || !response.body) {
      throw new Error(
        `Download failed for ${fileName}: HTTP ${response.status} ${response.statusText}`,
      );
    }

    const resuming = response.status === 206 && received > 0;
    if (!resuming) received = 0;
    const stream = fs.createWriteStream(partialPath, {
      flags: resuming ? "a" : "w",
    });
    const reader = response.body.getReader();
    let streamError;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!stream.write(value)) {
          await new Promise((resolve) => stream.once("drain", resolve));
        }
        received += value.byteLength;
        if (Date.now() - lastReport >= 5000) {
          const pct = expectedSize
            ? ((received / expectedSize) * 100).toFixed(1)
            : "?";
          console.log(`${fileName}: ${pct}% (${(received / 1e9).toFixed(2)} GB)`);
          lastReport = Date.now();
        }
      }
    } catch (error) {
      streamError = error;
    } finally {
      await new Promise((resolve, reject) => {
        stream.end(resolve);
        stream.on("error", reject);
      });
    }
    if (streamError || (expectedSize && received < expectedSize)) {
      console.warn(
        `${fileName}: stream ended at ${received}/${expectedSize || "unknown"} ` +
          `(${streamError?.message || "early EOF"}); reconnecting.`,
      );
      await delay(500);
    }
  } while (expectedSize && received < expectedSize);

  if (expectedSize && received !== expectedSize) {
    throw new Error(
      `Incomplete download for ${fileName}: received ${received}, expected ${expectedSize}. ` +
        "Run the command again to resume.",
    );
  }
  if (!(await validate(partialPath, entry, false))) {
    throw new Error(`SHA-256 mismatch for ${fileName}.`);
  }
  fs.renameSync(partialPath, finalPath);
  return finalPath;
}

const downloaded = [];
for (const entry of selected) downloaded.push(await download(entry));
const manifest = {
  version: 1,
  repo,
  quant,
  // llama.cpp names any model discovered in an immediate models-dir
  // subdirectory after that directory, for both single and sharded GGUFs.
  modelId: path.basename(path.resolve(outputDir)),
  files: selected.map((entry) => ({
    path: path.basename(entry.path),
    size: Number(entry.lfs?.size ?? entry.size ?? 0),
    sha256: entry.lfs?.oid ?? null,
  })),
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`MODEL_MANIFEST=${manifestPath}`);
