import { schemaPackSchema, type SchemaPack } from "@lithis/core";

/**
 * Context-store schema extensions for insurance brokerage: the entity types,
 * doc types, and link verbs the underwriting process and AMS SoR speak in.
 * Parsed at module load so a malformed pack fails at import, not at ingest.
 */
export const insuranceSchemaPack: SchemaPack = schemaPackSchema.parse({
  slug: "insurance-brokerage",
  version: "1.0.0",
  entityTypes: [
    {
      type: "carrier",
      description:
        "An insurance carrier the brokerage places business with (also a company; carrier adds appetite/rating semantics).",
      attrs: {
        amBestRating: { type: "string", description: "AM Best financial strength rating." },
        admitted: { type: "boolean", description: "Admitted status in the tenant's home state." },
        appetite: { type: "object", description: "Structured appetite: lines, class codes, size bands." },
      },
    },
    {
      type: "policy_line",
      description: "A line of business (GL, commercial property, workers comp, commercial auto, umbrella, ...).",
      attrs: {
        acordCode: { type: "string", description: "ACORD line-of-business code where applicable." },
      },
    },
  ],
  docTypes: [
    { type: "loss_run", description: "Carrier-issued claims history report for an insured." },
    { type: "acord_submission", description: "ACORD application forms + supplementals constituting a submission." },
    { type: "quote", description: "A carrier's quote/indication for a submission." },
    { type: "binder", description: "Carrier-issued temporary evidence of coverage after a bind request." },
  ],
  linkVerbs: [
    { verb: "insures", description: "Carrier insures a client (in-force policy).", inverse: "insured_by" },
    { verb: "insured_by", description: "Client is insured by a carrier.", inverse: "insures" },
    { verb: "broker_of", description: "Brokerage is broker of record for a client.", inverse: "brokered_by" },
    { verb: "brokered_by", description: "Client's coverage is brokered by the brokerage.", inverse: "broker_of" },
    { verb: "quoted", description: "Carrier quoted a submission/case.", inverse: "quoted_by" },
    { verb: "quoted_by", description: "Submission/case was quoted by a carrier.", inverse: "quoted" },
  ],
  retypeRules: [],
});
