import fs from "node:fs";
import path from "node:path";
import { matchesConfiguredArtifact } from "./local-artifact.mjs";

/**
 * Platform-independent command use-cases.  The platform port owns commands,
 * hardware discovery and process control; this core owns ordering, artifact
 * identity and acceptance evidence.
 */
export function createChapekCommandCore({ root, platform, profilesPath = path.join(root, "config", "profiles.json"), modelsDir, runtimeDir }) {
  const profiles = () => JSON.parse(fs.readFileSync(profilesPath, "utf8"));
  const entry = (name) => {
    const config = profiles(); const id = name || config.default; const profile = config.profiles[id];
    if (!profile) throw new Error(`Unknown profile '${id}'.`);
    return { id, profile };
  };
  const local = (item) => {
    const directory = path.join(modelsDir, item.id); const manifestPath = path.join(directory, "manifest.json");
    if (!platform.fileExists(manifestPath)) return null;
    const manifest = JSON.parse(platform.readFile(manifestPath));
    if (!matchesConfiguredArtifact(item.profile, manifest, (file) => platform.fileExists(path.join(directory, file)))) return null;
    return { manifest, manifestPath, path: path.join(directory, manifest.files[0].path) };
  };
  const all = () => Object.entries(profiles().profiles).filter(([, profile]) => profile.supported).map(([id, profile]) => ({ id, profile }));
  const requireLocal = (item) => { const value = local(item); if (!value) throw new Error(`${item.id} has no current verified manifest; download it first.`); return value; };
  const download = async (item) => platform.download(item, path.join(modelsDir, item.id));
  const verify = async (item) => platform.verify(item, requireLocal(item));
  const calibrate = async (item, mode = "quick") => platform.calibrate(item, requireLocal(item), mode);
  const probe = async (item) => platform.probe(item, requireLocal(item));
  const readiness = async () => platform.generateReadiness({ root, modelsDir, runtimeDir });
  const evaluate = async (target, mode = "quick") => {
    const startup = target || entry();
    return platform.evaluate({
      target,
      startup,
      local: requireLocal(startup),
      mode,
    });
  };
  const coordinatorCapability = () => platform.coordinatorCapability();
  const trainCoordinator = async () => {
    const capability = coordinatorCapability();
    if (!capability.localTraining) return platform.reportCoordinatorFallback(capability);
    return platform.trainCoordinator({ root, modelsDir, runtimeDir });
  };
  const evaluateCoordinator = async () => {
    const capability = coordinatorCapability();
    if (!capability.localEvaluation) return platform.reportCoordinatorFallback(capability);
    return platform.evaluateCoordinator({ root, modelsDir, runtimeDir, startup: entry(), local: requireLocal(entry()) });
  };
  const awaitEvals = async () => {
    const reportPath = await platform.waitForRoutingEvaluation({ runtimeDir });
    const report = JSON.parse(platform.readFile(reportPath));
    if (!Array.isArray(report.rows) || !report.rows.length || !report.modelArtifacts) {
      throw new Error(`Routing evaluation report is incomplete: ${reportPath}`);
    }
    const measured = new Set(report.models || []);
    for (const item of all()) {
      if (measured.has(item.id) || !local(item)) continue;
      await verify(item); await calibrate(item, "full"); await probe(item); await evaluate(item, "full");
    }
    await readiness();
    await trainCoordinator();
    await evaluateCoordinator();
    await platform.smoke(entry(), requireLocal(entry()));
  };
  const init = async () => {
    await platform.setup();
    await platform.adapterConformance();
    for (const item of all()) await download(item);
    for (const item of all()) await verify(item);
    for (const item of all()) await calibrate(item, "full");
    for (const item of all()) await probe(item);
    await readiness();
    // The evaluated model set is platform data; the evaluation workflow and
    // admission evidence remain common. A coordinator is optional capability,
    // never a reason to bypass deterministic routing or evidence gates.
    await evaluate(null, "full");
    await readiness();
    await trainCoordinator();
    await evaluateCoordinator();
    await platform.smoke(entry());
  };
  return {
    async execute(command = "help", name, value) {
      const selected = () => entry(name);
      if (command === "help") return platform.help();
      if (command === "doctor") return platform.doctor({ modelsDir, runtimeDir });
      if (command === "profiles") return platform.showProfiles(profiles());
      if (command === "download") return download(selected());
      if (command === "download-all") { for (const item of all()) await download(item); return; }
      if (command === "verify") return verify(selected());
      if (command === "verify-all") { for (const item of all()) await verify(item); return; }
      if (command === "calibrate") return calibrate(selected(), value || "quick");
      if (command === "calibrate-all") { for (const item of all()) await calibrate(item, value || "full"); return; }
      if (command === "probe") return probe(selected());
      if (command === "readiness") return readiness();
      if (command === "evals") {
        const mode = ["quick", "full"].includes(name) && !value ? name : (value || "quick");
        const target = ["quick", "full"].includes(name) && !value ? null : selected();
        return evaluate(target, mode);
      }
      if (command === "train-coordinator") return trainCoordinator();
      if (command === "evaluate-coordinator") return evaluateCoordinator();
      if (command === "await-evals") return awaitEvals();
      if (command === "init") return init();
      // These remain platform operations until the Windows composition root is
      // migrated; they do not duplicate the shared evidence workflows above.
      if (command === "stop") return platform.stop();
      if (["start", "pi", "smoke"].includes(command)) { const item = selected(); return platform[command](item, requireLocal(item)); }
      throw new Error(platform.usage());
    },
    local,
  };
}
