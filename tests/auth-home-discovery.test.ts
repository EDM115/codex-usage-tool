import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCodexHomes } from "../src/codex-homes";

test("a custom Codex root with keyring config is discovered without an auth file or sessions", () => {
  const home = mkdtempSync(join(tmpdir(), "usage-config-only-root-"));
  writeFileSync(join(home, "config.toml"), 'cli_auth_credentials_store = "keyring"\n');
  expect(resolveCodexHomes([], [home], false).map((source) => source.path)).toEqual([home]);
});
