import type { ProcessTemplate } from "@lithis/core";

/**
 * The SMB commercial-lines underwriting process — the flagship authored
 * ProcessTemplate. Mode 'fixed': the graph is the graph; no instance-level
 * node additions or skips, and the compliance and bind nodes are protected.
 *
 * Exported as a DRAFT: server-assigned fields (id, tenantId, createdAt,
 * updatedAt, approvalRequestId) are attached when the template is proposed to
 * the process engine. Tests validate the draft by composing it with fixture
 * server fields and parsing the full processTemplateSchema.
 */
export type ProcessTemplateDraft = Omit<
  ProcessTemplate,
  "id" | "tenantId" | "createdAt" | "updatedAt" | "approvalRequestId"
>;

export const underwritingSmbTemplate: ProcessTemplateDraft = {
  slug: "underwriting-smb",
  version: "1.0.0",
  mode: "fixed",
  nodes: [
    {
      key: "intake",
      title: "Submission intake",
      instructions:
        "Normalize the inbound submission into the case record: applicant legal name and DBA, FEIN, NAICS/class codes, requested lines and limits, target effective/expiration dates, locations, and broker of record. Flag missing ACORD sections and unanswered supplemental questions as open items rather than inventing values. Create/update the client company entity and link the submission docs to the case.",
      inputSelectors: [
        {
          description: "The ACORD application(s) and any supplemental forms attached to the submission.",
          docTypes: ["acord_submission"],
        },
      ],
      resultSchemaRef: "pack:insurance-brokerage/underwriting-smb/intake@1",
      gate: "never",
      evidenceSpec:
        "Excerpts from the ACORD forms for every extracted field (applicant identity, lines, limits, dates) plus an explicit list of missing/unclear items.",
    },
    {
      key: "loss_history_analysis",
      title: "Loss history analysis",
      instructions:
        "Analyze 3-5 years of carrier loss runs for the applicant: loss frequency and severity by line and year, open claims with current reserves, total incurred vs paid, and a narrative for every claim above $25k. Compute loss ratios where premium history is available. Note gaps in the loss-run record (missing years, missing lines) explicitly — a missing year is a finding, not a zero.",
      inputSelectors: [
        { description: "Carrier loss runs for the applicant.", docTypes: ["loss_run"] },
        { description: "Normalized case facts from intake.", fromNodes: ["intake"] },
      ],
      resultSchemaRef: "pack:insurance-brokerage/underwriting-smb/loss-history@1",
      gate: "always",
      evidenceSpec:
        "Per-year loss table with source excerpts from each loss run (page/line locators), large-loss narratives quoting the run, and the list of missing years/lines.",
    },
    {
      key: "exposure_analysis",
      title: "Exposure analysis",
      instructions:
        "Establish the exposure basis per requested line: payroll by class code (WC), gross revenue (GL), total insured values with COPE detail per location (property), and vehicle/driver schedules (auto). Reconcile stated exposures against the ACORD forms and note discrepancies. Do not extrapolate exposures that are not documented.",
      inputSelectors: [
        { description: "ACORD applications, statements of values, schedules.", docTypes: ["acord_submission"] },
        { description: "Normalized case facts from intake.", fromNodes: ["intake"] },
      ],
      resultSchemaRef: "pack:insurance-brokerage/underwriting-smb/exposure@1",
      gate: "auto_below_threshold",
      evidenceSpec:
        "Exposure table per line with document excerpts backing each figure and a discrepancy list where sources disagree.",
    },
    {
      key: "carrier_appetite_match",
      title: "Carrier appetite match",
      instructions:
        "Match the risk profile (class codes, exposure sizes, loss picture, state) against current carrier appetite: produce a ranked shortlist of carriers to approach, each with a written rationale referencing the appetite source, admitted vs surplus-lines status, and any knock-out criteria that exclude a carrier. Include carriers declined and why.",
      inputSelectors: [
        { description: "Loss picture from the loss history analysis.", fromNodes: ["loss_history_analysis"] },
        { description: "Exposure basis from the exposure analysis.", fromNodes: ["exposure_analysis"] },
        {
          description: "Carrier appetite guides and market intelligence in the context store.",
          query: "carrier appetite guide",
        },
      ],
      resultSchemaRef: "pack:insurance-brokerage/underwriting-smb/appetite-match@1",
      gate: "auto_below_threshold",
      evidenceSpec:
        "Shortlist with per-carrier rationale citing appetite sources, plus the declined-carriers list with knock-out reasons.",
    },
    {
      key: "quote_comparison",
      title: "Quote comparison",
      instructions:
        "Normalize returned carrier quotes side-by-side: premium by line, limits and sublimits, deductibles/retentions, key exclusions and endorsements, subjectivities, and commission terms. Call out coverage differences that matter for this applicant (not boilerplate), and flag every unresolved subjectivity. Recommend a primary option with reasoning; never hide a cheaper-but-narrower quote.",
      inputSelectors: [
        { description: "Carrier quote documents received for this case.", docTypes: ["quote"] },
        { description: "The approached-carrier shortlist and rationale.", fromNodes: ["carrier_appetite_match"] },
      ],
      resultSchemaRef: "pack:insurance-brokerage/underwriting-smb/quote-comparison@1",
      gate: "always",
      evidenceSpec:
        "Side-by-side comparison table with quote-document excerpts for every premium/limit/exclusion cell and the open-subjectivities list.",
    },
    {
      key: "compliance_check",
      title: "Compliance check",
      instructions:
        "Verify the placement is compliant before anything reaches the client: broker licensing in the risk state, surplus-lines eligibility and diligent-effort documentation where a non-admitted carrier is recommended, required state disclosure and broker-compensation phrasing present in client-facing text, and carrier admitted status consistent with the recommendation. Any failure is a blocking finding — enumerate each with the governing requirement.",
      inputSelectors: [
        { description: "The normalized quote comparison and recommendation.", fromNodes: ["quote_comparison"] },
      ],
      resultSchemaRef: "pack:insurance-brokerage/underwriting-smb/compliance@1",
      gate: "always",
      evidenceSpec:
        "Checklist of verified requirements with the source of each (statute/bulletin/carrier status page excerpt) and explicit pass/fail per item.",
    },
    {
      key: "proposal_draft",
      title: "Proposal draft",
      instructions:
        "Render the client-facing proposal from the approved proposal template: recommended option with premium and coverage summary, alternatives considered, subjectivities the client must resolve, and the required disclosure language verbatim from the compliance check. The proposal is an Artifact — it must pass template verification before it can be sent.",
      inputSelectors: [
        { description: "Approved quote comparison.", fromNodes: ["quote_comparison"] },
        { description: "Compliance findings incl. required disclosure phrasing.", fromNodes: ["compliance_check"] },
      ],
      resultSchemaRef: "pack:insurance-brokerage/underwriting-smb/proposal@1",
      gate: "auto_below_threshold",
      evidenceSpec:
        "The rendered artifact ref, its verification report, and a diff of the disclosure language against the compliance-check requirement.",
    },
    {
      key: "bind_request",
      title: "Bind request",
      instructions:
        "Prepare the bind order for the client-selected quote: confirm every subjectivity is resolved with documentation, confirm client authorization to bind is on file, assemble the bind request to the carrier, and after carrier confirmation record the binder document against the case. Never send a bind request while any subjectivity or compliance finding is open.",
      inputSelectors: [
        { description: "The selected quote and client authorization.", docTypes: ["quote"], fromNodes: ["proposal_draft"] },
        { description: "Compliance clearance for the selected option.", fromNodes: ["compliance_check"] },
        { description: "The returned binder, once the carrier confirms.", docTypes: ["binder"] },
      ],
      resultSchemaRef: "pack:insurance-brokerage/underwriting-smb/bind@1",
      gate: "always",
      evidenceSpec:
        "Subjectivity-resolution checklist with documentation refs, the client authorization excerpt, the outgoing bind order, and the carrier binder capture.",
    },
  ],
  edges: [
    { from: "loss_history_analysis", to: "intake", kind: "depends_on" },
    { from: "exposure_analysis", to: "intake", kind: "depends_on" },
    { from: "carrier_appetite_match", to: "loss_history_analysis", kind: "depends_on" },
    { from: "carrier_appetite_match", to: "exposure_analysis", kind: "depends_on" },
    { from: "quote_comparison", to: "carrier_appetite_match", kind: "depends_on" },
    { from: "compliance_check", to: "quote_comparison", kind: "depends_on" },
    { from: "proposal_draft", to: "quote_comparison", kind: "depends_on" },
    { from: "proposal_draft", to: "compliance_check", kind: "depends_on" },
    { from: "bind_request", to: "proposal_draft", kind: "depends_on" },
    { from: "bind_request", to: "compliance_check", kind: "depends_on" },
  ],
  changePolicy: {
    allowAddNodes: false,
    allowSkip: false,
    protectedNodes: ["compliance_check", "bind_request"],
  },
};
