import { createContextStore } from "../../src/context";
import { describeStubService } from "../helpers/stub-services";

describeStubService({
  name: "context ContextStore",
  service: createContextStore(),
  idPrefix: "server.context.store",
  methods: ["putBlob", "ingestDoc", "distill", "search", "paths"],
});
