import { createSkillRegistry } from "../../src/skills";
import { describeStubService } from "../helpers/stub-services";

describeStubService({
  name: "skills SkillRegistry",
  service: createSkillRegistry(),
  idPrefix: "server.skills.registry",
  methods: ["propose", "activate", "forPrincipal"],
});
