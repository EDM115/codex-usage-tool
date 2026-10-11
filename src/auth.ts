import type { CodexHome } from "./types";

import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { AuthStorageError, decryptAgeScrypt, readForcedMacPreferences, readOsKeyring, resolveWindowsSystemConfigDir, type ManagedAuthPreferences } from "./auth-storage";

export type CodexAuthMaterial = {
  kind?: "chatgpt";
  accessToken: string;
  accountId?: string;
  authMode?: string;
  sourceHome: string;
  sourceHomes?: string[];
  refreshedAt?: string;
  credentialCandidates?: CodexAuthMaterial[];
};

export type CodexApiKeyMaterial = {
  kind: "api-key";
  apiKey: string;
  authMode?: string;
  sourceHome: string;
};
export type ResolvedCodexCredential = CodexAuthMaterial | CodexApiKeyMaterial;
export type AuthResolution = { credentials: ResolvedCodexCredential[]; diagnostics: string[] };
export type AuthResolutionOptions = {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  skipKeyring?: boolean;
  readKeyring?: (service: string, account: string) => Promise<string | null>;
  decryptSecrets?: (ciphertext: Buffer, passphrase: string) => Promise<Buffer>;
  systemConfigDir?: string;
  readManagedPreferences?: () => Promise<ManagedAuthPreferences>;
};
type StorageMode = "file" | "keyring" | "auto" | "ephemeral";
type AuthSettings = {
  cli_auth_credentials_store?: StorageMode;
  features?: { secret_auth_storage?: boolean };
  forced_login_method?: "api" | "chatgpt";
  allowed_login_methods?: Array<"api" | "chatgpt">;
  allowed_chatgpt_workspaces?: string[];
  forced_chatgpt_workspace_id?: string | string[];
  profile?: string;
  profiles?: Record<string, { features?: { secret_auth_storage?: boolean } }>;
};

