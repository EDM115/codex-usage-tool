import { expect, test } from "bun:test";
import { createCapabilityEvidenceTracker, extractCapabilityUsageEvents } from "../src/capabilities";

function extractor() {
  const tracker = createCapabilityEvidenceTracker();
  let lineIndex = 0;
  return (payload: any) =>
    extractCapabilityUsageEvents({
      parsed: { type: "response_item", timestamp: "2026-10-04T12:00:00Z" },
      payload,
      lineIndex: lineIndex++,
      rolloutPath: "sample.jsonl",
      homePath: "/Users/example/.codex",
      homeLabel: "test",
      threadId: "thread",
      timezone: "UTC",
      tracker,
    });
}

test("macOS absolute skill reads work in shell calls and exec wrappers", () => {
  const extract = extractor();
  expect(
    extract({
      type: "function_call",
      name: "exec_command",
      arguments: JSON.stringify({
        cmd: "cat '/Users/example/.agents/skills/using-superpowers/SKILL.md'; sed -n '1,80p' '/Users/example/.codex/skills/.system/openai-docs/SKILL.md'",
      }),
    }).map((event) => event.name),
  ).toEqual(["using-superpowers", "openai-docs"]);
  expect(
    extract({
      type: "custom_tool_call",
      name: "exec",
      input:
        'text(await tools.exec_command({cmd:"cat /Users/example/.codex/plugins/cache/openai-curated-remote/codex-security/0.1.31/skills/security-scan/SKILL.md"}));',
    }).map((event) => [event.name, event.kind]),
  ).toEqual([["codex-security:security-scan", "skill"]]);
  expect(
    extract({
      type: "function_call",
      name: "exec_command",
      arguments: JSON.stringify({
        cmd: "cat '/Users/example/Skill Pack/.agents/skills/my-skill/SKILL.md'",
      }),
    }).map((event) => event.name),
  ).toEqual(["my-skill"]);
});

test("skill catalogs and path mentions do not count as reads", () => {
  const extract = extractor();
  expect(
    extract({
      type: "message",
      role: "developer",
      content: [
        {
          text: "### Available skills\n- using-superpowers (file: /Users/example/.agents/skills/using-superpowers/SKILL.md)",
        },
      ],
    }),
  ).toEqual([]);
  expect(
    extract({
      type: "custom_tool_call",
      name: "exec",
      input: 'text("/Users/example/.agents/skills/using-superpowers/SKILL.md");',
    }),
  ).toEqual([]);
  expect(
    extract({
      type: "function_call",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "cat /Users/example/project/SKILL.md" }),
    }),
  ).toEqual([]);
});

test("MCP namespaces without recorded plugin attribution remain unresolved", () => {
  const extract = extractor();
  const events = extract({
    type: "custom_tool_call",
    name: "functions.exec",
    input:
      "const results = await Promise.all([tools.mcp__codex_app__open_in_codex({}), tools.mcp__codex_apps__exa_web_search_exa({}), tools.mcp__blender__get_scene_info({}), tools.mcp__node_repl__js({}), tools.mcp__cua_repl__js({})]);",
  });
  expect(events).toEqual([]);
  expect(
    extract({
      type: "function_call",
      name: "mcp__codex_apps__unknown_shared_tool",
      arguments: "{}",
    }),
  ).toEqual([]);
  expect(
    extract({
      type: "function_call",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "echo mcp__blender__get_scene_info" }),
    }),
  ).toEqual([]);
});

test("arbitrary plugin names and shared connector namespaces use recorded metadata", () => {
  const extract = extractor();
  const tool = "mcp__codex_apps__unlisted_connector__custom_action";
  expect(
    extract({
      type: "custom_tool_call_output",
      output: [
        { name: tool, description: "This tool is part of plugin `A Plugin Never Seen Before`." },
      ],
    }),
  ).toEqual([]);
  expect(
    extract({ type: "custom_tool_call", name: "exec", input: `await tools.${tool}({});` }).map(
      (event) => [event.name, event.confidence],
    ),
  ).toEqual([["A Plugin Never Seen Before", "high"]]);
});

test("plugin metadata exposure seeds attribution without counting unused plugins", () => {
  const extract = extractor();
  const metadata = [
    {
      name: "mcp__codex_apps__exa_web_search_exa",
      description: "Search. This tool is part of plugin `Exa`.",
    },
    {
      name: "mcp__codex_apps__github_search",
      description: "Search. This tool is part of plugins `Codex Security`, `GitHub`.",
    },
  ];
  expect(
    extract({
      type: "custom_tool_call_output",
      output: [{ type: "text", text: JSON.stringify(metadata) }],
    }),
  ).toEqual([]);
  expect(
    extract({
      type: "custom_tool_call",
      name: "exec",
      input: "await tools.mcp__codex_apps__exa_web_search_exa({});",
    }).map((event) => [event.name, event.confidence]),
  ).toEqual([["Exa", "high"]]);
  expect(
    extract({ type: "function_call", name: "mcp__codex_apps__github_search", arguments: "{}" }).map(
      (event) => [event.name, event.confidence],
    ),
  ).toEqual([
    ["Codex Security", "high"],
    ["GitHub", "high"],
  ]);
});

test("nested plugin calls retain injected attribution and invocation counts", () => {
  const extract = extractor();
  expect(
    extract({
      type: "message",
      role: "developer",
      content: [
        {
          text: "Capabilities from the `Codex Security` plugin:\nMCP servers from this plugin available in this session: `codex-security`.",
        },
      ],
    }).map((event) => [event.name, event.evidenceType]),
  ).toEqual([["Codex Security", "injection"]]);
  expect(
    extract({
      type: "custom_tool_call",
      name: "exec",
      input:
        "await tools.mcp__codex_security__open_workspace({}); await tools.mcp__codex_security__open_workspace({});",
    }).map((event) => [event.name, event.confidence]),
  ).toEqual([
    ["Codex Security", "high"],
    ["Codex Security", "high"],
  ]);
});
