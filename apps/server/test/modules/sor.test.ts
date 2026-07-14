import { createSorRuntime } from "../../src/sor";
import { describeStubService } from "../helpers/stub-services";

describeStubService({
  name: "sor SorRuntime",
  service: createSorRuntime(),
  idPrefix: "server.sor.runtime",
  methods: ["propose", "apply", "table"],
});
