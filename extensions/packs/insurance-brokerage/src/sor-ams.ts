import type { SorDescriptor } from "@lithis/core";

/**
 * The AMS (agency management system) system-of-record — the generated SQL
 * system a brokerage actually runs on. Declarative descriptor: the SoR
 * runtime renders DDL into a sor_{tenant}_ams schema and adds the structural
 * _entityRef + _origin columns to every table (the context-store link +
 * provenance). Migrations are approval-gated.
 *
 * Exported as a DRAFT: server-assigned fields (id, tenantId, timestamps,
 * ddlBlobId) are attached at propose() time.
 */
export type SorDescriptorDraft = Omit<
  SorDescriptor,
  "id" | "tenantId" | "createdAt" | "updatedAt" | "ddlBlobId"
>;

export const amsSorDescriptor: SorDescriptorDraft = {
  slug: "ams",
  displayName: "Agency Management System",
  version: 1,
  migrations: [],
  tables: [
    {
      name: "clients",
      description: "Insured clients of the brokerage (the book of business).",
      columns: [
        {
          name: "legal_name",
          type: "text",
          nullable: false,
          description: "Registered legal name of the insured.",
          entityBinding: "company",
        },
        { name: "dba_name", type: "text", nullable: true, description: "Doing-business-as name, if different." },
        { name: "fein", type: "text", nullable: true, description: "Federal employer identification number." },
        { name: "naics_code", type: "text", nullable: true, description: "Primary NAICS classification." },
        { name: "primary_contact_email", type: "text", nullable: true, description: "Main client contact email." },
        { name: "mailing_address", type: "jsonb", nullable: true, description: "Structured mailing address." },
        { name: "client_since", type: "date", nullable: true, description: "First effective date with the brokerage." },
        { name: "active", type: "boolean", nullable: false, description: "Whether the client currently has in-force business." },
      ],
    },
    {
      name: "policies",
      description: "In-force and historical policies placed for clients.",
      columns: [
        { name: "policy_number", type: "text", nullable: false, description: "Carrier-issued policy number." },
        {
          name: "client_legal_name",
          type: "text",
          nullable: false,
          description: "Insured client this policy covers.",
          entityBinding: "company",
        },
        {
          name: "carrier_name",
          type: "text",
          nullable: false,
          description: "Issuing carrier.",
          entityBinding: "company",
        },
        {
          name: "line_of_business",
          type: "text",
          nullable: false,
          description: "Coverage line (GL, property, WC, auto, umbrella, ...).",
          entityBinding: "policy_line",
        },
        { name: "effective_date", type: "date", nullable: false, description: "Coverage inception." },
        { name: "expiration_date", type: "date", nullable: false, description: "Coverage expiration (renewal trigger)." },
        { name: "annual_premium", type: "numeric", nullable: true, description: "Written annual premium (USD)." },
        { name: "limits", type: "jsonb", nullable: true, description: "Structured limits/sublimits/deductibles." },
        { name: "status", type: "text", nullable: false, description: "quoted | bound | in_force | cancelled | expired." },
        { name: "admitted", type: "boolean", nullable: true, description: "Admitted vs surplus-lines placement." },
      ],
    },
    {
      name: "carriers",
      description: "Carriers the brokerage places business with, incl. appetite notes.",
      columns: [
        {
          name: "name",
          type: "text",
          nullable: false,
          description: "Carrier legal name.",
          entityBinding: "company",
        },
        { name: "am_best_rating", type: "text", nullable: true, description: "Current AM Best financial strength rating." },
        { name: "admitted_states", type: "jsonb", nullable: true, description: "States where the carrier is admitted." },
        { name: "appetite", type: "jsonb", nullable: true, description: "Structured appetite: lines, classes, size bands." },
        { name: "portal_url", type: "text", nullable: true, description: "Carrier portal for submissions/quotes." },
        { name: "producer_code", type: "text", nullable: true, description: "Brokerage's producer/agency code with this carrier." },
      ],
    },
    {
      name: "commissions",
      description: "Commission receivables per policy per carrier statement.",
      columns: [
        { name: "policy_number", type: "text", nullable: false, description: "Policy the commission accrues on." },
        {
          name: "carrier_name",
          type: "text",
          nullable: false,
          description: "Paying carrier.",
          entityBinding: "company",
        },
        { name: "statement_date", type: "date", nullable: false, description: "Carrier commission statement date." },
        { name: "gross_premium", type: "numeric", nullable: true, description: "Premium the commission is computed on." },
        { name: "commission_rate", type: "numeric", nullable: true, description: "Rate applied (e.g. 0.125)." },
        { name: "commission_amount", type: "numeric", nullable: false, description: "Commission due/received (USD)." },
        { name: "paid", type: "boolean", nullable: false, description: "Whether the statement line has been paid out." },
        { name: "paid_at", type: "timestamptz", nullable: true, description: "When payment was reconciled." },
      ],
    },
  ],
};
