import type { GitRef, Skill, SkillManifest, Slug } from "@lithis/core";
import { skillManifestSchema } from "@lithis/core";
import type { SkillRun } from "@lithis/sdk/skills";
import { skillToolName } from "../agents";

/**
 * The in-process skill runtime — the registration seam mirroring
 * connectorRuntime.register(): main.ts imports the extension packages and
 * registers `{slug, kind, manifest, run, sourceRef}` at boot. There is NO
 * dynamic code loading; the registry's sourceRef rows are provenance, the
 * running code is whatever this server build shipped. Activation verifies
 * the stored manifest checksum against the registered manifest so registry
 * state and runtime code cannot silently drift.
 */

export interface SkillRegistration {
  slug: Slug;
  kind: Skill["kind"];
  manifest: SkillManifest;
  run: SkillRun;
  /** Provenance: where this skill's source lives in git. */
  sourceRef: GitRef;
}

export interface SkillRuntime {
  register(r: SkillRegistration): SkillRegistration;
  resolve(slug: string): SkillRegistration | undefined;
  /** Lookup by the broker-issued tool name (skillToolName over the manifest description). */
  resolveTool(toolName: string): SkillRegistration | undefined;
  list(): SkillRegistration[];
}

export function createSkillRuntime(): SkillRuntime {
  const bySlug = new Map<string, SkillRegistration>();
  const byToolName = new Map<string, SkillRegistration>();
  return {
    register(r: SkillRegistration): SkillRegistration {
      const manifest = skillManifestSchema.parse(r.manifest);
      const registration = { ...r, manifest };
      if (bySlug.has(r.slug)) {
        throw new Error(`skill runtime: slug '${r.slug}' is already registered`);
      }
      const toolName = skillToolName(manifest.description);
      const clash = byToolName.get(toolName);
      if (clash !== undefined) {
        throw new Error(
          `skill runtime: tool name '${toolName}' for '${r.slug}' collides with '${clash.slug}'`,
        );
      }
      bySlug.set(r.slug, registration);
      byToolName.set(toolName, registration);
      return registration;
    },
    resolve: (slug) => bySlug.get(slug),
    resolveTool: (toolName) => byToolName.get(toolName),
    list: () => [...bySlug.values()],
  };
}
