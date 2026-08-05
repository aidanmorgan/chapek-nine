const namePattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const repoPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const quantPattern = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}$/;

export function onboardProfile(config, { name, repo, quant }) {
  if (!namePattern.test(name || "")) throw new Error("Profile name must be lowercase letters, digits, and hyphens (1-64 characters).");
  if (!repoPattern.test(repo || "")) throw new Error("Repository must be an owner/repository Hugging Face identifier.");
  if (!quantPattern.test(quant || "")) throw new Error("Quantization contains unsupported characters.");
  const previous = config.profiles?.[name];
  const profile = {
    displayName: previous?.displayName || `Custom ${name}`,
    family: previous?.family || "custom",
    repo,
    quant,
    context: Number(previous?.context || 4096),
    cacheTypeK: previous?.cacheTypeK || "q8_0",
    cacheTypeV: previous?.cacheTypeV || "q8_0",
    hybridMoe: Boolean(previous?.hybridMoe),
    offloadMode: previous?.offloadMode || "auto",
    supported: true,
    notes: "Onboarded profile. It is not admitted until download, verification, calibration, probing, and routing evaluation complete.",
  };
  return { ...config, profiles: { ...config.profiles, [name]: profile } };
}
