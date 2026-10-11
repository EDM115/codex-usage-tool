import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as auth from "../src/auth";
import type { CodexHome } from "../src/types";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function home(config = "", payload: unknown = { tokens: { access_token: "synthetic-chatgpt", account_id: "acct" } }) {
  const path = mkdtempSync(join(tmpdir(), "usage-auth-"));
  roots.push(path);
  writeFileSync(join(path, "config.toml"), config);
  writeFileSync(join(path, "auth.json"), JSON.stringify(payload));
  return { path, label: "test" };
}
const resolveAuth = (homes: CodexHome[], options: auth.AuthResolutionOptions = {}) => {
  const isolatedSystem = mkdtempSync(join(tmpdir(), "usage-auth-system-"));
  roots.push(isolatedSystem);
  return auth.resolveAuthFromHomes(homes, { env: {}, systemConfigDir: isolatedSystem, readManagedPreferences: async () => ({}), ...options });
};

test("resolves file credentials independently for all homes and distinguishes API-key sign-in", async () => {
  const chat = home();
  const api = home("", { OPENAI_API_KEY: "synthetic-api-key" });
  const result = await resolveAuth([chat, api]);
  expect(result.credentials).toEqual([
    { kind: "chatgpt", accessToken: "synthetic-chatgpt", accountId: "acct", sourceHome: chat.path },
    { kind: "api-key", apiKey: "synthetic-api-key", sourceHome: api.path, authMode: "apikey" },
  ]);
});

test("uses the exact canonical home keyring identity and never falls back in explicit keyring mode", async () => {
  const original = home('cli_auth_credentials_store = "keyring"');
  const alias = join(original.path, "alias");
  symlinkSync(original.path, alias);
  const calls: string[][] = [];
  const result = await resolveAuth([{ path: alias, label: "alias" }], { readKeyring: async (service: string, account: string) => { calls.push([service, account]); return null; } });
  expect(calls).toEqual([["Codex Auth", `cli|${createHash("sha256").update(realpathSync(alias)).digest("hex").slice(0, 16)}`]]);
  expect(result.credentials).toEqual([]);
});

test("auto prefers keyring and falls back after missing, invalid or unavailable keyring data", async () => {
  const target = home('cli_auth_credentials_store = "auto"');
  const secure = await resolveAuth([target], { readKeyring: async () => JSON.stringify({ OPENAI_API_KEY: "secure-synthetic" }) });
  expect(secure.credentials[0]).toMatchObject({ apiKey: "secure-synthetic" });
  for (const readKeyring of [async () => null, async () => "invalid-synthetic", async () => { throw new Error("secret-error-text"); }]) {
    const fallback = await resolveAuth([target], { readKeyring });
    expect(fallback.credentials[0]).toMatchObject({ accessToken: "synthetic-chatgpt" });
    expect(fallback.diagnostics.join(" ")).not.toContain("secret-error-text");
    expect(fallback.diagnostics.join(" ")).not.toContain("invalid-synthetic");
  }
});

test("ephemeral credentials are unavailable outside Codex and skipKeyring suppresses OS reads", async () => {
  const ephemeral = home('cli_auth_credentials_store = "ephemeral"');
  const secure = home('cli_auth_credentials_store = "keyring"');
  let calls = 0;
  const result = await resolveAuth([ephemeral, secure], { skipKeyring: true, readKeyring: async () => { calls++; return null; } });
  expect(result.credentials).toEqual([]);
  expect(calls).toBe(0);
  expect(result.diagnostics.join(" ")).toContain("ephemeral");
});

test("CODEX_API_KEY overrides stored credentials while OPENAI_API_KEY does not", async () => {
  const target = home();
  const result = await resolveAuth([target], { env: { CODEX_API_KEY: " env-synthetic ", OPENAI_API_KEY: "provider-synthetic" } });
  expect(result.credentials[0]).toMatchObject({ kind: "api-key", apiKey: "env-synthetic" });
  const provider = await resolveAuth([target], { env: { OPENAI_API_KEY: "provider-synthetic" } });
  expect(provider.credentials[0].kind).toBe("chatgpt");
});

test("unsupported storage and malformed config never expose secret text or use stale file credentials", async () => {
  const invalid = home('cli_auth_credentials_store = "bad-secret-mode"');
  const broken = home('secret = "unterminated-synthetic');
  const result = await resolveAuth([invalid, broken]);
  expect(result.credentials).toEqual([]);
  expect(result.diagnostics.length).toBe(2);
  expect(result.diagnostics.join(" ")).not.toContain("bad-secret-mode");
  expect(result.diagnostics.join(" ")).not.toContain("unterminated-synthetic");
});

test("auth mode selects API-key material even when stale ChatGPT tokens also exist", async () => {
  const result = await resolveAuth([home("", { auth_mode: "apikey", OPENAI_API_KEY: "selected-synthetic", tokens: { access_token: "stale-synthetic" } })]);
  expect(result.credentials[0].kind).toBe("api-key");
});

