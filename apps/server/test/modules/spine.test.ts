import { expect, test } from "bun:test";
import { createClock, createEventSpine } from "../../src/spine";
import { describeStubService } from "../helpers/stub-services";

describeStubService({
  name: "spine EventSpine",
  service: createEventSpine(),
  idPrefix: "server.spine.events",
  methods: ["append", "subscribe", "readSince"],
});

describeStubService({
  name: "spine Clock",
  service: createClock(),
  idPrefix: "server.spine.clock",
  methods: ["tick"],
});

test("spine factories return singletons (stub ids register exactly once)", () => {
  expect(createEventSpine()).toBe(createEventSpine());
  expect(createClock()).toBe(createClock());
});
