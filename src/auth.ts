import { readFileSync } from "node:fs";
import path from "node:path";
import type { CodexHome } from "./types";
import { fileExists } from "./util";

export type CodexAuthMaterial = {
  accessToken: string;
  accountId?: string;
  authMode?: string;
  sourceHome: string;
};

export function loadAuthFromHomes(homes: CodexHome[]): CodexAuthMaterial | null {
  for (const home of homes) {
    const auth = loadAuthFromHome(home.path);
    if (auth) return auth;
  }
  return null;
}

function loadAuthFromHome(home: string): CodexAuthMaterial | null {
  const authPath = path.join(home, "auth.json");
  if (!fileExists(authPath)) return null;
  const raw = readFileSync(authPath, "utf8");
  const parsed = JSON.parse(raw);
  const tokens = parsed.tokens;
  const accessToken = tokens?.access_token;
  if (typeof accessToken !== "string" || !accessToken.trim()) return null;
  const accountId = firstString(tokens.account_id, tokens.id_token?.chatgpt_account_id);
  return {
    accessToken,
    accountId,
    authMode: typeof parsed.auth_mode === "string" ? parsed.auth_mode : undefined,
    sourceHome: home,
  };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}