test("deduplicates ChatGPT accounts by account ID and uses token identity only when account ID is absent", () => {
  const deduplicate = (auth as any).deduplicateChatGptAccounts ?? (() => []);
  const result = deduplicate([
    { kind: "chatgpt", accessToken: "rotated-first", accountId: "acct", sourceHome: "/first" },
    { kind: "chatgpt", accessToken: "rotated-second", accountId: "acct", sourceHome: "/second" },
    { kind: "chatgpt", accessToken: "unattributed", sourceHome: "/third" },
    { kind: "chatgpt", accessToken: "unattributed", sourceHome: "/fourth" },
    { kind: "api-key", apiKey: "synthetic", sourceHome: "/fifth" },
  ]);
  expect(result).toHaveLength(2);
  expect(result[0].sourceHomes).toEqual(["/first", "/second"]);
  expect(result[1].sourceHomes).toEqual(["/third", "/fourth"]);
});

// C2SP CCTV's independently generated scrypt vector (public synthetic passphrase)
// https://github.com/C2SP/CCTV/blob/main/age/testdata/scrypt
const officialScrypt = Buffer.from("YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IHNjcnlwdCByRjAvTndibFVISFRwZ1FnUnBlNUNRIDEwCmdVakV5bUZLTVZYUUVLZE1NSEwyNG9ZZXhqRTNUSUMwTzB6R1NxSjJhVVkKLS0tIElPWGlRWVN0a29UMW12WlcydEZPcVpkaFJWdmo1OGVnQUJ4L3NXZlpRYmMKGzXG5ofdANo6w3msn3QsIf0YWhuePe1znRSsappQEk24Ztg=", "base64");

test("decrypts independently generated age scrypt ciphertext", async () => {
  const storage = await import("../src/auth-storage");
  const decrypt = (storage as any).decryptAgeScrypt ?? (() => Promise.resolve(Buffer.alloc(0)));
  const plaintext = await decrypt(officialScrypt, "password");
  expect(createHash("sha256").update(plaintext).digest("hex")).toBe("013f54400c82da08037759ada907a8b864e97de81c088a182062c4b5622fd2ab");
});

test("encrypted backend reads only codex_auth.age and the upstream secrets key identity", async () => {
  const target = home('cli_auth_credentials_store = "keyring"\n[features]\nsecret_auth_storage = true');
  mkdirSync(join(target.path, "secrets"));
  writeFileSync(join(target.path, "secrets", "codex_auth.age"), "synthetic-ciphertext");
  const calls: string[][] = [];
  const result = await resolveAuth([target], {
    readKeyring: async (service: string, account: string) => { calls.push([service, account]); return "synthetic-passphrase"; },
    decryptSecrets: async (ciphertext: Buffer, passphrase: string) => {
      expect(ciphertext.toString()).toBe("synthetic-ciphertext");
      expect(passphrase).toBe("synthetic-passphrase");
      return Buffer.from(JSON.stringify({ version: 1, secrets: { "global/CODEX_AUTH": JSON.stringify({ tokens: { access_token: "encrypted-synthetic", account_id: "secure-acct" } }) } }));
    },
  });
  expect(calls).toEqual([["codex", `secrets|${createHash("sha256").update(realpathSync(target.path)).digest("hex").slice(0, 16)}`]]);
  expect(result.credentials[0]).toMatchObject({ kind: "chatgpt", accountId: "secure-acct", accessToken: "encrypted-synthetic" });
});

test("age decrypt rejects wrong passphrases, tampered headers, truncated payloads and excessive scrypt costs", async () => {
  const storage = await import("../src/auth-storage");
  const decrypt = (storage as any).decryptAgeScrypt ?? (() => Promise.resolve(Buffer.alloc(0)));
  const tampered = Buffer.from(officialScrypt);
  tampered[tampered.indexOf("--- ") + 4] ^= 1;
  const excessive = Buffer.from(officialScrypt.toString("latin1").replace(" 10\n", " 31\n"), "latin1");
  await expect(decrypt(officialScrypt, "wrong-synthetic")).rejects.toThrow();
  await expect(decrypt(tampered, "password")).rejects.toThrow();
  await expect(decrypt(officialScrypt.subarray(0, -1), "password")).rejects.toThrow();
  await expect(decrypt(excessive, "password")).rejects.toThrow("work factor");
});

