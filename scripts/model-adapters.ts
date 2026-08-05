import crypto from "node:crypto";

function merge(base, override) {
  const result = { ...base, ...override };
  for (const key of ["response", "requestFields"]) {
    result[key] = { ...(base[key] || {}), ...(override?.[key] || {}) };
  }
  return result;
}

export function resolveAdapter(registry, modelId) {
  const raw = registry.models?.[modelId] || {};
  const inherited = raw.extends ? registry.models?.[raw.extends] || {} : {};
  return merge(registry.default || {}, merge(inherited, raw));
}

function textPart(part) {
  if (typeof part === "string") return part;
  if (part?.type === "text" || part?.type === "input_text") {
    return String(part.text || "");
  }
  return "";
}

function normalizeContent(content, supportsImages) {
  if (typeof content === "string" || content == null) return content ?? "";
  if (!Array.isArray(content)) return String(content);
  if (supportsImages) return content;
  return content.map(textPart).filter(Boolean).join("\n");
}

function sanitizeSchema(value, stripped) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSchema(item, stripped));
  }
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (!stripped.has(key)) {
      output[key] = sanitizeSchema(item, stripped);
    }
  }
  return output;
}

function normalizeTool(tool, index, adapter) {
  const fn = tool?.function || tool;
  const name = String(fn?.name || `tool_${index}`)
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 64);
  return {
    type: "function",
    function: {
      name,
      description: String(fn?.description || "").slice(0, 4096),
      parameters: sanitizeSchema(
        fn?.parameters || { type: "object", properties: {} },
        new Set(adapter.stripSchemaKeywords || []),
      ),
    },
  };
}

function normalizeMessages(messages, adapter) {
  const system = [];
  const conversation = [];
  for (const raw of Array.isArray(messages) ? messages : []) {
    let role = raw?.role;
    if (role === "developer") role = adapter.developerRole || "system";
    const message = {
      ...raw,
      role,
      content: normalizeContent(raw?.content, adapter.supportsImages),
    };
    if (role === "system" && adapter.systemMode === "merge") {
      if (message.content) system.push(message.content);
      continue;
    }
    if (role === "tool") {
      message.content =
        typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    }
    conversation.push(message);
  }
  return system.length
    ? [{ role: "system", content: system.join("\n\n") }, ...conversation]
    : conversation;
}

function promptToolProtocol(tools) {
  const functions = tools.map((tool, index) => normalizeTool(tool, index, {}).function);
  return [
    "Tool calls are required when a tool can complete the user request.",
    "Do not describe, simulate, or execute a tool call in prose.",
    "Return exactly one call in this transport-neutral form and nothing else:",
    '<tool_call>{"name":"exact_tool_name","arguments":{}}</tool_call>',
    "The name must exactly match one of the available tools. Arguments must be a JSON object.",
    `Available tools: ${JSON.stringify(functions)}`,
  ].join("\n");
}

export function adaptRequest(body, modelId, adapter, contextWindow) {
  const adapted = { ...body, model: modelId };
  for (const field of adapter.stripRequestFields || []) delete adapted[field];
  Object.assign(adapted, structuredClone(adapter.requestFields || {}));
  adapted.messages = normalizeMessages(body.messages, adapter);
  const requested = Number(body.max_tokens ?? body.max_completion_tokens);
  delete adapted.max_completion_tokens;
  if (Number.isFinite(requested) && requested > 0) {
    adapted.max_tokens = Math.max(
      1,
      Math.min(Math.floor(requested), Math.max(1, contextWindow - 256)),
    );
  }
  if (adapter.cachePrompt) adapted.cache_prompt = true;
  if (Array.isArray(body.tools) && adapter.toolMode === "native") {
    adapted.tools = body.tools.map((tool, index) => normalizeTool(tool, index, adapter));
  } else if (Array.isArray(body.tools) && adapter.toolMode === "prompt") {
    delete adapted.tools;
    delete adapted.tool_choice;
    adapted.messages = [
      ...adapted.messages,
      { role: "system", content: promptToolProtocol(body.tools) },
    ];
  } else if (adapter.toolMode === "none") {
    delete adapted.tools;
    delete adapted.tool_choice;
  }
  return adapted;
}

function jsonContent(content) {
  if (typeof content !== "string") return content;
  const fenced = content.trim().match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  const candidate = (fenced ? fenced[1] : content).trim();
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return content;
  }
}

function promptToolCalls(content, allowedNames) {
  if (typeof content !== "string") return null;
  const calls = [];
  const add = (raw) => {
    try {
      const parsed = JSON.parse(raw);
      if (
        typeof parsed?.name !== "string" ||
        !parsed.name ||
        (allowedNames.size && !allowedNames.has(parsed.name))
      )
        return;
      const args = parsed.arguments && typeof parsed.arguments === "object" ? parsed.arguments : {};
      calls.push({
        id: `call_${crypto.randomBytes(8).toString("hex")}_${calls.length.toString(36)}`,
        type: "function",
        function: { name: parsed.name, arguments: JSON.stringify(args) },
      });
    } catch {}
  };
  const pattern = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  for (const match of content.matchAll(pattern)) add(match[1]);
  if (!calls.length && content.includes("<tool_call>")) {
    add(content.slice(content.lastIndexOf("<tool_call>") + "<tool_call>".length).trim());
  }
  if (!calls.length) add(content.trim());
  return calls.length ? calls : null;
}

function normalizeToolCalls(toolCalls, normalizeArguments) {
  if (!Array.isArray(toolCalls)) return toolCalls;
  return toolCalls.map((call, index) => {
    const fn = call.function || {};
    let args = fn.arguments;
    if (normalizeArguments && typeof args !== "string") {
      args = JSON.stringify(args ?? {});
    }
    return {
      ...call,
      id: call.id || `call_${crypto.randomBytes(8).toString("hex")}_${index.toString(36)}`,
      type: "function",
      function: {
        ...fn,
        name: String(fn.name || ""),
        arguments: args ?? "",
      },
    };
  });
}

export function adaptResponse(result, publicModel, adapter, request = {}) {
  const output = { ...result, model: publicModel };
  output.choices = (result.choices || []).map((choice) => {
    if (!choice.message) return choice;
    const content = request.response_format
      ? jsonContent(choice.message.content)
      : choice.message.content;
    const allowedNames = new Set(
      (Array.isArray(request.tools) ? request.tools : []).map(
        (tool, index) => normalizeTool(tool, index, adapter).function.name,
      ),
    );
    const emulated = adapter.toolMode === "prompt" ? promptToolCalls(content, allowedNames) : null;
    return {
      ...choice,
      message: {
        ...choice.message,
        content,
        tool_calls: normalizeToolCalls(
          choice.message.tool_calls || emulated,
          adapter.response?.normalizeToolArguments,
        ),
      },
    };
  });
  return output;
}

export function adaptStreamEvent(event, publicModel, adapter) {
  const output = { ...event, model: publicModel };
  output.choices = (event.choices || []).map((choice) => {
    if (!choice.delta?.tool_calls) return choice;
    return {
      ...choice,
      delta: {
        ...choice.delta,
        tool_calls: normalizeToolCalls(
          choice.delta.tool_calls,
          adapter.response?.normalizeToolArguments,
        ),
      },
    };
  });
  return output;
}
