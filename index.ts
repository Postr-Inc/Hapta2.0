import Context, { AuthenticatedPrincipal } from "./helpers/HTTP/Request/Context";
import { serve, FileSystemRouter, type Serve } from "bun";
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

// --- FileSystem Router Setup ---
const router = new FileSystemRouter({
  style: "nextjs",
  dir: path.join(process.cwd(), "routes"),
});

try {
  await pb.collection("_superusers").authWithPassword(config.ADMIN_EMAIL, config.ADMIN_PASSWORD);
} catch (_) {}

const primaryTenantData = await fetch(`${config.Clover_Server_Url}/tenants/${config.Clover_Tenant_ID}`, {
  headers: { Authorization_Secret: config.Clover_Secret },
}).then(async (res) => {
  if (!res.ok) throw new Error(`Failed to fetch primary tenant data: ${res.status} ${res.statusText}`);
  return res.json();
});

console.log("✅ Primary tenant data loaded.");

const routeHandlers = new Map<string, (ctx: Context, db: DatabaseService) => Promise<Response>>();
const schemas = new Map();
const middlewares = new Map<string, (ctx: Context) => Promise<Response | boolean>>();

const routeVersions = new Map<string, number>();
function bustModulePath(modulePath: string, key: string): string {
  const version = (routeVersions.get(key) ?? 0) + 1;
  routeVersions.set(key, version);
  return `${pathToFileURL(modulePath).href}?t=${version}`;
}

async function loadRoutes() {
  for (const [pathname, routePath] of Object.entries(router.routes)) {
    const routeModule = await import(bustModulePath(routePath as string, pathname));

    const schemaPath = path.join(process.cwd(), "schemas", pathname, "index.ts");
    const middlewarePath = path.join(process.cwd(), "routes", pathname, "middleware.ts");

    if (!routeModule.default) {
      console.error(`❌ Route must export default handler: ${routePath}`);
      process.exit(1);
    }

    if (await Bun.file(schemaPath).exists()) {
      const schema = await import(bustModulePath(schemaPath, pathname + "-schema"));
      if (!schema.default) {
        console.error(`❌ Schema must export default: ${schemaPath}`);
        process.exit(1);
      }
      schemas.set(pathname, schema.default);
    }

    if (await Bun.file(middlewarePath).exists()) {
      const middleware = await import(bustModulePath(middlewarePath, pathname + "-middleware"));
      if (!middleware.default) {
        console.error(`❌ Middleware must export default: ${middlewarePath}`);
        process.exit(1);
      }
      middlewares.set(pathname, middleware.default);
    }

    routeHandlers.set(pathname, routeModule.default);
  }

  console.log("✅ All route handlers loaded.");
}

await loadRoutes();

function watchRoutes() {
  const routesDir = path.join(process.cwd(), "routes");
  const schemasDir = path.join(process.cwd(), "schemas");

  watch(routesDir, { recursive: true }, async (_, filename) => {
    if (!filename || !filename.endsWith(".ts")) return;

    const routeName = filename.split("/")[0];
    const routePath = path.join(routesDir, filename);

    try {
      const module = await import(bustModulePath(routePath, routeName));
      if (module.default) routeHandlers.set(routeName, module.default);

      const middlewarePath = path.join(routesDir, routeName, "middleware.ts");
      if (await Bun.file(middlewarePath).exists()) {
        const mw = await import(bustModulePath(middlewarePath, routeName + "-middleware"));
        if (mw.default) middlewares.set(routeName, mw.default);
      }

      console.log(`🔁 Reloaded route/middleware: ${routeName}`);
    } catch (e) {
      console.error(`❌ Error reloading ${routeName}:`, e);
    }
  });

  watch(schemasDir, { recursive: true }, async (_, filename) => {
    if (!filename.endsWith("index.ts")) return;
    const routeName = filename.split("/")[0];
    const schemaPath = path.join(schemasDir, routeName, "index.ts");

    try {
      const schema = await import(bustModulePath(schemaPath, routeName + "-schema"));
      if (schema.default) schemas.set(routeName, schema.default);
      console.log(`✅ Reloaded schema: ${routeName}`);
    } catch (e) {
      console.error(`❌ Failed to reload schema for ${routeName}`, e);
    }
  });

  console.log("👀 Watching routes and schemas...");
}

watchRoutes();

const requestLogs: { context: Context; url: string }[] = [];
const cache = new Cache();
const db = new DatabaseService(pb, cache);

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

  context.services.Clover.Roles = Array.isArray(primaryTenantData.Tenant_Roles)
    ? primaryTenantData.Tenant_Roles
    : [primaryTenantData.Tenant_Roles];

  return context;
}

// --- Server Start ---
const serverOptions: Serve = {
  port: config.port,
  async fetch(req: Request) {
    const url = new URL(req.url);
    router.reload();
    const routeMatch = router.match(url.href);
    const routeHandler = routeMatch ? routeHandlers.get(routeMatch.name) : undefined;
    const middleware = routeMatch ? middlewares.get(routeMatch.name) : undefined;

    if (!routeHandler) return new Response("404 Not Found", { status: 404 });

    if (req.method.toLowerCase() !== routeHandler.name.toLowerCase()) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Method ${req.method} not allowed for ${routeHandler.name}`,
        }),
        { status: 405, headers: { "Content-Type": "application/json" } },
      );
    }

    try {
      const context = await buildRequestContext(req, req.headers);
      context.metadata.params = routeMatch.params;
      context.metadata.query = routeMatch.query;
      context.metadata.headers = Object.fromEntries(req.headers.entries());

      requestLogs.push({ url: routeMatch.name, context });
      if (requestLogs.length > 1000) requestLogs.shift();

      // Run middleware
      if (middleware) {
        const result = await middleware(context);
        if (result instanceof Response) return result;
        if (result === false) return new Response("Forbidden", { status: 403 });
      }

      // Run schema validation
      const schema = schemas.get(routeMatch.name);
      if (schema) {
        const validation = {
          body: schema.body?.safeParse(context.metadata.json),
          query: schema.query?.safeParse(context.metadata.query),
          headers: schema.headers?.safeParse(context.metadata.headers),
        };

        for (const key of ["body", "query", "headers"] as const) {
          if (validation[key] && !validation[key]?.success) {
            return new Response(
              JSON.stringify({
                success: false,
                error: validation[key]?.error.flatten(),
              }),
              { status: 400, headers: { "Content-Type": "application/json" } },
            );
          }
        }
      }

      return await routeHandler(context, db);
    } catch (err) {
      console.error(`❌ Error handling ${url.pathname}:`, err);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};

serve(serverOptions);
console.log(`🚀 Hapta listening at http://localhost:${serverOptions.port}`);
