import { createAgentExecutor, createAgentHost, createToolBroker } from "../../src/agents";
import { describeStubService } from "../helpers/stub-services";

describeStubService({
  name: "agents AgentHost",
  service: createAgentHost(),
  idPrefix: "server.agents.host",
  methods: ["ensure", "wake", "status"],
});

describeStubService({
  name: "agents AgentExecutor",
  service: createAgentExecutor(),
  idPrefix: "server.agents.executor",
  methods: ["execute"],
});

describeStubService({
  name: "agents ToolBroker",
  service: createToolBroker(),
  idPrefix: "server.agents.toolbroker",
  methods: ["toolsFor"],
});
