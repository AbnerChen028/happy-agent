import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    codexCliConfigPath,
    readCodexCliConfiguration,
} from "../../sources/config/impl/codexCliConfiguration.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

async function writeConfig(source: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "happy-agent-codex-cli-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "config.toml");
    await writeFile(path, source);
    return path;
}

describe("Codex CLI configuration import", () => {
    it("resolves the Codex home the way Codex itself does", () => {
        expect(codexCliConfigPath({ env: { CODEX_HOME: "/tmp/codex-home" } })).toBe(
            "/tmp/codex-home/config.toml",
        );
        expect(codexCliConfigPath({ env: {} }).endsWith("/.codex/config.toml")).toBe(true);
    });

    it("answers with nothing when the machine has no Codex config", () => {
        expect(
            readCodexCliConfiguration({
                configFile: join(tmpdir(), "happy-agent-absent-codex-config", "config.toml"),
            }),
        ).toBeUndefined();
    });

    it("reads a switcher-written provider without inventing missing statements", async () => {
        const path = await writeConfig(
            [
                'model_provider = "custom"',
                'model = "deepseek-flash"',
                "model_context_window = 1000000",
                "model_auto_compact_token_limit = 900000",
                "",
                "[model_providers.custom]",
                'name = "deepseek"',
                'base_url = "https://gateway.example/v1"',
                'wire_api = "responses"',
                "requires_openai_auth = false",
                'experimental_bearer_token = "gateway-token"',
                "",
            ].join("\n"),
        );

        expect(readCodexCliConfiguration({ configFile: path })).toEqual({
            autoCompactWindow: 900_000,
            baseUrl: "https://gateway.example/v1",
            bearerToken: "gateway-token",
            bearerTokenSource: "experimental_bearer_token",
            contextWindow: 1_000_000,
            model: "deepseek-flash",
            providerId: "custom",
            providerName: "deepseek",
            requiresOpenAiAuth: false,
            wireApi: "responses",
        });
    });

    it("defaults to Codex's own built-in provider when the file names none", async () => {
        const path = await writeConfig('model = "gpt-5.6-sol"\n');

        expect(readCodexCliConfiguration({ configFile: path })).toEqual({
            model: "gpt-5.6-sol",
            providerId: "openai",
        });
    });

    it("takes the bearer token from the named environment variable", async () => {
        const path = await writeConfig(
            [
                'model_provider = "custom"',
                "",
                "[model_providers.custom]",
                'base_url = "https://gateway.example/v1"',
                'env_key = "GATEWAY_API_KEY"',
                "",
            ].join("\n"),
        );

        expect(
            readCodexCliConfiguration({
                configFile: path,
                env: { GATEWAY_API_KEY: "from-environment" },
            }),
        ).toMatchObject({
            bearerToken: "from-environment",
            bearerTokenSource: "env_key",
        });

        // A named variable that holds nothing is not a credential, and the file is still read.
        expect(readCodexCliConfiguration({ configFile: path, env: {} })).not.toHaveProperty(
            "bearerToken",
        );
    });

    it("lets the literal token win over the environment variable", async () => {
        const path = await writeConfig(
            [
                'model_provider = "custom"',
                "",
                "[model_providers.custom]",
                'env_key = "GATEWAY_API_KEY"',
                'experimental_bearer_token = "literal"',
                "",
            ].join("\n"),
        );

        expect(
            readCodexCliConfiguration({ configFile: path, env: { GATEWAY_API_KEY: "ambient" } }),
        ).toMatchObject({
            bearerToken: "literal",
            bearerTokenSource: "experimental_bearer_token",
        });
    });

    it("refuses a selection that names a provider the file never defines", async () => {
        const path = await writeConfig('model_provider = "custom"\n');

        expect(() => readCodexCliConfiguration({ configFile: path })).toThrow(
            'selects model_provider "custom"',
        );
    });

    it("refuses a file it cannot read rather than silently keeping the old route", async () => {
        const malformed = await writeConfig('model_provider = "custom"\n[model_providers\n');
        expect(() => readCodexCliConfiguration({ configFile: malformed })).toThrow(
            "is not valid TOML",
        );

        const wrongType = await writeConfig("model_provider = 7\n");
        expect(() => readCodexCliConfiguration({ configFile: wrongType })).toThrow(
            '"model_provider" must be a string',
        );

        const wrongWindow = await writeConfig("model_context_window = 0\n");
        expect(() => readCodexCliConfiguration({ configFile: wrongWindow })).toThrow(
            '"model_context_window" must be a positive integer',
        );
    });
});