/** Resolve each home independently without refreshing or writing credentials */
export async function resolveAuthFromHomes(homes: CodexHome[], options: AuthResolutionOptions = {}): Promise<AuthResolution> {
  const credentials: ResolvedCodexCredential[] = [];
  const diagnostics: string[] = [];
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const readKeyring = options.readKeyring ?? ((service, account) => readOsKeyring(service, account, platform));
  let admin: { defaults: AuthSettings; forced: AuthSettings; requirements: AuthSettings };
  try {
    const systemDir = options.systemConfigDir ?? (platform === "win32" ? await resolveWindowsSystemConfigDir() : "/etc/codex");
    const managed = options.readManagedPreferences ? await options.readManagedPreferences() : platform === "darwin" ? await readForcedMacPreferences() : {};
    admin = {
      defaults: parseSettings(readOptionalFile(join(systemDir, "config.toml"))),
      forced: mergeSettings(parseSettings(readOptionalFile(join(systemDir, "managed_config.toml"))), parseSettings(managed.configToml ?? null)),
      requirements: mergeSettings(parseSettings(readOptionalFile(join(systemDir, "requirements.toml")), true), parseSettings(managed.requirementsToml ?? null, true)),
    };
    // Cloud-delivered policy cannot be resolved without reproducing Codex's login/bootstrap flow
    if (Object.keys(admin.forced).length || Object.keys(admin.requirements).length) diagnostics.push("Local managed authentication settings applied, cloud-delivered requirements are not loaded by this tool");
  } catch {
    return { credentials, diagnostics: ["Unable to read managed authentication configuration, authentication lookup was skipped"] };
  }
  for (const home of homes) {
    try {
      const configured = mergeSettings(admin.defaults, readConfig(home.path), admin.forced);
      const profileFeatures = configured.profile ? configured.profiles?.[configured.profile]?.features : undefined;
      const config = mergeSettings(configured, { features: profileFeatures }, admin.requirements);
      if (config.features?.secret_auth_storage !== undefined && typeof config.features.secret_auth_storage !== "boolean") throw new Error("invalid selected auth storage feature");
      const mode = config.cli_auth_credentials_store ?? "file";
      if (!["file", "keyring", "auto", "ephemeral"].includes(mode)) throw new Error("unsupported credential storage mode");
      const envKey = firstString(env.CODEX_API_KEY)?.trim();
      // Codex's auth manager does not use OPENAI_API_KEY as a stored-login override
      if (envKey && loginAllowed(config, "api")) {
        credentials.push({ kind: "api-key", apiKey: envKey, authMode: "apikey", sourceHome: home.path });
        continue;
      }
      if (mode === "ephemeral") {
        diagnostics.push(`${home.path} : ephemeral authentication belongs to the running Codex process and cannot be read by this tool`);
        continue;
      }
      let serialized: string | null = null;
      if (mode === "keyring" || mode === "auto") {
        if (options.skipKeyring) {
          diagnostics.push(`${home.path} : keyring authentication lookup skipped`);
          // Skipping keyring must not select a potentially stale fallback file
          continue;
        }
        try {
          const encrypted = config.features?.secret_auth_storage ?? (platform === "win32");
          serialized = encrypted
            ? await readEncryptedAuth(home.path, readKeyring, options.decryptSecrets ?? decryptAgeScrypt)
            : await readKeyring("Codex Auth", `cli|${homeHash(home.path)}`);
          if (serialized !== null) parseAuthPayload(serialized);
        } catch (error) {
          const reason = error instanceof AuthStorageError ? error.message : "unable to read keyring authentication";
          diagnostics.push(`${home.path} : ${reason}${mode === "auto" ? ", falling back to auth.json" : ", file fallback is disabled"}`);
          serialized = null;
        }
        if (serialized === null && mode === "keyring") continue;
      }
      if (serialized === null) serialized = readOptionalFile(join(home.path, "auth.json"));
      if (serialized === null) continue;
      const credential = parseCredential(serialized, home.path);
      if (!credential) {
        diagnostics.push(`${home.path} : stored authentication has no supported ChatGPT or API-key credentials`);
      } else if (!loginAllowed(config, isChatGptAuth(credential) ? "chatgpt" : "api")) {
        diagnostics.push(`${home.path} : stored authentication does not match allowed login methods`);
      } else if (isChatGptAuth(credential) && !workspaceAllowed(config, credential.accountId)) {
        diagnostics.push(`${home.path} : stored authentication does not match allowed ChatGPT workspaces`);
      } else credentials.push(credential);
    } catch {
      // Exception messages can contain TOML lines, JSON snippets or subprocess output
      diagnostics.push(`${home.path} : unable to read authentication or credential storage configuration`);
    }
  }
  return { credentials, diagnostics };
}

export function isChatGptAuth(credential: ResolvedCodexCredential): credential is CodexAuthMaterial {
  return credential.kind !== "api-key";
}

export function deduplicateChatGptAccounts(credentials: ResolvedCodexCredential[]): Array<CodexAuthMaterial & { sourceHomes: string[] }> {
  const accounts = new Map<string, CodexAuthMaterial & { sourceHomes: string[] }>();
  for (const credential of credentials) {
    if (!isChatGptAuth(credential)) continue;
    const identity = credential.accountId ? `account:${credential.accountId}` : `token:${createHash("sha256").update(credential.accessToken).digest("hex")}`;
    const existing = accounts.get(identity);
    if (existing) {
      if (!existing.sourceHomes.includes(credential.sourceHome)) existing.sourceHomes.push(credential.sourceHome);
      if (!existing.credentialCandidates!.some((candidate) => candidate.accessToken === credential.accessToken)) existing.credentialCandidates!.push(credential);
    } else accounts.set(identity, { ...credential, sourceHomes: [credential.sourceHome], credentialCandidates: [credential] });
  }
  const now = Date.now();
  return [...accounts.values()].map((account) => {
    const candidates = account.credentialCandidates!.sort((left, right) => credentialFreshness(right, now) - credentialFreshness(left, now) || refreshTime(right) - refreshTime(left));
    return { ...candidates[0], sourceHomes: account.sourceHomes, credentialCandidates: candidates };
  });
}

