import Context from "./helpers/HTTP/Request/Context";
import { serve, FileSystemRouter, type Serve, type Server } from "bun";
import { config } from "./src/core/config";
import Pocketbase from "pocketbase";
import path from "path";
import { DatabaseService } from "./src/core/CrudManager";
import Cache from "./src/core/CacheManager";
import process from "process";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import * as z from "zod";
import { watch } from "fs";
import fs from "fs"
import { pathToFileURL } from "url";

// --- Global server and router instances ---
let server: Server;
// MODIFIED: Make the router a single, persistent instance
const router = new FileSystemRouter({
    style: "nextjs",
    dir: path.join(process.cwd(), "routes"),
});


// --- Validation: Ensure required config vars are present ---
if (!config.Clover_Secret || !config.Clover_Tenant_ID) {
    console.error("❌ Clover_Secret and Clover_Tenant_ID must be set in your config.");
    process.exit(1);
}

if (!config.ADMIN_EMAIL || !config.ADMIN_PASSWORD) {
    console.error("❌ Please set an admin email and admin password for database authentication");
    process.exit(1);
}

if(!fs.existsSync(path.join(process.cwd(), "routes"))){
    console.error("❌ Please create a routes folder and create your first route");
    process.exit(1);
}

// --- Pocketbase Connection ---
const pb = new Pocketbase(config.DatabaseUrl);
try {
    await pb.collection("_superusers").authWithPassword(config.ADMIN_EMAIL, config.ADMIN_PASSWORD);
} catch (_) { }

// --- Primary Tenant Data ---
const primaryTenantData = await fetch(`${config.Clover_Server_Url}/tenants/${config.Clover_Tenant_ID}`, {
    headers: { Authorization_Secret: config.Clover_Secret },
}).then(async (res) => {
    if (!res.ok) throw new Error(`Failed to fetch primary tenant data: ${res.status} ${res.statusText}`);
    return res.json();
});
console.log("✅ Primary tenant data loaded.");

const cache = new Cache();
const db = new DatabaseService(pb, cache); 
// --- Server Configuration Builder ---
async function createServeConfig(): Promise<Serve> {
    console.log("🛠️ Building server configuration...");

    // MODIFIED: Reload the router to detect new/deleted files
    router.reload();

    const routeHandlers = new Map<string, (ctx: Context, db: DatabaseService) => Promise<Response>>();
    const schemas = new Map();
    const middlewares = new Map<string, (ctx: Context) => Promise<Response | boolean>>();

    const reimportModule = async (modulePath: string) => { 
        const resolvedPath = path.resolve(modulePath);
        if (require.cache[resolvedPath]) {
            delete require.cache[resolvedPath];
        }
        const module = require(modulePath)
        return module
    };

    for (const [pathname, routePath] of Object.entries(router.routes)) {
        try {
            const routeModule = await reimportModule(routePath as string);
            if (routeModule.default) {
                routeHandlers.set(pathname, routeModule.default);
            }

            const schemaPath = path.join(process.cwd(), "schemas", pathname, "index.ts");
            if (await Bun.file(schemaPath).exists()) {
                const schema = await reimportModule(schemaPath);
                if (schema.default) schemas.set(pathname, schema.default);
            }

            const middlewarePath = path.join(path.dirname(routePath as string), "middleware.ts");
            if (await Bun.file(middlewarePath).exists()) {
                const middleware = await reimportModule(middlewarePath);
                if (middleware.default) middlewares.set(pathname, middleware.default);
            }
        } catch (e) { 
            console.error(`❌ Error loading module for route ${pathname}:`, e);
        }
    }

    console.log("✅ All modules loaded.");

    return {
        port: config.port,
        async fetch(req: Request) {
            if (req.method === "OPTIONS") {
                return new Response(null, {
                    status: 204,
                    headers: {
                        "Access-Control-Allow-Origin": config.origin,
                        "Access-Control-Allow-Methods": "OPTIONS, GET, POST, PUT, PATCH, DELETE",
                        "Access-Control-Allow-Headers": "Content-Type, Authorization",
                        "Access-Control-Max-Age": "86400",
                    },
                });
            }
            const url = new URL(req.url);
            const routeMatch = router.match(url.href);

            if (!routeMatch) {
                return new Response("404 Not Found", { status: 404 });
            }

            const routeHandler = routeHandlers.get(routeMatch.name);
            const middleware = middlewares.get(routeMatch.name);
            const schema = schemas.get(routeMatch.name);

            if (!routeHandler) {
                return new Response(`Route handler for ${routeMatch.name} not found.`, { status: 404 });
            }

            try {
                const context = await buildRequestContext(req, req.headers);
                context.metadata.params = routeMatch.params;
                context.metadata.query = routeMatch.query;
                context.metadata.headers = Object.fromEntries(req.headers.entries());

                if (context.principal.isAuthenticated) {

                }
                if (middleware) {
                    const result = await middleware(context);
                    if (result instanceof Response) return result;
                    if (result === false) return new Response("Forbidden", { status: 403 });
                }

                if (schema) {
                    const validation = {
                        body: schema.body?.safeParse(context.metadata.json),
                        query: schema.query?.safeParse(context.metadata.query),
                        headers: schema.headers?.safeParse(context.metadata.headers),
                    };
                    for (const key of ["body", "query", "headers"] as const) {
                        if (validation[key] && !validation[key]?.success) {
                            return new Response(JSON.stringify({ success: false, error: validation[key]?.error.flatten() }), { status: 400, headers: { "Content-Type": "application/json" } });
                        }
                    }
                }

                return await routeHandler(context, db);
            } catch (err) {
                console.error(`❌ Error handling ${url.pathname}:`, err);
                return new Response("Internal Server Error", { status: 500 });
            }
        },
        error(error) {
            console.error("☠️ Uncaught Error:", error);
            return new Response("Something went wrong!", { status: 500 });
        },
    };
}

