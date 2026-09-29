import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parse, type TomlTable, type TomlValue } from "smol-toml";

/**
 * The Responses provider the Codex CLI itself would use, read from Codex's own configuration.
 *
 * Happy Agent owns its provider registry, so this is imported only when a provider explicitly asks
 * for it. Nothing here is inferred from a guess: a field is present when Codex's file states it,
 * and the built-in `openai` provider keeps Happy Agent's ordinary credential path.
 */
export interface CodexCliProviderSelection {
    /** The `model_provider` key; Codex names its own built-in provider `openai`. */
    readonly providerId: string;
    /** `[model_providers.<id>].name`, when the file labels the provider. */
    readonly providerName?: string;
    /** The Responses base URL the Codex CLI sends inference to. */
    readonly baseUrl?: string;
    /** `wire_api`; only `responses` describes a route Happy Agent can speak. */
    readonly wireApi?: string;
    /**
     * `requires_openai_auth = false` is the one credential statement this import acts on. An
     * absent value stays absent so Happy Agent keeps its ordinary OpenAI credential discovery:
     * most custom gateways proxy OpenAI and still expect the account's own login.
     */
    readonly requiresOpenAiAuth?: boolean;
    /** The bearer token Codex would send, from the file or from the named environment variable. */
    readonly bearerToken?: string;
    /** Which of the two bearer sources above answered, for diagnostics. */
    readonly bearerTokenSource?: "experimental_bearer_token" | "env_key";
    /** The default `model` the Codex CLI was told to use. */
    readonly model?: string;
    /** `model_context_window`, when the file overrides Codex's own window for that model. */
    readonly contextWindow?: number;
    /** `model_auto_compact_token_limit`, when the file overrides Codex's compaction threshold. */
    readonly autoCompactWindow?: number;
}

export interface ReadCodexCliConfigurationOptions {
    /** The file to read instead of the one the Codex home implies. */
    readonly configFile?: string;
    readonly env?: NodeJS.ProcessEnv;
}

/** Codex's own config is a small file; anything larger is not the file this feature reads. */
const MAX_CODEX_CLI_CONFIG_BYTES = 1_048_576;
const MAX_CODEX_CLI_STRING_LENGTH = 16_384;

/**
 * Where the Codex CLI keeps its configuration. The Codex home is shared with Codex itself:
 * `CODEX_HOME` when it names one, and `~/.codex` otherwise.
 */
export function codexCliConfigPath(options: { readonly env?: NodeJS.ProcessEnv } = {}): string {
    const codexHome = (options.env ?? process.env).CODEX_HOME?.trim();
    return join(codexHome || homedir(), codexHome ? "config.toml" : ".codex/config.toml");
}

/**
 * Read the Codex CLI's selected provider, or nothing when this machine has no Codex config.
 *
 * A missing file means "this machine never configured Codex", which is the ordinary case and not
 * a failure. A file that exists but cannot be read as the shape Codex documents is raised instead
 * of dropped: a person who asked for this import must not silently keep running the old route,
 * which is the behavior this whole path exists to end.
 */