test("encrypted stores with missing passphrases or newer formats do not silently use auth.json", async () => {
  const target = home('cli_auth_credentials_store = "keyring"\n[features]\nsecret_auth_storage = true');
  mkdirSync(join(target.path, "secrets"));
  writeFileSync(join(target.path, "secrets", "codex_auth.age"), "synthetic-ciphertext");
  let decryptCalls = 0;
  const missing = await resolveAuth([target], { readKeyring: async () => null, decryptSecrets: async () => { decryptCalls++; return Buffer.alloc(0); } });
  expect(missing.credentials).toEqual([]);
  expect(decryptCalls).toBe(0);
  const newer = await resolveAuth([target], { readKeyring: async () => "synthetic-passphrase", decryptSecrets: async () => Buffer.from(JSON.stringify({ version: 99, secrets: { "global/CODEX_AUTH": "{}" } })) });
  expect(newer.credentials).toEqual([]);
});

test("native keyring adapters address upstream identities without enumerating stores", async () => {
  const { readOsKeyring } = await import("../src/auth-storage");
  const calls: Array<[string, string[]]> = [];
  const runner = async (command: string, args: string[]) => { calls.push([command, args]); return { stdout: "synthetic-stored-value\n" }; };
  expect(await readOsKeyring("Codex Auth", "cli|synthetic", "darwin", runner)).toBe("synthetic-stored-value");
  expect(calls[0]).toEqual(["/usr/bin/security", ["find-generic-password", "-s", "Codex Auth", "-a", "cli|synthetic", "-w"]]);
  expect(await readOsKeyring("codex", "secrets|synthetic", "linux", runner)).toBe("synthetic-stored-value");
  expect(calls[1]).toEqual(["secret-tool", ["lookup", "service", "codex", "username", "secrets|synthetic", "target", "default"]]);
  expect(await readOsKeyring("codex", "secrets|synthetic", "win32", runner)).toBe("synthetic-stored-value");
  expect(calls[2][0]).toBe("powershell.exe");
  expect(calls[2][1]).toContain("-EncodedCommand");
});

test("auto falls back when keyring JSON is syntactically valid but not a Codex auth payload", async () => {
  const target = home('cli_auth_credentials_store = "auto"');
  const result = await resolveAuth([target], { readKeyring: async () => JSON.stringify({ tokens: "malformed-synthetic" }) });
  expect(result.credentials[0]).toMatchObject({ kind: "chatgpt", accessToken: "synthetic-chatgpt" });
});

test("system requirements override user storage and restrict env API-key login", async () => {
  const target = home();
  const system = home();
  writeFileSync(join(system.path, "requirements.toml"), 'cli_auth_credentials_store = "keyring"\nallowed_login_methods = ["chatgpt"]');
  const result = await resolveAuth([target], { systemConfigDir: system.path, readManagedPreferences: async () => ({}), env: { CODEX_API_KEY: "blocked-synthetic" }, readKeyring: async () => JSON.stringify({ tokens: { access_token: "secure-synthetic", account_id: "secure-account" } }) });
  expect(result.credentials[0]).toMatchObject({ kind: "chatgpt", accessToken: "secure-synthetic" });
});

test("forced managed preferences override system requirements and user authentication configuration", async () => {
  const target = home();
  const system = home();
  writeFileSync(join(system.path, "requirements.toml"), 'cli_auth_credentials_store = "file"');
  const result = await resolveAuth([target], { systemConfigDir: system.path, readManagedPreferences: async () => ({ configToml: 'forced_login_method = "chatgpt"', requirementsToml: 'cli_auth_credentials_store = "ephemeral"' }), env: { CODEX_API_KEY: "blocked-synthetic" } });
  expect(result.credentials).toEqual([]);
  expect(result.diagnostics.join(" ")).toContain("ephemeral");
});

test("macOS preference reader ignores ordinary defaults and rechecks forced status after reading", async () => {
  const storage = await import("../src/auth-storage");
  const read = (storage as any).readForcedMacPreferences ?? (async () => ({}));
  const copied: string[] = [];
  const normal = await read({ isForced: () => false, copyValue: (key: string) => { copied.push(key); return "invalid-synthetic"; } });
  expect(copied).toEqual([]);
  expect(normal).toEqual({});
  const encoded = Buffer.from('cli_auth_credentials_store = "ephemeral"').toString("base64");
  const forced = await read({ isForced: () => true, copyValue: () => encoded });
  expect(forced.requirementsToml).toBe('cli_auth_credentials_store = "ephemeral"');
  let checks = 0;
  const raced = await read({ isForced: () => (++checks % 2) === 1, copyValue: () => encoded });
  expect(raced).toEqual({});
});

test("unreadable administrator configuration skips auth without printing configuration data", async () => {
  const target = home();
  const result = await resolveAuth([target], { readManagedPreferences: async () => { throw new Error("private-configuration-synthetic"); } });
  expect(result.credentials).toEqual([]);
  expect(result.diagnostics.join(" ")).toContain("managed authentication");
  expect(result.diagnostics.join(" ")).not.toContain("private-configuration-synthetic");
});

