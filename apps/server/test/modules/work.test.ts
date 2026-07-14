import { expect, test } from "bun:test";
import { createWorkQueue } from "../../src/work";
import { describeStubService } from "../helpers/stub-services";

describeStubService({
  name: "work WorkQueue",
  service: createWorkQueue(),
  idPrefix: "server.work.queue",
  methods: ["open", "claim", "heartbeat", "release", "complete", "addNote"],
});

test("work factory returns a singleton (stub ids register exactly once)", () => {
  expect(createWorkQueue()).toBe(createWorkQueue());
});