export function readCodexCliConfiguration(
    options: ReadCodexCliConfigurationOptions = {},
): CodexCliProviderSelection | undefined {
    const path = options.configFile ?? codexCliConfigPath(options);
    const contents = readCodexCliConfigFile(path);
    if (contents === undefined) return undefined;

    const table = parseCodexCliTable(contents, path);
    const providerId = readString(table, "model_provider") ?? "openai";
    const modelProviders = readTable(table, "model_providers");
    const providerTable =
        modelProviders === undefined ? undefined : readTable(modelProviders, providerId);
    if (providerId !== "openai" && providerTable === undefined) {
        throw new Error(
            `The Codex configuration selects model_provider "${providerId}" but defines no [model_providers.${providerId}] table.`,
        );
    }

    const selection: {
        providerId: string;
        providerName?: string;
        baseUrl?: string;
        wireApi?: string;
        requiresOpenAiAuth?: boolean;
        bearerToken?: string;
        bearerTokenSource?: "experimental_bearer_token" | "env_key";
        model?: string;
        contextWindow?: number;
        autoCompactWindow?: number;
    } = { providerId };
    const providerName =
        providerTable === undefined ? undefined : readString(providerTable, "name");
    if (providerName !== undefined) selection.providerName = providerName;
    const baseUrl = providerTable === undefined ? undefined : readString(providerTable, "base_url");
    if (baseUrl !== undefined) selection.baseUrl = baseUrl;
    const wireApi = providerTable === undefined ? undefined : readString(providerTable, "wire_api");
    if (wireApi !== undefined) selection.wireApi = wireApi;
    if (providerTable !== undefined) {
        const requiresOpenAiAuth = readBoolean(providerTable, "requires_openai_auth");
        if (requiresOpenAiAuth !== undefined) {
            selection.requiresOpenAiAuth = requiresOpenAiAuth;
        }
    }
    const bearer = readCodexCliBearerToken(providerTable, options.env ?? process.env);
    if (bearer !== undefined) {
        selection.bearerToken = bearer.token;
        selection.bearerTokenSource = bearer.source;
    }
    const model = readString(table, "model");
    if (model !== undefined) selection.model = model;
    const contextWindow = readPositiveInteger(table, "model_context_window");
    if (contextWindow !== undefined) selection.contextWindow = contextWindow;
    const autoCompactWindow = readPositiveInteger(table, "model_auto_compact_token_limit");
    if (autoCompactWindow !== undefined) selection.autoCompactWindow = autoCompactWindow;
    return selection;
}

function readCodexCliConfigFile(path: string): string | undefined {
    let contents: string;
    try {
        contents = readFileSync(path, "utf8");
    } catch (error) {
        if (isFileNotFound(error)) return undefined;
        throw error;
    }
    if (Buffer.byteLength(contents, "utf8") > MAX_CODEX_CLI_CONFIG_BYTES) {
        throw new Error(
            `The Codex configuration at "${path}" exceeds the ${MAX_CODEX_CLI_CONFIG_BYTES}-byte limit.`,
        );
    }
    return contents;
}

function parseCodexCliTable(contents: string, path: string): TomlTable {
    let parsed: TomlValue;
    try {
        parsed = parse(contents);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`The Codex configuration at "${path}" is not valid TOML: ${reason}`);
    }
    if (!isTable(parsed)) {
        throw new Error(`The Codex configuration at "${path}" must be a TOML table.`);
    }
    return parsed;
}

/**
 * Codex accepts a literal token and, separately, the name of a variable that holds one. The
 * literal wins, matching Codex's own precedence.
 */
function readCodexCliBearerToken(
    providerTable: TomlTable | undefined,
    env: NodeJS.ProcessEnv,
):
    | { readonly token: string; readonly source: "experimental_bearer_token" | "env_key" }
    | undefined {
    if (providerTable === undefined) return undefined;
    const literal = readString(providerTable, "experimental_bearer_token");
    if (literal !== undefined) {
        return { source: "experimental_bearer_token", token: literal };
    }
    const envKey = readString(providerTable, "env_key");
    if (envKey === undefined) return undefined;
    const fromEnvironment = env[envKey]?.trim();
    return fromEnvironment === undefined || fromEnvironment.length === 0
        ? undefined
        : { source: "env_key", token: fromEnvironment };
}

function readString(table: TomlTable | undefined, key: string): string | undefined {
    const value = table?.[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string") {
        throw new Error(`The Codex configuration field "${key}" must be a string.`);
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    if (trimmed.length > MAX_CODEX_CLI_STRING_LENGTH) {
        throw new Error(
            `The Codex configuration field "${key}" exceeds ${MAX_CODEX_CLI_STRING_LENGTH} characters.`,
        );
    }
    return trimmed;
}

function readBoolean(table: TomlTable | undefined, key: string): boolean | undefined {
    const value = table?.[key];
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") {
        throw new Error(`The Codex configuration field "${key}" must be a boolean.`);
    }
    return value;
}

function readPositiveInteger(table: TomlTable | undefined, key: string): number | undefined {
    const value = table?.[key];
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`The Codex configuration field "${key}" must be a positive integer.`);
    }
    return value;
}

function readTable(table: TomlTable | undefined, key: string): TomlTable | undefined {
    const value = table?.[key];
    if (value === undefined) return undefined;
    if (!isTable(value)) {
        throw new Error(`The Codex configuration field "${key}" must be a TOML table.`);
    }
    return value;
}

function isTable(value: TomlValue | undefined): value is TomlTable {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
    return (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
    );
}
