export const REPORT_SECTIONS = [
  "summary", "intensity", "trend", "roi", "models", "surfaces", "cloud", "skills", "thinking", "mode", "cyber", "token", "input", "output", "details",
  "feature", "turn", "chats", "limits-feature", "limits-model", "limits-surface", "limits-turn", "messages-model", "messages-surface",
] as const;

export type ReportSection = (typeof REPORT_SECTIONS)[number];

const sectionNames = new Set<string>(REPORT_SECTIONS);

export function parseSections(value: string): ReportSection[] {
  const parts = value.split(",").map((part) => part.trim());

  if (parts.some((part) => !part || part === "-all")) {
    throw new Error("--sections requires section names separated by commas; use all or all,-name for exclusions");
  }

  const selected = new Set<ReportSection>(parts[0].startsWith("-") ? REPORT_SECTIONS : []);

  for (const part of parts) {
    if (part === "all") {
      REPORT_SECTIONS.forEach((section) => selected.add(section));
      continue;
    }

    const excluded = part.startsWith("-");
    const name = excluded ? part.slice(1) : part;
    if (!sectionNames.has(name)) {
      throw new Error(`Unknown report section ${name}; valid sections: ${REPORT_SECTIONS.join(", ")}`);
    }

    if (excluded) selected.delete(name as ReportSection);
    else selected.add(name as ReportSection);
  }

  return REPORT_SECTIONS.filter((section) => selected.has(section));
}
