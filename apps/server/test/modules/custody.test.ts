import { createCustody } from "../../src/custody";
import { describeStubService } from "../helpers/stub-services";

describeStubService({
  name: "custody Custody",
  service: createCustody(),
  idPrefix: "server.custody.broker",
  methods: ["getBrokered", "mountSession"],
});