function credentialFreshness(credential: CodexAuthMaterial, now: number): number {
  try {
    const claims = JSON.parse(Buffer.from(credential.accessToken.split(".")[1] ?? "", "base64url").toString("utf8"));
    if (typeof claims.exp === "number" && Number.isFinite(claims.exp)) return claims.exp * 1000 > now ? 2 : 0;
  } catch { /* Opaque tokens remain candidates, expiry is only a selection hint */ }
  return 1;
}

function refreshTime(credential: CodexAuthMaterial): number {
  const time = credential.refreshedAt ? Date.parse(credential.refreshedAt) : NaN;
  return Number.isFinite(time) ? time : 0;
}

function readConfig(home: string): AuthSettings {
  return parseSettings(readOptionalFile(join(home, "config.toml")));
}

function parseSettings(raw: string | null, requirements = false): AuthSettings {
  const config = raw === null ? {} : Bun.TOML.parse(raw) as Record<string, any>;
  if (requirements && config.features === undefined) config.features = config.feature_requirements;
  if (config.features?.secret_auth_storage !== undefined && typeof config.features.secret_auth_storage !== "boolean") throw new Error("invalid auth storage feature");
  if (config.forced_login_method !== undefined && !["api", "chatgpt"].includes(config.forced_login_method)) throw new Error("invalid forced login method");
  if (config.allowed_login_methods !== undefined && (!Array.isArray(config.allowed_login_methods) || config.allowed_login_methods.some((method: unknown) => method !== "api" && method !== "chatgpt"))) throw new Error("invalid allowed login methods");
  if (config.allowed_chatgpt_workspaces !== undefined && (!Array.isArray(config.allowed_chatgpt_workspaces) || config.allowed_chatgpt_workspaces.some((workspace: unknown) => typeof workspace !== "string"))) throw new Error("invalid allowed workspaces");
  if (config.forced_chatgpt_workspace_id !== undefined && typeof config.forced_chatgpt_workspace_id !== "string" && (!Array.isArray(config.forced_chatgpt_workspace_id) || config.forced_chatgpt_workspace_id.some((workspace: unknown) => typeof workspace !== "string"))) throw new Error("invalid forced workspaces");
  if (config.profile !== undefined && typeof config.profile !== "string") throw new Error("invalid profile selection");
  const fields = requirements
    ? ["cli_auth_credentials_store", "features", "allowed_login_methods", "allowed_chatgpt_workspaces"]
    : ["cli_auth_credentials_store", "features", "forced_login_method", "forced_chatgpt_workspace_id", "profile", "profiles"];
  return Object.fromEntries(fields.filter((field) => config[field] !== undefined).map((field) => [field, config[field]]));
}

function mergeSettings(...layers: AuthSettings[]): AuthSettings {
  const merged: AuthSettings = {};
  for (const layer of layers) {
    const features = { ...merged.features, ...layer.features };
    const profiles = { ...merged.profiles };
    for (const [name, profile] of Object.entries(layer.profiles ?? {})) profiles[name] = { ...profiles[name], ...profile, features: { ...profiles[name]?.features, ...profile.features } };
    Object.assign(merged, layer);
    if (Object.keys(features).length) merged.features = features;
    if (Object.keys(profiles).length) merged.profiles = profiles;
  }
  return merged;
}

function loginAllowed(config: AuthSettings, method: "api" | "chatgpt"): boolean {
  return (config.forced_login_method === undefined || config.forced_login_method === method) && (config.allowed_login_methods === undefined || config.allowed_login_methods.includes(method));
}

function workspaceAllowed(config: AuthSettings, accountId: string | undefined): boolean {
  const forced = typeof config.forced_chatgpt_workspace_id === "string" ? [config.forced_chatgpt_workspace_id] : config.forced_chatgpt_workspace_id;
  const selected = forced?.map((workspace) => workspace.trim()).filter(Boolean);
  return (!selected?.length || (accountId !== undefined && selected.includes(accountId))) && (config.allowed_chatgpt_workspaces === undefined || (accountId !== undefined && config.allowed_chatgpt_workspaces.includes(accountId)));
}

