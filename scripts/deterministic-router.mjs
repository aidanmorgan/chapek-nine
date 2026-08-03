function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" || part?.type === "input_text")
    .map((part) => part.text || "")
    .join("\n");
}

export function taskText(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => ["user", "assistant", "tool"].includes(message?.role))
    .map((message) => `${message.role}: ${textContent(message.content)}`)
    .join("\n")
    .slice(-20_000);
}

function matches(text, expressions) {
  return expressions.reduce(
    (score, expression) => score + (expression.test(text) ? 1 : 0),
    0,
  );
}

function firstAvailable(candidates, available) {
  return candidates.find((candidate) => available.has(candidate));
}

export function classifyRequest(body) {
  const text = taskText(body.messages);
  const latestRole = body.messages?.at(-1)?.role;
  const scores = {
    implementer: matches(text, [
      /\b(code|coding|implement|build|bug|debug|fix|refactor|compile)\b/i,
      /\b(repository|repo|codebase|function|class|api|script|powershell)\b/i,
      /\b(test|typescript|javascript|python|rust|c\+\+|sql|html|css)\b/i,
      /(?:^|[\s`])[\w./\\-]+\.(?:js|mjs|ts|tsx|py|rs|cpp|ps1|json|ya?ml)\b/im,
    ]),
    reviewer: matches(text, [
      /\b(review|audit|critique|inspect|validate|verify)\b/i,
      /\b(security|correctness|regression|risk|failure mode)\b/i,
      /\b(find (?:the )?(?:issues?|problems?|bugs?))\b/i,
    ]),
    analyst: matches(text, [
      /\b(research|investigate|analy[sz]e|compare|evaluate|explain)\b/i,
      /\b(architecture|design|trade-?offs?|evidence|recommend)\b/i,
      /\b(why|how does|root cause|strategy)\b/i,
    ]),
  };
  const ordered = ["implementer", "analyst", "reviewer"];
  const primaryRole = Object.values(scores).every((score) => score === 0)
    ? "general"
    : ordered.reduce((best, role) =>
        scores[role] > scores[best] ? role : best,
      );
  const signalCount = Object.values(scores).filter((score) => score > 0).length;
  const complexity =
    matches(text, [
      /\b(complex|deep|thorough|end[- ]to[- ]end|multi[- ]step)\b/i,
      /\b(architecture|migrate|integrate|production|performance)\b/i,
      /\b(and then|multiple|several|across|all files)\b/i,
      /```[\s\S]*```/,
    ]) +
    (text.length > 1_500 ? 1 : 0) +
    (text.length > 5_000 ? 1 : 0) +
    (signalCount > 1 ? 1 : 0);
  const exactOrTrivial =
    /\b(reply|respond|output|say) with exactly\b/i.test(text) ||
    /\b(hello|ping|health check)\b/i.test(text);
  const tier = exactOrTrivial
    ? "simple"
    : complexity >= 4
      ? "high"
      : complexity >= 2
        ? "moderate"
        : "simple";
  return {
    text,
    scores,
    primaryRole,
    tier,
    continuation: latestRole === "tool",
  };
}

export function chooseRoute(body, config, available) {
  const classification = classifyRequest(body);
  const roleCandidates =
    config.roles[classification.primaryRole] || config.coordinator;
  const fallbackCandidates = [
    ...roleCandidates,
    ...config.synthesizer,
    ...config.coordinator,
  ];
  const measuredPlan = config.budgetPlans?.[classification.primaryRole]?.[classification.tier];
  const model = measuredPlan && available.has(measuredPlan.model)
    ? measuredPlan.model
    : firstAvailable(fallbackCandidates, available);
  if (!model) throw new Error("No compatible downloaded model is available.");

  // Tool-result turns are latency-sensitive continuations of an existing agent
  // loop. Re-routing them through a new committee destroys context and adds no
  // useful classification information.
  if (
    classification.continuation ||
    classification.tier === "simple" ||
    available.size === 1
  ) {
    return {
      model,
      assignments: [],
      classification,
      maxTokens: measuredPlan?.maxTokens || config.tokens?.byTier?.[classification.tier] || config.tokens?.synthesizer || 800,
    };
  }

  const complementary =
    classification.primaryRole === "implementer"
      ? ["analyst", "reviewer"]
      : classification.primaryRole === "reviewer"
        ? ["analyst", "implementer"]
        : classification.primaryRole === "analyst"
          ? ["reviewer", "implementer"]
          : ["analyst", "reviewer"];
  const assignmentLimit =
    classification.tier === "high" ? config.maxAssignments : 1;
  const assignments = [];
  for (const role of complementary) {
    const worker = firstAvailable(config.roles[role] || [], available);
    if (worker && worker !== model && !assignments.some((item) => item.model === worker)) {
      assignments.push({
        role,
        model: worker,
        instruction:
          role === "reviewer"
            ? "Challenge the proposed direction, identify omissions and failure modes, and give precise corrections."
            : role === "implementer"
              ? "Develop a concrete implementation approach with validation steps."
              : "Decompose the problem, compare viable approaches, and identify the strongest evidence and trade-offs.",
      });
    }
    if (assignments.length >= assignmentLimit) break;
  }
  return {
    model,
    assignments,
    classification,
    maxTokens: measuredPlan?.maxTokens || config.tokens?.byTier?.[classification.tier] || config.tokens?.synthesizer || 800,
  };
}
