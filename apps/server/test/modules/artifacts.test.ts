import { createArtifactEngine } from "../../src/artifacts";
import { describeStubService } from "../helpers/stub-services";

describeStubService({
  name: "artifacts ArtifactEngine",
  service: createArtifactEngine(),
  idPrefix: "server.artifacts.engine",
  methods: ["render", "verify"],
});
