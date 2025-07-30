import { config } from "../../../src/core/config";
const corsHeaders = {
  "Access-Control-Allow-Origin": config.origin,
  "Access-Control-Allow-Methods": "OPTIONS, GET, POST, PUT, PATCH, DELETE",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

/**
 * A discriminated union to safely represent the authenticated actor.
 * The state is either fully authenticated or explicitly not.
 */

export type AuthenticatedPrincipal = {
  isAuthenticated: true;
  id: string; // The unique ID of the actor from Clover
  token: string; // The auth token used for this context
  Roles: string[];
  username: string,
  avatar: string,
  
  /**
   * @description used to determine the highest rated security clearance a user has this helps identify users with low security levels.
   */
  highest_clearance: number,
  createdAt: Date;
  /**
   * Assigned to allows devs to see which group the user is assigned to and which clover instance id they are authenticated in
   */
  clover_group_assigned_To: string
  clover_assigned_id: string,

};

export type UnauthenticatedPrincipal = {
  isAuthenticated: false;
};

export type Principal = AuthenticatedPrincipal | UnauthenticatedPrincipal;

// ---

type PasswordAuthOptions = {
    type: 'passwordAuth';
    emailOrUsername: string;
    password: string;
};

type MfaAuthOptions = {
    type: 'mfa';
    userId: string; // MFA usually follows a login, so you'd have a user ID
    mfaCode: string;
};

type OAuthAuthOptions = {
  type: 'oauth';
  code: string;
  redirectUri: string | null;
  authenticated_id: string;
  accessToken?: string; // token received from Clover OAuth flow
};


type OtpAuthOptions = {
    type: 'otp';
    email: string;
    otpCode: string;
};

// Create a union of all possible authentication methods
type AuthOptions = PasswordAuthOptions | MfaAuthOptions | OtpAuthOptions | OAuthAuthOptions;

// Define the final function type
// (Assuming it returns a Promise with the Principal type from our previous discussions)
type AuthenticateFn = (options: AuthOptions) => Promise<Principal>;
type RegisterFn = (data: any ) => Promise<boolean>
type TokenOptions = {
  payload: {
     id: string, 
  },
  iat: number
} 
type VerifyFn = (token: string) => Promise<Principal>;
 
export type ServiceConfigs = {
  Clover: {
    Tenant_ID: string;
    Roles?: { name: string; security_level: number }[];
    Authorized_Users: string[];
    Authenticate: AuthenticateFn; 
    Register: RegisterFn;
    Verify?: VerifyFn;            // just verify token
  };
};

// ---

/**
 * Metadata for logging, tracing, and auditing.
 * Key fields are now required for better traceability.
 */
export type RequestMetadata = {
  requestID: string;
  timestamp: Date;
  ipAddress?: string;
  userAgent?: string;
  body: any,
  json: {},
  headers:  Headers | {};
  query:{},
  params: {}
};

// ---

/**
 * The main application context, redesigned for clarity.
 */
interface IContext {
  /**
   * The authenticated user or system actor for this request,
   * populated by the Clover authentication backend.
   */
  principal: Principal;

  /**
   * Configurations for downstream services.
   */
  services: ServiceConfigs;

  /**
   * Optional tenant or organization context.
   */
  tenantId?: string | undefined | null;

  /**
   * Metadata about the incoming request.
   * @prop headers
   * @prop requestID
   * @prop timestamp
   * @prop ipAddress
   * @prop userAgent
   * @prop body
   * @prop json 
   */
  metadata: RequestMetadata;
  json: (value: any, status?: number, statusText?:string) => Response
  html: (value: string, status?: number, statusText?:string) => Response
  text: (value: string, status?: number, statusText?:string) => Response
}
 
export default class Context implements IContext {
  public principal: Principal;
  public services: ServiceConfigs;
  public tenantId?: string;
  public metadata: RequestMetadata;

  constructor() {
    // Initialize with default/empty values
    this.principal = { isAuthenticated: false };
    this.services = {} as ServiceConfigs; // Cast as empty, to be populated by the builder
    this.metadata = {
      requestID: '',
      timestamp: new Date(),
      json: {},
      headers: {},
      query: {},
      params: {}
    };
  }

  /**
   * Helper method to create a JSON response.
   */
  json(value: any, status: number = 200): Response {
    return Response.json(value, {
      status,
      headers: {
        "Content-Type": "application/json", 
        ...corsHeaders
      }
    });
  }

  /**
   * Helper method to create an HTML response.
   */
  html(value: string, status: number = 200): Response {
    return new Response(value, {
      status,
      headers: {
        "Content-Type": "text/html", 
        ...corsHeaders
      }
    });
  }

  /**
   * Helper method to create a plain text response.
   */
  text(value: string, status: number = 200): Response {
    return new Response(value, {
      status,
      headers: {
        "Content-Type": "text/plain",
        ...corsHeaders
      }
    });
  }
}
