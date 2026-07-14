import { createDelivery } from "../../src/delivery";
import { describeStubService } from "../helpers/stub-services";

describeStubService({
  name: "delivery Delivery",
  service: createDelivery(),
  idPrefix: "server.delivery.delivery",
  methods: ["render", "route"],
});
