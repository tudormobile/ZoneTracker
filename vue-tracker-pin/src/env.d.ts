interface Env {
	AUTH_PIN: string;
	JWT_SECRET: string;
	PROXY_HEADER_SECRET: string;
	PROXY_TARGET_ORIGIN: string;
	PROXY_HEADER_NAME?: string;
	PIN_LOGIN_RATE_LIMITER?: RateLimit;
}