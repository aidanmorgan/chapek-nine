import Ajv2020 from "ajv/dist/2020.js";

/**
 * Validates and resolves a learned routing proposal. Structural validity comes
 * from the public JSON Schema; model eligibility remains a domain invariant
 * derived from the current routing policy and admitted worker set.
 */
export function createCoordinatorDecisionPolicy({ schema, orchestration, coordinator }) {
  const validator = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

  function primaryCandidates(role) {
    return role === "general"
      ? [...orchestration.coordinator, ...orchestration.synthesizer]
      : orchestration.roles[role] || [];
  }

  function resolve(value, availability, fallback) {
    if (!validator(value)) return null;
    if (!availability.publicWorkers.has(value.primary.model)) return null;
    if (!primaryCandidates(value.primary.role).includes(value.primary.model)) return null;
    if (value.confidence < coordinator.minimumConfidence) return null;
    if (value.steps.length > orchestration.maxAssignments) return null;

    const assignments = [];
    for (const step of value.steps) {
      const allowedModels = orchestration.roles[step.role] || [];
      if (
        !availability.specialistWorkers.has(step.model) ||
        !allowedModels.includes(step.model) ||
        step.model === value.primary.model
      ) {
        return null;
      }
      assignments.push({
        role: step.role,
        model: step.model,
        instruction: step.instruction.slice(0, 1_000),
        access: step.access,
      });
    }

    return {
      model: value.primary.model,
      maxTokens: value.primary.maxTokens ?? fallback.maxTokens,
      assignments,
      classification: {
        ...fallback.classification,
        primaryRole: value.primary.role,
        tier: value.tier,
      },
      confidence: value.confidence,
      policy: "lora",
    };
  }

  return { resolve, validationErrors: () => validator.errors || [] };
}
