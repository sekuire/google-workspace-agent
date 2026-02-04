import type { Request, Response, NextFunction } from "express";
import type { SekuireSDK } from "@sekuire/sdk";

export interface A2AAuthConfig {
	sdk?: SekuireSDK;
	adminKey?: string;
	skipAuth?: boolean;
}

export function createA2AAuthMiddleware(config: A2AAuthConfig) {
	return (req: Request, res: Response, next: NextFunction): void => {
		if (config.skipAuth) {
			next();
			return;
		}

		const authHeader = req.headers.authorization;
		const adminKey = req.headers["x-admin-key"] as string | undefined;

		if (adminKey && config.adminKey && adminKey === config.adminKey) {
			next();
			return;
		}

		if (authHeader?.startsWith("Bearer ")) {
			const token = authHeader.slice(7);

			const runtimeCreds = config.sdk?.getRuntimeCredentials();
			if (runtimeCreds && token === runtimeCreds.runtimeToken) {
				next();
				return;
			}

			if (config.adminKey && token === config.adminKey) {
				next();
				return;
			}
		}

		res.status(401).json({
			error: {
				code: "unauthorized",
				message: "Valid Bearer token or X-Admin-Key required for A2A requests",
			},
		});
	};
}
