// Augments the globally declared ioBroker types with everything this adapter adds.
// The attributes of `AdapterConfig` must be kept in sync with `native` in io-package.json
// and with admin/jsonConfig.json.

declare global {
    namespace ioBroker {
        interface AdapterConfig {
            /** How many days raw events and keyframes are kept: 1, 7, 30 or 90 */
            retentionDays: number;
            /** Seconds between two batched writes to the database */
            flushInterval: number;
            /** Object ID patterns (with `*`) that are always recorded */
            includePatterns: string[];
            /** Object ID patterns (with `*`) that are never recorded, even if included */
            excludePatterns: string[];
        }
    }
}

export {}; // required, so that the file counts as a module
