import type { CapabilityUsageEvent } from "./types";

import { dateKey } from "./util";

type PluginAttribution = {
  name: string;
  aliases: Set<string>;
};

export type CapabilityEvidenceTracker = {
  plugins: Map<string, PluginAttribution>;
};

export function createCapabilityEvidenceTracker(): CapabilityEvidenceTracker {
  return { plugins: new Map() };
}

export function extractCapabilityUsageEvents(args: {
  parsed: any;
  payload: any;
  lineIndex: number;
  rolloutPath: string;
  homePath: string;
  homeLabel: string;
  threadId: string;
  timezone: string;
  tracker: CapabilityEvidenceTracker;
}): CapabilityUsageEvent[] {
  if (args.parsed.type !== "response_item") {
    return [];
  }

  const timestamp = String(args.parsed.timestamp ?? new Date().toISOString());
  const date = dateKey(timestamp, args.timezone);
  const common = {
    homePath: args.homePath,
    homeLabel: args.homeLabel,
    rolloutPath: args.rolloutPath,
    threadId: args.threadId,
    timestamp,
    date,
  };
  const events: CapabilityUsageEvent[] = [];

  if (args.payload?.type === "message") {
    const text = messageText(args.payload);

    if (args.payload.role === "user" && text.trimStart().startsWith("<skill>")) {
      for (const match of text.matchAll(
        /<skill>\s*<name>([^<]+)<\/name>\s*<path>([^<]+)<\/path>[\s\S]*?<\/skill>/gi,
      )) {
        const name = match[1].trim();
        const path = match[2].trim();
        events.push({
          ...common,
          eventId: capabilityEventId(args, "skill", name, events.length),
          kind: "skill",
          name,
          evidenceType: "injection",
          confidence: "high",
          detail: `Injected skill instructions from ${path}`,
        });
      }
    }

    if (
      args.payload.role === "developer" &&
      text.trimStart().startsWith("Capabilities from the `")
    ) {
      const pluginMatch = text.match(/^Capabilities from the `([^`]+)` plugin:/m);

      if (pluginMatch) {
        const name = pluginMatch[1].trim();
        const attribution = registerPluginAttribution(args.tracker, name, text);
        events.push({
          ...common,
          eventId: capabilityEventId(args, "plugin", name, events.length),
          kind: "plugin",
          name,
          evidenceType: "injection",
          confidence: "high",
          detail: `Injected plugin capabilities (${[...attribution.aliases].join(", ")})`,
        });
      }
    }

    return events;
  }

  if (args.payload?.type !== "function_call" && args.payload?.type !== "custom_tool_call") {
    return events;
  }

  const callName = typeof args.payload.name === "string" ? args.payload.name : "";
  const plugin = pluginForToolCall(args.tracker, callName);

  if (plugin) {
    events.push({
      ...common,
      eventId: capabilityEventId(args, "plugin", plugin.name, events.length),
      kind: "plugin",
      name: plugin.name,
      evidenceType: "tool_call",
      confidence: "high",
      detail: `Called plugin tool ${callName}`,
    });
  }

  for (const body of callBodies(args.payload)) {
    if (!looksLikeFileRead(callName, body)) {
      continue;
    }

    for (const path of skillPaths(body)) {
      const name = skillNameFromPath(path);

      if (!name) {
        continue;
      }

      events.push({
        ...common,
        eventId: capabilityEventId(args, "skill", name, events.length),
        kind: "skill",
        name,
        evidenceType: "skill_file_read",
        confidence: "medium",
        detail: `Read skill instructions from ${path}`,
      });
    }
  }

  return events;
}

function messageText(payload: any): string {
  if (!Array.isArray(payload?.content)) {
    return "";
  }

  return payload.content
    .map((item: any) => (typeof item?.text === "string" ? item.text : ""))
    .filter(Boolean)
    .join("\n");
}

function registerPluginAttribution(
  tracker: CapabilityEvidenceTracker,
  name: string,
  text: string,
): PluginAttribution {
  const attribution = tracker.plugins.get(name) ?? { name, aliases: new Set<string>() };
  attribution.aliases.add(normalizeIdentifier(name));
  const serverLine = text.match(
    /MCP servers from this plugin available in this session:\s*([^\n]+)/i,
  );

  if (serverLine) {
    for (const match of serverLine[1].matchAll(/`([^`]+)`/g)) {
      attribution.aliases.add(normalizeIdentifier(match[1]));
    }
  }

  tracker.plugins.set(name, attribution);

  return attribution;
}

