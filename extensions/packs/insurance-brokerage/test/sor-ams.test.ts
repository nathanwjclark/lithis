import { describe, expect, test } from "bun:test";
import { sorDescriptorSchema } from "@lithis/core";
import { amsSorDescriptor } from "../src/sor-ams";
import { serverFields } from "./fixtures";

describe("AMS SorDescriptor draft", () => {
  test("parses as a full SorDescriptor once server fields are attached", () => {
    const full = sorDescriptorSchema.parse({ ...serverFields(), ...amsSorDescriptor });
    expect(full.slug).toBe("ams");
    expect(full.version).toBe(1);
    expect(full.migrations).toEqual([]);
  });

  test("declares the four AMS tables", () => {
    expect(amsSorDescriptor.tables.map((t) => t.name).sort()).toEqual([
      "carriers",
      "clients",
      "commissions",
      "policies",
    ]);
  });

  test("clients and carriers bind to company entities", () => {
    const clients = amsSorDescriptor.tables.find((t) => t.name === "clients");
    const carriers = amsSorDescriptor.tables.find((t) => t.name === "carriers");
    expect(clients?.columns.find((c) => c.name === "legal_name")?.entityBinding).toBe("company");
    expect(carriers?.columns.find((c) => c.name === "name")?.entityBinding).toBe("company");
  });

  test("policies bind carrier/client/line columns into the context store", () => {
    const policies = amsSorDescriptor.tables.find((t) => t.name === "policies");
    const bindings = Object.fromEntries(
      (policies?.columns ?? []).filter((c) => c.entityBinding).map((c) => [c.name, c.entityBinding]),
    );
    expect(bindings).toEqual({
      client_legal_name: "company",
      carrier_name: "company",
      line_of_business: "policy_line",
    });
  });

  test("no column uses a reserved underscore-prefixed name (those belong to the runtime)", () => {
    for (const table of amsSorDescriptor.tables) {
      for (const column of table.columns) {
        expect(column.name.startsWith("_")).toBe(false);
      }
    }
  });
});
