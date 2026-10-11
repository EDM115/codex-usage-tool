import { execFile } from "node:child_process";
import { createHmac, hkdfSync, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";

const run = promisify(execFile);
export type KeyringCommandRunner = (command: string, args: string[]) => Promise<{ stdout: string }>;
const runKeyringCommand: KeyringCommandRunner = (command, args) => run(command, args, { timeout: 15_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });

/** Query only the exact upstream keyring identity, never enumerate, refresh or write entries */
export async function readOsKeyring(service: string, account: string, platform: NodeJS.Platform, runner: KeyringCommandRunner = runKeyringCommand): Promise<string | null> {
  if (platform === "darwin") {
    try {
      const result = await runner("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-w"]);
      return result.stdout.replace(/\r?\n$/, "");
    } catch (error) {
      if ((error as { code?: unknown }).code === 44) return null;
      throw new AuthStorageError("macOS Keychain authentication read is unavailable or denied");
    }
  }
  if (platform === "linux" || platform === "freebsd" || platform === "openbsd") {
    // keyring-rs Secret Service entries use service, username and target attributes
    try {
      const result = await runner("secret-tool", ["lookup", "service", service, "username", account, "target", "default"]);
      return result.stdout.replace(/\r?\n$/, "") || null;
    } catch (error) {
      if ((error as { code?: unknown; stderr?: string }).code === 1 && !(error as { stderr?: string }).stderr?.trim()) return null;
      throw new AuthStorageError("Secret Service authentication read is unavailable, secret-tool and an unlocked Secret Service are required");
    }
  }
  if (platform === "win32") {
    try {
      const result = await runner("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windowsReadScript(`${account}.${service}`), "utf16le").toString("base64")]);
      return result.stdout.replace(/\r?\n$/, "");
    } catch (error) {
      if ((error as { code?: unknown }).code === 44) return null;
      throw new AuthStorageError("Windows Credential Manager authentication read is unavailable or denied");
    }
  }
  throw new AuthStorageError("OS keyring authentication is unsupported on this platform");
}

function windowsReadScript(target: string): string {
  // keyring-rs uses username.service and stores password strings as UTF-16LE blobs
  const encodedTarget = Buffer.from(target).toString("base64");
  return `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CodexCredentialReader {
  [StructLayout(LayoutKind.Sequential)] public struct FileTime { public uint Low; public uint High; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct Credential {
    public uint Flags; public uint Type; public IntPtr Target; public IntPtr Comment; public FileTime LastWritten;
    public uint BlobSize; public IntPtr Blob; public uint Persist; public uint AttributeCount; public IntPtr Attributes; public IntPtr Alias; public IntPtr Username;
  }
  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool Read(string target, uint type, uint flags, out IntPtr pointer);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr pointer);
}
'@
$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTarget}'))
$pointer = [IntPtr]::Zero
if (-not [CodexCredentialReader]::Read($target, 1, 0, [ref]$pointer)) {
  if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) { exit 44 }
  exit 1
}
try {
  $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer, [type][CodexCredentialReader+Credential])
  if (($credential.BlobSize % 2) -ne 0) { exit 1 }
  $bytes = New-Object byte[] $credential.BlobSize
  [Runtime.InteropServices.Marshal]::Copy($credential.Blob, $bytes, 0, $bytes.Length)
  [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
  [Console]::Write([Text.Encoding]::Unicode.GetString($bytes))
  [Array]::Clear($bytes, 0, $bytes.Length)
} finally { [CodexCredentialReader]::CredFree($pointer) }
`;
}

/** Errors from this module contain only fixed diagnostic text, never OS stderr or plaintext */
export class AuthStorageError extends Error {}

/** Read Codex's binary age v1 scrypt format, authenticated per https://c2sp.org/age */
export async function decryptAgeScrypt(ciphertext: Buffer, passphrase: string): Promise<Buffer> {
  if (ciphertext.length > 16 * 1024 * 1024) throw new AuthStorageError("encrypted authentication file exceeds the supported size");
  const headerEnd = ciphertext.indexOf("\n--- ");
  if (headerEnd < 0 || headerEnd > 4096) throw new AuthStorageError("unsupported encrypted authentication header");
  const macEnd = ciphertext.indexOf(10, headerEnd + 5);
  if (macEnd < 0) throw new AuthStorageError("invalid encrypted authentication header");
  const header = ciphertext.subarray(0, macEnd).toString("ascii");
  const match = /^age-encryption\.org\/v1\n-> scrypt ([A-Za-z0-9+/]+) ([1-9][0-9]*)\n([A-Za-z0-9+/]+)\n--- ([A-Za-z0-9+/]+)$/.exec(header);
  if (!match) throw new AuthStorageError("unsupported encrypted authentication recipient or format");
  const logN = Number(match[2]);
  // An explicit bound prevents an untrusted file requesting unlimited CPU or RAM
  if (!Number.isSafeInteger(logN) || logN > 20) throw new AuthStorageError("unsupported encrypted authentication scrypt work factor (maximum 20)");
  const salt = decodeBase64(match[1], 16);
  const wrappedKey = decodeBase64(match[3], 32);
  const mac = decodeBase64(match[4], 32);
  const wrapKey = await new Promise<Buffer>((resolve, reject) => {
    scrypt(passphrase, Buffer.concat([Buffer.from("age-encryption.org/v1/scrypt"), salt]), 32, { N: 2 ** logN, r: 8, p: 1, maxmem: 128 * 8 * 2 ** logN + 2 * 1024 * 1024 }, (error, key) => error ? reject(new AuthStorageError("encrypted authentication key derivation failed")) : resolve(key));
  });
  let fileKey: Buffer;
  try { fileKey = decryptChunk(wrappedKey, wrapKey, Buffer.alloc(12)); } finally { wrapKey.fill(0); }
  try {
    const headerKey = Buffer.from(hkdfSync("sha256", fileKey, Buffer.alloc(0), "header", 32));
    const expectedMac = createHmac("sha256", headerKey).update(ciphertext.subarray(0, headerEnd + 4)).digest();
    headerKey.fill(0);
    if (!timingSafeEqual(expectedMac, mac)) throw new AuthStorageError("encrypted authentication header authentication failed");
    const payload = ciphertext.subarray(macEnd + 1);
    if (payload.length < 32) throw new AuthStorageError("encrypted authentication payload is truncated");
    const payloadKey = Buffer.from(hkdfSync("sha256", fileKey, payload.subarray(0, 16), "payload", 32));
    const chunks: Buffer[] = [];
    try {
      let counter = 0n;
      for (let offset = 16; offset < payload.length; offset += 65_552) {
        const encryptedChunk = payload.subarray(offset, Math.min(offset + 65_552, payload.length));
        if (encryptedChunk.length < 16 || (counter > 0n && encryptedChunk.length === 16)) throw new AuthStorageError("encrypted authentication payload is truncated");
        const nonce = Buffer.alloc(12);
        nonce.writeBigUInt64BE(counter, 3);
        nonce[11] = offset + encryptedChunk.length === payload.length ? 1 : 0;
        chunks.push(decryptChunk(encryptedChunk, payloadKey, nonce));
        counter++;
      }
      return Buffer.concat(chunks);
    } finally {
      payloadKey.fill(0);
      for (const chunk of chunks) chunk.fill(0);
    }
  } finally { fileKey.fill(0); }
}

function decodeBase64(encoded: string, length: number): Buffer {
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length !== length || decoded.toString("base64").replace(/=+$/, "") !== encoded) throw new AuthStorageError("invalid encrypted authentication base64 encoding");
  return decoded;
}

