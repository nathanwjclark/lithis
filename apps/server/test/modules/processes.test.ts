import { createProcessEngine } from "../../src/processes";
import { describeStubService } from "../helpers/stub-services";

describeStubService({
  name: "processes ProcessEngine",
  service: createProcessEngine(),
  idPrefix: "server.processes.engine",
  methods: ["instantiate", "onEvent", "planInvalidation", "executeInvalidation", "proposeGraphChange"],
});
