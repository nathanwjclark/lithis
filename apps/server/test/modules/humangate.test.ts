import { expect, test } from "bun:test";
import { createHumanGate } from "../../src/humangate";
import { describeStubService } from "../helpers/stub-services";

describeStubService({
  name: "humangate HumanGate",
  service: createHumanGate(),
  idPrefix: "server.humangate.gate",
  methods: ["request", "resolve", "inbox", "tick"],
});

test("humangate factory returns a singleton (stub ids register exactly once)", () => {
  expect(createHumanGate()).toBe(createHumanGate());
});