function decryptChunk(ciphertext: Buffer, key: Buffer, nonce: Buffer): Buffer {
  try {
    return Buffer.from(chacha20poly1305(key, nonce).decrypt(ciphertext));
  } catch { throw new AuthStorageError("encrypted authentication decryption or integrity verification failed"); }
}

export type ManagedAuthPreferences = { configToml?: string; requirementsToml?: string };
export type ManagedPreferenceReader = { isForced: (key: string) => boolean; copyValue: (key: string) => unknown; close?: () => void };

/** Trust only forced CFPreferences, with the same before/after checks as Codex */
export async function readForcedMacPreferences(injected?: ManagedPreferenceReader): Promise<ManagedAuthPreferences> {
  const reader = injected ?? await nativeMacPreferenceReader();
  const result: ManagedAuthPreferences = {};
  try {
    for (const [key, field] of [["config_toml_base64", "configToml"], ["requirements_toml_base64", "requirementsToml"]] as const) {
      if (!reader.isForced(key)) continue;
      const encoded = reader.copyValue(key);
      if (!reader.isForced(key) || encoded == null) continue;
      if (typeof encoded !== "string") throw new AuthStorageError("forced macOS authentication preferences must be base64 TOML strings");
      const trimmed = encoded.trim();
      const decoded = Buffer.from(trimmed, "base64");
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(trimmed) || decoded.toString("base64") !== trimmed) throw new AuthStorageError("invalid forced macOS authentication preference encoding");
      result[field] = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
    }
    return result;
  } finally { if (!injected) reader.close?.(); }
}

