interface OperationDefinition {
  readonly query: readonly [operation: string, capability: string];
  readonly commands: Readonly<Record<string, string>>;
}

const definitions: Readonly<Record<string, OperationDefinition>> = {
  overview: { query: ["overview.query", "overview.query"], commands: {} },
  "my-work": { query: ["tasks.query", "tasks.query"], commands: { claim: "tasks.claim", submitEvidence: "evidence.submit", reserve: "reservations.create", guidance: "recommendations.request" } },
  processes: { query: ["processes.query", "processes.query"], commands: { create: "cohorts.create", start: "processes.start", suspend: "processes.suspend", cancel: "processes.cancel" } },
  interventions: { query: ["interventions.query", "interventions.query"], commands: { accept: "evidence.review", conditional: "evidence.review", reject: "evidence.review", return: "interventions.resolve" } },
  risks: { query: ["risks.query", "risks.query"], commands: { acknowledge: "risks.acknowledge", assign: "risks.assign", mitigate: "risks.mitigate", escalate: "risks.escalate", resolve: "risks.resolve" } },
  resources: { query: ["resources.query", "resources.query"], commands: { create: "resources.create", change: "resources.change", reserve: "reservations.create", cancel: "reservations.cancel" } },
  "domain-design": { query: ["packages.query", "packages.query"], commands: { import: "packages.import", validate: "packages.validate", diff: "packages.diff", approve: "packages.approve", publish: "packages.publish" } },
  administration: { query: ["administration.query", "administration.query"], commands: { create: "people.manage", disable: "people.manage", assignRelationship: "relationships.manage", assign: "roles.manage", release: "policies.manage", test: "providers.manage", ingest: "knowledge.manage", inspect: "audit.query" } },
  system: { query: ["system.status", "occ.read"], commands: {} },
  settings: { query: ["profiles.current", "occ.read"], commands: { "profiles.select": "occ.read", "profiles.save": "occ.read", "profiles.remove": "occ.read", "session.logout": "occ.read", "preferences.update": "preferences.update" } },
};

export interface MainOperationPolicy {
  queryCapability(workspace: string, operation: string): string | undefined;
  commandCapability(workspace: string, operation: string): string | undefined;
  availableCommands(workspace: string): readonly string[];
}

export function createMainOperationPolicy(contractsAvailable: boolean): MainOperationPolicy {
  return {
    queryCapability(workspace, operation) {
      const definition = definitions[workspace];
      return definition?.query[0] === operation ? definition.query[1] : undefined;
    },
    commandCapability(workspace, operation) {
      return definitions[workspace]?.commands[operation];
    },
    availableCommands(workspace) {
      if (!contractsAvailable) return [];
      return Object.keys(definitions[workspace]?.commands ?? {}).filter((operation) => {
        const manifestAvailable = workspace === "settings" && operation !== "preferences.update";
        return !manifestAvailable;
      });
    },
  };
}
