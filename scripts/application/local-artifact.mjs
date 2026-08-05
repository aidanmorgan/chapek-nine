/** Shared admission boundary for a configured profile and downloaded manifest. */
export function matchesConfiguredArtifact(profile, manifest, filesExist) {
  return Boolean(
    profile && manifest &&
    manifest.repo === profile.repo &&
    manifest.quant === profile.quant &&
    Array.isArray(manifest.files) && manifest.files.length &&
    manifest.files.every((file) => typeof file.path === "string" && filesExist(file.path)),
  );
}
