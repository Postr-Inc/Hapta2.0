import Context, { AuthenticatedPrincipal } from "./helpers/HTTP/Request/Context";
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
import { pathToFileURL } from "url";

// --- Global server instance ---
let server: Server;

// --- Validation: Ensure required config vars are present ---
if (!config.Clover_Secret || !config.Clover_Tenant_ID) {
  console.error("❌ Clover_Secret and Clover_Tenant_ID must be set in your config.");
  process.exit(1);
}

if (!config.ADMIN_EMAIL || !config.ADMIN_PASSWORD) {
  console.error("❌ Please set an admin email and admin password for database authentication");
  process.exit(1);
}

// --- Pocketbase Connection ---
const pb = new Pocketbase(config.DatabaseUrl);
try {
  await pb.collection("_superusers").authWithPassword(config.ADMIN_EMAIL, config.ADMIN_PASSWORD);
} catch (_) {}

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

  const router = new FileSystemRouter({
    style: "nextjs",
    dir: path.join(process.cwd(), "routes"),
  });
  
  const routeHandlers = new Map<string, (ctx: Context, db: DatabaseService) => Promise<Response>>();
  const schemas = new Map();
  const middlewares = new Map<string, (ctx: Context) => Promise<Response | boolean>>();

  const reimportModule = async (modulePath: string) => {
    const resolvedPath = require.resolve(modulePath);
    if (require.cache[resolvedPath]) {
      delete require.cache[resolvedPath];
    }
    return await import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`);
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
        } catch(e) {
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

async function buildRequestContext(req: Request, headers: Headers): Promise<Context> {
  const reqJSON = await req.json().catch(() => ({}));

  const context: Context = {
    principal: { isAuthenticated: false },
    services: {
      Clover: {
        Tenant_ID: primaryTenantData.id,
        Authorized_Users: primaryTenantData.expand?.Tenant_Groups?.Users || [],
        Authenticate: async (options) => {
          const fetchBody: Record<string, any> = {
            Tenant_Id: primaryTenantData.id,
            Secret: config.Clover_Secret,
            type: options.type,
          };

          if (options.type === "passwordAuth") {
            fetchBody.emailOrUsername = options.emailOrUsername;
            fetchBody.password = options.password;
          }

          const authRes = await fetch(`${config.Clover_Server_Url}/authenticate`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization_Secret: config.Clover_Secret,
              tenantid: config.Clover_Tenant_ID,
              "User-Agent": headers.get("User-Agent") as string,
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
          const record: AuthenticatedPrincipal = responseJson.AuthenticatedModal;
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

          return record;
        },
        Roles: Array.isArray(primaryTenantData.Tenant_Roles)
            ? primaryTenantData.Tenant_Roles
            : [primaryTenantData.Tenant_Roles],
      },
    },
    metadata: {
      requestID: crypto.randomUUID(),
      timestamp: new Date(),
      json: reqJSON,
    },
    tenantId: headers.get("tenantid") ?? undefined,
  };

  const authHeader = headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.split(" ")[1] : null;

  if (token) {
    const decoded = validateToken(token);
    if (decoded) {
      context.principal = {
        isAuthenticated: true,
        id: decoded.id,
        clover_group_assigned_To: decoded.Group,
        clover_assigned_id: decoded.clover_assigned_id,
        Roles: decoded.Roles,
        token,
      };
    }
  }

  return context;
}

// --- Initial Server Start ---
server = Bun.serve(await createServeConfig());
console.log(`🚀 Hapta listening at http://localhost:${server.port}`);
watchFiles();
 