// --- Debounced File Watcher ---
let reloadTimeout: Timer | null = null;
function watchFiles() {
    const watchDirs = [
        path.join(process.cwd(), "routes"),
        path.join(process.cwd(), "schemas")
    ];

    const triggerReload = (changeType: string, filename: string | null) => {
        if (!filename) return;
        if (reloadTimeout) clearTimeout(reloadTimeout);

        reloadTimeout = setTimeout(async () => {
            console.log(`\n🔁 Change detected in ${changeType}: ${filename}.`);
            try {
                const newConfig = await createServeConfig();
                server.reload(newConfig);
                console.log("✅ Server reloaded successfully.");
            } catch (e) {
                console.error("❌ Server reload failed:", e)
            }
        }, 100); // Debounce for 100ms
    };

    for (const dir of watchDirs) {
        watch(dir, { recursive: true }, (changeType, filename) => triggerReload(changeType, filename));
    }

    console.log("👀 Watching for file changes in routes/ and schemas/...");
}

// --- Helper Functions ---
function validateToken(token: string) {
    try {
        return jwt.verify(token, config.JWT_SECRET) as jwt.JwtPayload;
    } catch {
        return null;
    }
}

async function buildRequestContext(req: Request, headers: Headers) {
    const reqJSON = await req.json().catch(() => ({}));

    const hasToken = headers.has("Authorization")
    var isAuthenticated = false;
    if (hasToken) {
        try {
            jwt.verify(token as string, config.JWT_SECRET)
            isAuthenticated = true
        } catch (error) {
            isAuthenticated = false
        }
    }
    const context = {
        principal: { isAuthenticated },
        services: {
            Clover: {
                Tenant_ID: primaryTenantData.id,
                Authorized_Users: primaryTenantData.expand?.Tenant_Groups?.Users || [],
                Register: async (data: any) => {
                    const fetchBody = {
                        Tenant_Id: primaryTenantData.id,
                        Secret: config.Clover_Secret,
                        ...data
                    }

                    if (!data.record.email || !data.record.password || !data.record.username) {
                        return { success: false, error: "Missing email username or password" }
                    }
                    const res = await fetch(`${config.Clover_Server_Url}/auth/signup`, {
                        method: "POST",
                        headers: {
                            "Authorization_Secret": config.Clover_Secret
                        },
                        body: JSON.stringify(fetchBody)
                    })

                    return await res.json()

                },
                Authenticate: async (options) => {
                    const fetchBody = {
                        Tenant_Id: primaryTenantData.id,
                        Secret: config.Clover_Secret,
                        type: options.type,
                    };

                    if (options.type === "passwordAuth") {
                        fetchBody.emailOrUsername = options.emailOrUsername;
                        fetchBody.password = options.password;
                    }

                    if (options.type === "oauth") {
                        fetchBody.code = options.code;
                        fetchBody.redirectUri = options.redirectUri;
                        fetchBody.client_secret = config.Clover_Secret
                        fetchBody.authenticated_id = options.authenticated_id
                    }


                    const authRes = await fetch(`${config.Clover_Server_Url}/oauth/token`, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            Authorization_Secret: config.Clover_Secret,
                            tenantid: config.Clover_Tenant_ID,
                            "User-Agent": headers.get("User-Agent") || "",
                        },
                        body: JSON.stringify(fetchBody),
                    });

                    if (!authRes.ok) { 
                        return {
                            isAuthenticated: false,
                            error: true,
                            message: "Authentication failed",
                        };
                    }

                    const responseJson = await authRes.json();
                    const record = responseJson.AuthenticatedModal;
                    record.clover_assigned_id = primaryTenantData.id;

                    record.token = jwt.sign(
                        {
                            id: record.id,
                            clover_assigned_id: record.clover_assigned_id,
                            Roles: record.Roles,
                            Group: record.clover_group_assigned_To,
                        },
                        config.JWT_SECRET,
                    );

                    record.isAuthenticated = true;

                    return record;
                },
                Verify: async (token) => {
                    try {
                        const payload = jwt.verify(token, config.JWT_SECRET);
                        return {
                            isAuthenticated: true,
                            id: payload.id,
                            clover_group_assigned_To: payload.Group,
                            clover_assigned_id: payload.clover_assigned_id,
                            Roles: payload.Roles,
                            token,
                        };
                    } catch {
                        return { isAuthenticated: false };
                    }
                },
                Roles: Array.isArray(primaryTenantData.Tenant_Roles)
                    ? primaryTenantData.Tenant_Roles
                    : [primaryTenantData.Tenant_Roles],
            },
        },
        metadata: {
            requestID: crypto.randomUUID(),
            timestamp: new Date(),
            params: {},
            query: {},
            json: reqJSON,
            headers : {}
        },
        tenantId: headers.get("tenantid") ?? undefined,
        json: (value: any, status?: number, statusText?:string) => {
            return Response.json(value, {
                ...(status && {status}),
                headers: {
                    "Access-Control-Origin": config.origin,
                    "Access-Control-Allow-Methods": "GET,PATCH,PUT,DELETE",
                    "Access-Control-Allow-Headers": "Content-Type, Authorization"
                }
            })
        },

        html: (value: string, status: number, statusText?: string) => {
            return new Response(value, {
                ...(status && {status}),
                ...(statusText && {statusText}),
                headers:{
                    "Content-Type": "text/html",
                    "Access-Control-Origin": config.origin,
                    "Access-Control-Allow-Methods": "GET,PATCH,PUT,DELETE",
                    "Access-Control-Allow-Headers": "Content-Type, Authorization"
                }
            })
        }
    };

    const authHeader = headers.get("authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.split(" ")[1] : null;

    if (token) {
        context.principal = await context.services.Clover.Verify(token);
    }

    return context;
}

 
// --- Initial Server Start --- 
server = Bun.serve(await createServeConfig());
console.log(`🚀 Hapta listening at http://localhost:${server.port}`);
watchFiles();
const Hapta = {
    DatabaseService,
    Context
};
 
export default Hapta;
