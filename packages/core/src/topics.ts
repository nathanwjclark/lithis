/**
 * The spine topic catalog, split per domain so parallel branches never collide
 * on one file. Domains register their topics in `topics/<domain>.ts` via
 * defineEventType() — registration happens at module load, so this barrel MUST
 * import every domain file; emitting an unregistered topic is a bug (and
 * defineEventType throws on duplicates, so a missed/renamed topic fails loudly
 * in tests). Payloads stay lean — the subjectRefs on the envelope carry
 * identity; payloads carry only what subscribers need without a fetch.
 *
 * Adding a topic: edit ONLY your domain's file (create `topics/<domain>.ts`
 * for a new domain and add its export line here).
 */
export * from "./topics/session";
export * from "./topics/context";
export * from "./topics/work";
export * from "./topics/process";
export * from "./topics/humangate";
export * from "./topics/run";
export * from "./topics/conversation";
export * from "./topics/connectivity";
export * from "./topics/skills";
export * from "./topics/artifacts";
export * from "./topics/sor";
export * from "./topics/delivery";
export * from "./topics/workspace";
export * from "./topics/agent";
