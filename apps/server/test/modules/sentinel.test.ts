import { createWatcherHost } from "../../src/sentinel";
import { describeStubService } from "../helpers/stub-services";

describeStubService({
  name: "sentinel WatcherHost",
  service: createWatcherHost(),
  idPrefix: "server.sentinel.watcherhost",
  methods: ["list", "ensureDefaults"],
});