function pluginForToolCall(
  tracker: CapabilityEvidenceTracker,
  callName: string,
): PluginAttribution | undefined {
  const normalizedCall = normalizeIdentifier(callName);
  const matches = [...tracker.plugins.values()].filter((plugin) =>
    [...plugin.aliases].some((alias) => alias.length >= 4 && normalizedCall.includes(alias)),
  );

  return matches.length === 1 ? matches[0] : undefined;
}

function normalizeIdentifier(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function callBodies(payload: any): string[] {
  const bodies: string[] = [];

  if (typeof payload?.input === "string") {
    bodies.push(payload.input);
  }

  if (typeof payload?.arguments === "string") {
    try {
      collectStrings(JSON.parse(payload.arguments), bodies);
    } catch {
      bodies.push(payload.arguments);
    }
  } else {
    collectStrings(payload?.arguments, bodies);
  }

  return bodies;
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);

    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectStrings(item, out));

    return;
  }

  if (value && typeof value === "object") {
    Object.values(value).forEach((item) => collectStrings(item, out));
  }
}

function looksLikeFileRead(callName: string, body: string): boolean {
  const text = `${callName}\n${body}`;

  return /\b(?:get-content|read_file|read_text_file|readfile|cat|type|bat)\b|fs\.(?:readFile|readFileSync)\b|sed\s+-n\b/i.test(
    text,
  );
}

function skillPaths(body: string): string[] {
  const normalizedBody = body.replace(/\\\\/g, "\\");
  const matches = normalizedBody.match(
    /(?:[A-Za-z]:[\\/]|(?:~|\.\.?)[\\/])[^"'`<>\r\n]*?[\\/]SKILL\.md/gi,
  );

  return (matches ?? [])
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => {
      const normalized = path.toLowerCase();

      return (
        normalized.includes("/.agents/skills/") ||
        normalized.includes("/.codex/skills/") ||
        (normalized.includes("/plugins/cache/") && normalized.includes("/skills/"))
      );
    });
}

function skillNameFromPath(path: string): string | undefined {
  const parts = path.split("/").filter(Boolean);
  let skillFileIndex = -1;
  let skillsIndex = -1;

  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index].toLowerCase();

    if (skillFileIndex < 0 && part === "skill.md") {
      skillFileIndex = index;
    } else if (skillFileIndex >= 0 && part === "skills") {
      skillsIndex = index;

      break;
    }
  }

  const name = skillFileIndex > 0 ? parts[skillFileIndex - 1] : undefined;

  if (!name || skillsIndex < 0) {
    return undefined;
  }

  const cacheIndex = parts.findIndex(
    (part, index) =>
      part.toLowerCase() === "cache" && parts[index - 1]?.toLowerCase() === "plugins",
  );
  const plugin = cacheIndex >= 0 ? parts[cacheIndex + 2] : undefined;

  return plugin && plugin.toLowerCase() !== name.toLowerCase() ? `${plugin}:${name}` : name;
}

function capabilityEventId(
  args: { threadId: string; parsed: any; lineIndex: number },
  kind: CapabilityUsageEvent["kind"],
  name: string,
  occurrence: number,
): string {
  return `${args.threadId}|${String(args.parsed.timestamp ?? "")}|${args.lineIndex}|${kind}|${name}|${occurrence}`;
}
