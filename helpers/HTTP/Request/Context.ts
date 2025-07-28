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

type OtpAuthOptions = {
    type: 'otp';
    email: string;
    otpCode: string;
};

// Create a union of all possible authentication methods
type AuthOptions = PasswordAuthOptions | MfaAuthOptions | OtpAuthOptions;

// Define the final function type
// (Assuming it returns a Promise with the Principal type from our previous discussions)
type AuthenticateFn = (options: AuthOptions) => Promise<Principal>;
type TokenOptions = {
  payload: {
     id: string, 
  },
  iat: number
} 
export type ServiceConfigs = {
  Clover: {
    /**
     * Organizations Tenant ID
     */
    Tenant_ID: string 
    Roles?: {name: string, security_level: Number}[]
    Authorized_Users: string[],
    Authenticate: AuthenticateFn, 
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
  headers:  Headers;
  query:{},
  params: {}
};

// ---

/**
 * The main application context, redesigned for clarity.
 */
export default interface Context {
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
}