import { createPolicyEngine } from "../../src/iam";
import { describeStubService } from "../helpers/stub-services";

// IdentityService is REAL as of phase 1 — behavioral coverage lives in
// test/integration/iam.pg.test.ts. Only the deliberately-deferred policy
// engine remains stubbed (see TODOS.md).
describeStubService({
  name: "iam PolicyEngine (deferred — see TODOS.md)",
  service: createPolicyEngine(),
  idPrefix: "server.iam.policy",
  methods: ["check"],
});
