import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

const TEST_AUTH_PIN = "1234";
const TEST_JWT_SECRET = "test-only-jwt-secret-with-32-plus-characters";

process.env.AUTH_PIN ??= TEST_AUTH_PIN;
process.env.JWT_SECRET ??= TEST_JWT_SECRET;

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				miniflare: {
					bindings: {
						AUTH_PIN: TEST_AUTH_PIN,
						JWT_SECRET: TEST_JWT_SECRET,
					},
				},
				wrangler: { configPath: "./wrangler.jsonc" },
			},
		},
	},
});
