import { createConnectionRegistry } from "../../src/connections";
import { describeStubService } from "../helpers/stub-services";

describeStubService({
  name: "connections ConnectionRegistry",
  service: createConnectionRegistry(),
  idPrefix: "server.connections.registry",
  methods: ["register", "list", "health", "recordFeedSeen"],
});
