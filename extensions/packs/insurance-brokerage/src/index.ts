/**
 * @lithis/pack-insurance-brokerage — authored data for the flagship domain:
 * the SMB underwriting process, the AMS system-of-record, context schema
 * extensions, and compliance watcher charters. See README.md.
 */
export { underwritingSmbTemplate, type ProcessTemplateDraft } from "./process-underwriting";
export { amsSorDescriptor, type SorDescriptorDraft } from "./sor-ams";
export { insuranceSchemaPack } from "./schema-pack";
export { njBrokerComplianceWatcher, packWatcherConfigs, type WatcherCharterConfig } from "./watchers";
