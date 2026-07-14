/**
 * @lithis/server — the modular-monolith backend. Modules expose their
 * interfaces via their own index.ts ONLY (ESLint-enforced); this root entry
 * re-exports the published surfaces plus config and migration composition.
 * Boot lives in ./main.ts (side-effectful; not re-exported here).
 */

export * from "./config";
export * from "./db/migrate";
export * from "./spine";
export * from "./iam";
export * from "./custody";
export * from "./context";
export * from "./work";
export * from "./processes";
export * from "./humangate";
export * from "./agents";
export * from "./connections";
export * from "./delivery";
export * from "./skills";
export * from "./artifacts";
export * from "./sor";
export * from "./sentinel";
export * from "./api";
