import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { ConfigModule } from "../../sources/config/index.js";

const testContext = createRootContext().named("happy-agent-codex-import-test");

const temporaryDirectories: string[] = [];
const previousCodexHome = process.env.CODEX_HOME;

afterEach(async () => {
    if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
    } else {
        process.env.CODEX_HOME = previousCodexHome;
    }
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

interface TestMachine {
    readonly codexHome: string;
    readonly happyHome: string;
}

/**
 * One installation with its own Happy root and its own Codex home.
 *
 * The Codex home travels in the process environment as well as in the load options because the
 * vendor layer resolves both the imported route and the installation identity from the environment
 * it will actually run in.
 */
async function createMachine(options: {
    readonly codexConfig?: string;
    readonly happyToml: string;
    readonly authJson?: string;
}): Promise<TestMachine> {
    const root = await mkdtemp(join(tmpdir(), "happy-agent-codex-import-"));
    temporaryDirectories.push(root);
    const happyHome = join(root, ".happy");
    const codexHome = join(root, "codex");
    const configHome = join(root, process.platform === "darwin" ? "Happy/Config" : "happy/config");
    await mkdir(join(root, "Happy/Config"), { recursive: true });
    await mkdir(join(root, "happy/config"), { recursive: true });
    await writeFile(join(configHome, "happy.toml"), options.happyToml);
    await mkdir(codexHome, { recursive: true });
    if (options.codexConfig !== undefined) {
        await writeFile(join(codexHome, "config.toml"), options.codexConfig);
    }
    if (options.authJson !== undefined) {
        await writeFile(join(codexHome, "auth.json"), options.authJson);
    }
    process.env.CODEX_HOME = codexHome;
    return { codexHome, happyHome };
}

function loadMachine(machine: TestMachine): Promise<ConfigModule> {
    return ConfigModule.load(machine.happyHome, {
        environment: { CODEX_HOME: machine.codexHome },
    });
}

const gatewayConfig = [
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
].join("\n");

const importingToml = [
    "[providers]",
    "default_enable = false",
    "",
    "[providers.codex]",
    "enabled = true",
    "import_codex_config = true",
    'transport = "sse"',
    "",
].join("\n");

describe("Codex CLI configuration import", () => {
    it("publishes the imported model with the window the file declares", async () => {
        const machine = await createMachine({
            codexConfig: gatewayConfig,
            happyToml: importingToml,
        });
        const module = await loadMachine(machine);

        expect(module.configuration.values.defaults.modelId).toBe("deepseek-flash");
        expect(
            module.catalog.find(
                (model) => model.id === "deepseek-flash" && model.providerId === "codex",
            ),
        ).toMatchObject({
            autoCompactWindow: 900_000,
            contextWindow: 1_000_000,
            enabled: true,
        });
        // The imported route leads, because it is the one Codex itself would take.
        expect(module.models[0]).toMatchObject({
            id: "deepseek-flash",
            providerId: "codex",
        });
    });

    it("keeps a default model the person stated", async () => {
        const machine = await createMachine({
            codexConfig: gatewayConfig,
            happyToml: `${importingToml}\n[defaults]\nmodel = "openai/gpt-5.6-sol"\n`,
        });
        const module = await loadMachine(machine);

        expect(module.configuration.values.defaults.modelId).toBe("openai/gpt-5.6-sol");
        expect(module.models[0]).toMatchObject({ id: "openai/gpt-5.6-sol" });
        // The gateway's own model stays selectable rather than being dropped.
        expect(module.catalog.some((model) => model.id === "deepseek-flash" && model.enabled)).toBe(
            true,
        );
    });

    it("reads nothing at all when no provider imports the Codex configuration", async () => {
        const machine = await createMachine({
            // Unreadable on purpose: an account that never opted in must not even open this file.
            codexConfig: "[model_providers\n",
            happyToml: ["[providers.codex]", "enabled = true", ""].join("\n"),
        });
        const module = await loadMachine(machine);

        expect(module.configuration.values.defaults.modelId).toBe("openai/gpt-5.6-sol");
        expect(module.catalog.some((model) => model.id === "deepseek-flash")).toBe(false);
    });

    it("refuses to load rather than silently keeping the route a broken import replaced", async () => {
        const machine = await createMachine({
            codexConfig: "[model_providers\n",
            happyToml: importingToml,
        });

        await expect(loadMachine(machine)).rejects.toThrow("is not valid TOML");
    });

    it("rejects an import flag that is not a boolean", async () => {
        const machine = await createMachine({
            codexConfig: gatewayConfig,
            happyToml: [
                "[providers.codex]",
                "enabled = true",
                'import_codex_config = "yes"',
                "",
            ].join("\n"),
        });

        await expect(loadMachine(machine)).rejects.toThrow(
            "providers.codex contains an invalid value",
        );
    });

    it("never hands the machine's OpenAI login to a gateway that refuses it", async () => {
        const machine = await createMachine({
            codexConfig: [
                'model_provider = "custom"',
                "",
                "[model_providers.custom]",
                'base_url = "https://gateway.example/v1"',
                "requires_openai_auth = false",
                "",
            ].join("\n"),
            happyToml: importingToml,
            // A perfectly usable ChatGPT login sits right there and must stay unused.
            authJson: JSON.stringify({
                tokens: { access_token: "openai-access", account_id: "account-1" },
            }),
        });
        const module = await loadMachine(machine);

        await expect(module.providers.resolve("codex", module.models[0]!.id)).rejects.toThrow(
            "Codex authentication is unavailable",
        );
    });

    it("sends the imported route and token to the gateway the Codex CLI named", async () => {
        const requests: { authorization: string | undefined; body: string; url: string }[] = [];
        const server = createServer(async (request, response) => {
            let body = "";
            for await (const chunk of request) body += String(chunk);
            requests.push({
                authorization: request.headers.authorization,
                body,
                url: request.url ?? "",
            });
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(
                'data: {"type":"response.completed","response":{"id":"response","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\ndata: [DONE]\n\n',
            );
        });
        await new Promise<void>((resolve, reject) => {
            server.listen(0, "127.0.0.1", resolve);
            server.once("error", reject);
        });
        const address = server.address();
        if (typeof address !== "object" || address === null) expect.fail("Missing server port.");

        try {
            const machine = await createMachine({
                codexConfig: gatewayConfig.replace(
                    "https://gateway.example/v1",
                    `http://127.0.0.1:${address.port}/v1`,
                ),
                happyToml: importingToml,
            });
            const module = await loadMachine(machine);
            const provider = await module.providers.resolve("codex", "deepseek-flash");
            if (provider === null) expect.fail("The codex provider did not resolve.");
            const session = await provider.session("imported-route", { instructions: "test" });

            const events = [];
            for await (const event of session.run(testContext, {
                context: {
                    instructions: "",
                    messages: [
                        { role: "user", content: [{ type: "text" as const, text: "hello" }] },
                    ],
                },
                effort: "low",
                model: "deepseek-flash",
            })) {
                events.push(event);
            }

            expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
            expect(requests).toHaveLength(1);
            expect(requests[0]!.url.startsWith("/v1/")).toBe(true);
            expect(requests[0]!.authorization).toBe("Bearer gateway-token");
            expect(JSON.parse(requests[0]!.body)).toMatchObject({ model: "deepseek-flash" });
            session.destroy();
        } finally {
            server.close();
        }
    }, 60_000);
});