function readOptionalFile(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function homeHash(home: string): string {
  let canonical = home;
  try { canonical = realpathSync(home); } catch { /* Codex hashes the original path if canonicalization fails */ }
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

async function readEncryptedAuth(home: string, readKeyring: NonNullable<AuthResolutionOptions["readKeyring"]>, decrypt: NonNullable<AuthResolutionOptions["decryptSecrets"]>): Promise<string | null> {
  let ciphertext: Buffer;
  try { ciphertext = readFileSync(join(home, "secrets", "codex_auth.age")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new AuthStorageError("unable to read encrypted authentication file");
  }
  const passphrase = await readKeyring("codex", `secrets|${homeHash(home)}`);
  if (!passphrase) throw new AuthStorageError("encrypted authentication passphrase is missing from the OS keyring");
  const plaintext = await decrypt(ciphertext, passphrase);
  try {
    const parsed = JSON.parse(plaintext.toString("utf8"));
    if (!Number.isInteger(parsed.version) || parsed.version < 0 || parsed.version > 1) throw new AuthStorageError("unsupported encrypted authentication secrets version");
    if (!parsed.secrets || typeof parsed.secrets !== "object" || Array.isArray(parsed.secrets)) throw new AuthStorageError("invalid encrypted authentication secrets payload");
    const serialized = parsed.secrets["global/CODEX_AUTH"];
    if (serialized === undefined) return null;
    if (typeof serialized !== "string") throw new AuthStorageError("invalid encrypted authentication credential payload");
    return serialized;
  } finally { plaintext.fill(0); }
}

function parseCredential(serialized: string, sourceHome: string): ResolvedCodexCredential | null {
  const parsed = parseAuthPayload(serialized);
  const authMode = firstString(parsed.auth_mode);
  const resolvedMode = authMode ?? (parsed.personal_access_token ? "personal_access_token" : parsed.bedrock_api_key ? "bedrock_api_key" : parsed.bedrock_access_keys ? "bedrock_access_keys" : parsed.OPENAI_API_KEY !== undefined && parsed.OPENAI_API_KEY !== null ? "apikey" : "chatgpt");
  if (resolvedMode === "apikey") {
    const apiKey = firstString(parsed.OPENAI_API_KEY);
    return apiKey ? { kind: "api-key", apiKey, authMode: "apikey", sourceHome } : null;
  }
  if (resolvedMode !== "chatgpt" && resolvedMode !== "chatgptAuthTokens") return null;
  const accessToken = firstString(parsed.tokens?.access_token);
  if (!accessToken) return null;
  const accountId = firstString(parsed.tokens?.account_id, parsed.tokens?.id_token?.chatgpt_account_id, accountFromIdToken(parsed.tokens?.id_token));
  const refreshedAt = firstString(parsed.last_refresh);
  return { kind: "chatgpt", accessToken, ...(accountId ? { accountId } : {}), ...(authMode ? { authMode } : {}), ...(refreshedAt ? { refreshedAt } : {}), sourceHome };
}

function parseAuthPayload(serialized: string): Record<string, any> {
  const parsed = JSON.parse(serialized);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid auth payload");
  if (parsed.auth_mode != null && !["apikey", "chatgpt", "chatgptAuthTokens", "headers", "agentIdentity", "personalAccessToken", "bedrockApiKey", "bedrockAccessKeys"].includes(parsed.auth_mode)) throw new Error("invalid auth mode");
  if (parsed.OPENAI_API_KEY != null && typeof parsed.OPENAI_API_KEY !== "string") throw new Error("invalid API key material");
  if (parsed.tokens != null) {
    if (typeof parsed.tokens !== "object" || Array.isArray(parsed.tokens)) throw new Error("invalid token material");
    for (const field of ["access_token", "refresh_token", "account_id"]) {
      if (parsed.tokens[field] != null && typeof parsed.tokens[field] !== "string") throw new Error("invalid token field");
    }
  }
  return parsed;
}

function accountFromIdToken(token: unknown): string | undefined {
  if (typeof token !== "string") return undefined;
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return firstString(claims["https://api.openai.com/auth"]?.chatgpt_account_id);
  } catch { return undefined; }
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && Boolean(value.trim()));
}
