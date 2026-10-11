import { createHash } from "node:crypto";
import type { CodexAuthMaterial } from "./auth";
import type { CliOptions, CodexHome, LocalThreadSummary, PaymentHistory, UsageDataset } from "./types";
import type { AccountApiProgress } from "./progress";
import { loadProfile, mergeProfileAccounts, profileSnapshot, type ProfileLoadResult } from "./profile-api";
import { loadPayments, mergePaymentHistories, paymentAccountScope } from "./payments";
import { loadWhamAnalytics, mergeWhamAccounts } from "./analytics-api";

type AccountCredential = CodexAuthMaterial & { sourceHomes: string[] };

export function accountScope(auth: CodexAuthMaterial): string {
  return auth.accountId ? paymentAccountScope(auth.accountId) : `credential-${createHash("sha256").update(auth.accessToken).digest("hex").slice(0, 16)}`;
}

export function startAccountRequests(args: {
  accounts: AccountCredential[];
  homes: CodexHome[];
  options: CliOptions;
  importedDatasets: UsageDataset[];
  importedPaymentHistories: Array<{ history: PaymentHistory; generatedAt: string }>;
  cacheDir: string;
  progress: AccountApiProgress;
}) {
  const { accounts, homes, options, importedDatasets, progress } = args;
  const scopeId = accountScope;
  const label = (auth: AccountCredential, index: number) => `${homes.find((home) => home.path === auth.sourceHome)?.label ?? "account"} (${index + 1})`;
  const update = (kind: string, auth: AccountCredential, index: number) => {
    const report = progress.update(`${kind}:${scopeId(auth)}`);
    let previousCompleted = 0;
    let previousTotal = 0;
    let completedOffset = 0;
    let totalOffset = 0;
    return (completed: number, total: number, active: string[]) => {
      if (completed < previousCompleted) { completedOffset += previousCompleted; totalOffset += previousTotal; }
      previousCompleted = completed;
      previousTotal = total;
      report(completedOffset + completed, totalOffset + total, accounts.length > 1 ? active.map((name) => `${label(auth, index)} ${name}`) : active);
    };
  };
  const retry = async <T extends { error?: string } | undefined>(auth: AccountCredential, request: (credential: CodexAuthMaterial) => Promise<T>): Promise<T> => {
    const candidates = [auth, ...(auth.credentialCandidates ?? [])].filter((credential, index, all) => all.findIndex((candidate) => candidate.accessToken === credential.accessToken) === index);
    let result: T;
    for (const credential of candidates) {
      result = await request(credential);
      if (!result?.error || !/(?:HTTP |returned )401\b/.test(result.error)) return result;
    }
    return result!;
  };
  const paymentsPromise = Promise.all(accounts.map((auth, index) => {
    const onRequestProgress = update("payments", auth, index);
    return retry(auth, (credential) => loadPayments({
      noApi: options.noApi, baseUrl: options.baseUrl, auth: credential,
      cacheDir: args.cacheDir, refreshCache: options.refreshPayments,
      onRequestProgress,
      allowUnscopedImportedHistory: false,
      importedHistories: args.importedPaymentHistories,
    }));
  })).then(async (histories) => {
    const overrides = options.paymentsJson ? await loadPayments({ paymentsJson: options.paymentsJson, noApi: true, baseUrl: options.baseUrl, auth: null }) : undefined;
    return mergePaymentHistories(histories, overrides);
  });
  const profilePromises = options.profileJson
    ? [loadProfile({ profileJson: options.profileJson, noApi: true, baseUrl: options.baseUrl, auth: null })]
    : accounts.map((auth, index) => {
      const onRequestProgress = update("profile", auth, index);
      return options.source === "local" ? Promise.resolve<ProfileLoadResult>({ fetched: false })
        : retry(auth, (credential) => loadProfile({ noApi: options.noApi, baseUrl: options.baseUrl, auth: credential, onRequestProgress }));
    });
  const profilePromise = Promise.all(profilePromises).then((results) => {
    if (options.profileJson) return results[0];
    return mergeProfileAccounts(results.map((result, index) => profileSnapshot(result, scopeId(accounts[index]), accounts[index].sourceHomes)));
  });
  void paymentsPromise.catch(() => {});
  void profilePromise.catch(() => {});
  let whamRequestCount = 0;
  function startAnalytics(threads: LocalThreadSummary[], localDates: string[]) {
    if (!accounts.length || options.analyticsJson) return loadWhamAnalytics({ analyticsJson: options.analyticsJson, noApi: true, baseUrl: options.baseUrl, auth: null, from: options.from, to: options.to, sections: options.sections }).then((analytics) => options.analyticsJson ? analytics : undefined);
    return Promise.all(accounts.map(async (auth, index) => {
      const result = options.profileJson ? await profilePromise : await profilePromises[index];
      const labels = new Set(homes.filter((home) => auth.sourceHomes.includes(home.path)).map((home) => home.label));
      const ownedThreads = threads.filter((thread) => thread.homePath ? auth.sourceHomes.includes(thread.homePath) : labels.has(thread.homeLabel) && homes.filter((home) => home.label === thread.homeLabel).every((home) => auth.sourceHomes.includes(home.path)));
      const onRequestProgress = update("wham", auth, index);
      const analytics = await retry(auth, (credential) => loadWhamAnalytics({
        noApi: options.noApi, baseUrl: options.baseUrl, auth: credential,
        from: options.from ?? [...localDates, ...(result.profile?.dailyUsageBuckets ?? []).map((bucket) => bucket.startDate), ...importedDatasets.flatMap((dataset) => dataset.daily.map((day) => day.date))].sort()[0] ?? null,
        to: options.to, threads: ownedThreads, sections: options.sections,
        onRequestsComplete: (count) => { whamRequestCount += count; },
        onRequestProgress,
      }));
      return analytics && { ...analytics, accountId: scopeId(auth), accountLabel: label(auth, index) };
    })).then((snapshots) => mergeWhamAccounts(snapshots.filter((snapshot) => snapshot !== undefined)));
  }
  return { profilePromise, paymentsPromise, startAnalytics, requestCount: () => whamRequestCount };
}
