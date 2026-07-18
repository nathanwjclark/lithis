import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SkillRun, SkillRunContext } from "@lithis/sdk/skills";
import type { WorkItem } from "@lithis/core";

export { weeklyReportManifest } from "./manifest";

/**
 * weekly-report — REAL deterministic compilation, no LLM: real queries over
 * the run context's surfaces, rendered as markdown, handed to delivery as one
 * digest card. Section titles (sections.md) and the intro line (prompt.md)
 * are the selfModBounds-modifiable authoring surface; a surface the context
 * does not provide renders an honest "unavailable" line, never fake counts.
 */

const SECTION_KEYS = ["work", "approvals", "relationships", "connections"] as const;
type SectionKey = (typeof SECTION_KEYS)[number];

function readAsset(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
}

/** sections.md: one `key: Title` line per section — the render order + headings. */
export function parseSectionTitles(source: string): Record<SectionKey, string> {
  const titles: Record<string, string> = {};
  for (const line of source.split("\n")) {
    const sep = line.indexOf(":");
    if (sep <= 0) continue;
    titles[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
  }
  for (const key of SECTION_KEYS) {
    if (titles[key] === undefined) titles[key] = key;
  }
  return titles as Record<SectionKey, string>;
}

/** Monday 00:00 UTC of the week containing `at` (or the given ISO date). */
export function weekStartOf(at: string): string {
  const d = new Date(at);
  d.setUTCHours(0, 0, 0, 0);
  const day = d.getUTCDay(); // 0 = Sunday
  d.setUTCDate(d.getUTCDate() - ((day + 6) % 7));
  return d.toISOString();
}

function bullet(items: string[], max = 10): string {
  const shown = items.slice(0, max).map((t) => `- ${t}`);
  if (items.length > max) shown.push(`- … and ${items.length - max} more`);
  return shown.join("\n");
}

async function workSection(ctx: SkillRunContext, since: string): Promise<string> {
  if (ctx.work === undefined) return "unavailable (no work surface provided to this run)";
  const recent = await ctx.work.listRecent({ since, limit: 200 });
  const of = (status: WorkItem["status"]): WorkItem[] => recent.filter((w) => w.status === status);
  const done = of("done");
  const blocked = of("blocked");
  const lines = [
    `Completed: **${done.length}** · Blocked: **${blocked.length}** (of ${recent.length} items touched this week)`,
  ];
  if (done.length > 0) lines.push("", "Completed:", bullet(done.map((w) => w.title)));
  if (blocked.length > 0) lines.push("", "Blocked:", bullet(blocked.map((w) => w.title)));
  return lines.join("\n");
}

async function approvalsSection(ctx: SkillRunContext): Promise<string> {
  if (ctx.approvals === undefined) {
    return "unavailable (no approvals surface provided to this run)";
  }
  const pending = await ctx.approvals.listPending();
  if (pending.length === 0) return "Nothing pending.";
  return [
    `**${pending.length}** pending request(s):`,
    bullet(pending.map((r) => `[${r.kind}] ${r.summary}`)),
  ].join("\n");
}

async function connectionsSection(ctx: SkillRunContext): Promise<string> {
  if (ctx.connections === undefined) {
    return "unavailable (no connections surface provided to this run)";
  }
  const connections = await ctx.connections.list();
  if (connections.length === 0) return "No connections registered.";
  return bullet(
    connections.map((c) => {
      const health =
        c.health.lastError !== undefined
          ? `last error: ${c.health.lastError}`
          : c.health.lastOkAt !== undefined
            ? `last ok ${c.health.lastOkAt}`
            : "not probed yet";
      return `${c.connectorSlug} (${c.displayName}) — ${c.status}, ${health}`;
    }),
  );
}

export const run: SkillRun = async (input, ctx) => {
  const weekOf =
    typeof input["weekOf"] === "string" ? weekStartOf(input["weekOf"]) : weekStartOf(ctx.now);
  const requested = Array.isArray(input["sections"])
    ? (input["sections"].filter((s): s is SectionKey =>
        (SECTION_KEYS as readonly string[]).includes(s as string),
      ) as SectionKey[])
    : [...SECTION_KEYS];

  const titles = parseSectionTitles(readAsset("./sections.md"));
  const intro = readAsset("./prompt.md").replaceAll("{{weekOf}}", weekOf.slice(0, 10)).trim();

  const bodies: Record<SectionKey, () => Promise<string>> = {
    work: () => workSection(ctx, weekOf),
    approvals: () => approvalsSection(ctx),
    // Honest gap: there is no relationship read surface yet (context module
    // relationship_scores have no query API) — say so instead of inventing one.
    relationships: async () => "unavailable (no relationship read surface yet)",
    connections: () => connectionsSection(ctx),
  };

  const title = `Weekly digest — week of ${weekOf.slice(0, 10)}`;
  const parts: string[] = [intro];
  for (const key of requested) {
    parts.push(`## ${titles[key]}`, await bodies[key]());
  }
  const markdown = parts.join("\n\n");

  const delivery =
    ctx.deliver !== undefined
      ? await ctx.deliver.send({ kind: "digest", title, markdown })
      : { sent: false, detail: "no deliver surface provided to this run" };

  return { title, weekOf, sections: requested, markdown, delivery };
};
