import type { InternalWorkspaceCommand } from "./command-intents";
import type { CommandReceipt, NotificationPage, WorkspaceQuery, WorkspaceResult } from "./desktop-contract";
import type { EvidenceTransport } from "./evidence-upload";
import type { MainOperationPolicy } from "./main-operation-policy";
import type { NotificationConnector } from "./notification-stream";
import type { ProfileCertificateVerifyRequest, ProfileTransportProfile } from "./profile-transport";

export interface RuntimeAdapterDependencies {
  readonly fetch: (input: URL, init?: RequestInit) => Promise<Response>;
  readonly getOrigin: () => string;
  readonly getAccessToken: () => string | null;
}

export interface RuntimeServices {
  readonly workspaceQuery?: (input: WorkspaceQuery) => Promise<WorkspaceResult>;
  readonly executeCommand?: (input: InternalWorkspaceCommand) => Promise<CommandReceipt>;
  readonly notifications?: { list(cursor?: string): Promise<NotificationPage> };
  readonly notificationConnector: NotificationConnector;
  readonly notificationEndpointAvailable: boolean;
  readonly evidenceTransport: EvidenceTransport;
  readonly evidenceEndpointAvailable: boolean;
}

export interface RuntimeBuildAdapter {
  readonly operationPolicy: MainOperationPolicy;
  readonly verifyCertificate?: (profile: ProfileTransportProfile, request: ProfileCertificateVerifyRequest) => boolean;
  createServices(dependencies: RuntimeAdapterDependencies): RuntimeServices;
}