test("Windows selects encrypted storage by default and explicit feature false selects direct keyring", async () => {
  const encrypted = home('cli_auth_credentials_store = "keyring"');
  mkdirSync(join(encrypted.path, "secrets"));
  writeFileSync(join(encrypted.path, "secrets", "codex_auth.age"), "synthetic-ciphertext");
  const direct = home('cli_auth_credentials_store = "keyring"\n[features]\nsecret_auth_storage = false');
  const services: string[] = [];
  const result = await resolveAuth([encrypted, direct], {
    platform: "win32",
    readKeyring: async (service: string) => { services.push(service); return service === "codex" ? "synthetic-passphrase" : JSON.stringify({ OPENAI_API_KEY: "direct-synthetic" }); },
    decryptSecrets: async () => Buffer.from(JSON.stringify({ version: 1, secrets: { "global/CODEX_AUTH": JSON.stringify({ OPENAI_API_KEY: "encrypted-synthetic" }) } })),
  });
  expect(services).toEqual(["codex", "Codex Auth"]);
  expect(result.credentials.map((credential: any) => credential.apiKey)).toEqual(["encrypted-synthetic", "direct-synthetic"]);
});

test("managed allowed ChatGPT workspaces reject credentials for other accounts", async () => {
  const target = home();
  const result = await resolveAuth([target], { readManagedPreferences: async () => ({ requirementsToml: 'allowed_chatgpt_workspaces = ["other-workspace"]' }) });
  expect(result.credentials).toEqual([]);
  expect(result.diagnostics.join(" ")).toContain("allowed ChatGPT workspaces");
});

test("native keyring errors remain sanitized and missing entries are distinct from denied reads", async () => {
  const { readOsKeyring } = await import("../src/auth-storage");
  const missing = async () => { throw Object.assign(new Error("synthetic-secret"), { code: 44 }); };
  expect(await readOsKeyring("Codex Auth", "cli|synthetic", "darwin", missing)).toBe(null);
  expect(await readOsKeyring("Codex Auth", "cli|synthetic", "win32", missing)).toBe(null);
  const unavailable = async () => { throw Object.assign(new Error("synthetic-secret"), { code: 1, stderr: "synthetic-secret" }); };
  await expect(readOsKeyring("codex", "secrets|synthetic", "linux", unavailable)).rejects.toThrow("Secret Service");
});

test("deduplication prefers unexpired JWTs and preserves alternate tokens for authentication recovery", () => {
  const jwt = (exp: number) => `synthetic.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
  const expired = jwt(1);
  const fresh = jwt(9_999_999_999);
  const result = auth.deduplicateChatGptAccounts([
    { accessToken: expired, accountId: "acct", sourceHome: "/expired" },
    { accessToken: fresh, accountId: "acct", sourceHome: "/fresh" },
    { accessToken: fresh, accountId: "acct", sourceHome: "/duplicate" },
  ]);
  expect(result[0].accessToken).toBe(fresh);
  expect(result[0].sourceHome).toBe("/fresh");
  expect(result[0].sourceHomes).toEqual(["/expired", "/fresh", "/duplicate"]);
  expect((result[0] as any).credentialCandidates.map((candidate: any) => candidate.accessToken)).toEqual([fresh, expired]);
});

test("deduplication prefers recently refreshed credentials when token expiry is unavailable", async () => {
  const older = home("", { last_refresh: "2026-01-01T00:00:00Z", tokens: { access_token: "older-synthetic", account_id: "acct" } });
  const newer = home("", { last_refresh: "2026-10-01T00:00:00Z", tokens: { access_token: "newer-synthetic", account_id: "acct" } });
  const resolved = await resolveAuth([older, newer]);
  const [account] = auth.deduplicateChatGptAccounts(resolved.credentials);
  expect(account.accessToken).toBe("newer-synthetic");
  expect(account.sourceHome).toBe(newer.path);
});

test("selected profile feature toggles choose the encrypted keyring backend without overriding global storage mode", async () => {
  const target = home('cli_auth_credentials_store = "keyring"\nprofile = "secure"\n[features]\nsecret_auth_storage = false\n[profiles.secure]\ncli_auth_credentials_store = "ephemeral"\n[profiles.secure.features]\nsecret_auth_storage = true');
  mkdirSync(join(target.path, "secrets"));
  writeFileSync(join(target.path, "secrets", "codex_auth.age"), "synthetic-ciphertext");
  const result = await resolveAuth([target], {
    readKeyring: async (service) => service === "codex" ? "synthetic-passphrase" : null,
    decryptSecrets: async () => Buffer.from(JSON.stringify({ version: 1, secrets: { "global/CODEX_AUTH": JSON.stringify({ OPENAI_API_KEY: "profile-synthetic" }) } })),
  });
  expect(result.credentials[0]).toMatchObject({ kind: "api-key", apiKey: "profile-synthetic" });
});