async function nativeMacPreferenceReader(): Promise<ManagedPreferenceReader> {
  const { dlopen, ptr } = await import("bun:ffi");
  const library = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
    CFStringCreateWithCString: { args: ["ptr", "ptr", "u32"], returns: "ptr" },
    CFPreferencesAppValueIsForced: { args: ["ptr", "ptr"], returns: "u8" },
    CFPreferencesCopyAppValue: { args: ["ptr", "ptr"], returns: "ptr" },
    CFGetTypeID: { args: ["ptr"], returns: "u64" },
    CFStringGetTypeID: { args: [], returns: "u64" },
    CFStringGetLength: { args: ["ptr"], returns: "i64" },
    CFStringGetCString: { args: ["ptr", "ptr", "i64", "u32"], returns: "u8" },
    CFRelease: { args: ["ptr"], returns: "void" },
  });
  const cf = library.symbols;
  const strings = new Map<string, ReturnType<typeof cf.CFStringCreateWithCString>>();
  const string = (value: string) => {
    if (strings.has(value)) return strings.get(value)!;
    const bytes = Buffer.from(`${value}\0`);
    const native = cf.CFStringCreateWithCString(null, ptr(bytes), 0x08000100);
    if (!native) throw new AuthStorageError("unable to create macOS managed preference keys");
    strings.set(value, native);
    return native;
  };
  const app = string("com.openai.codex");
  return {
    isForced: (key) => Boolean(cf.CFPreferencesAppValueIsForced(string(key), app)),
    copyValue: (key) => {
      const value = cf.CFPreferencesCopyAppValue(string(key), app);
      if (!value) return undefined;
      try {
        if (cf.CFGetTypeID(value) !== cf.CFStringGetTypeID()) throw new AuthStorageError("forced macOS authentication preferences must be strings");
        const length = Number(cf.CFStringGetLength(value));
        if (length > 1024 * 1024 || length < 0) throw new AuthStorageError("forced macOS authentication preference exceeds supported size");
        const bytes = Buffer.alloc(length * 4 + 1);
        if (!cf.CFStringGetCString(value, ptr(bytes), bytes.length, 0x08000100)) throw new AuthStorageError("unable to decode forced macOS authentication preference");
        return bytes.subarray(0, bytes.indexOf(0)).toString("utf8");
      } finally { cf.CFRelease(value); }
    },
    close: () => { for (const native of strings.values()) if (native) cf.CFRelease(native); library.close(); },
  };
}

/** .NET's CommonApplicationData maps to the Windows ProgramData known folder */
export async function resolveWindowsSystemConfigDir(runner: KeyringCommandRunner = runKeyringCommand): Promise<string> {
  let programData = "C:\\ProgramData";
  try {
    const result = await runner("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Console]::Write([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData))"]);
    if (result.stdout.trim()) programData = result.stdout.trim();
  } catch { /* Codex uses the same default path when known-folder resolution fails */ }
  const { win32 } = await import("node:path");
  return win32.join(programData, "OpenAI", "Codex");
}
