import { createIdentityService, createPolicyEngine } from "../../src/iam";
import { describeStubService } from "../helpers/stub-services";

describeStubService({
  name: "iam PolicyEngine (deferred — see TODOS.md)",
  service: createPolicyEngine(),
  idPrefix: "server.iam.policy",
  methods: ["check"],
});

describeStubService({
  name: "iam IdentityService",
  service: createIdentityService(),
  idPrefix: "server.iam.identity",
  methods: ["createTenant", "createPrincipal", "getCharter"],
});
