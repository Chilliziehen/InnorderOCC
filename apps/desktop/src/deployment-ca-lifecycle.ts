import path from "node:path";
import { z } from "zod";

type Input = { argv: string[]; resourcesPath: string; userData: string; execPath: string };
type Invocation = { script: string; mode: "enroll" | "remove"; arguments: string[] };
const confirmationSchema = z.object({
  version: z.literal(1),
  productId: z.literal("com.innorder.occ"),
  deploymentId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
  confirmed: z.literal(true),
  certificateManifestSha256: z.string().regex(/^[0-9A-Fa-f]{64}$/).transform((value) => value.toUpperCase()),
  caFingerprint: z.string().regex(/^[0-9A-Fa-f]{64}$/).transform((value) => value.toUpperCase()),
}).strict();

export async function handleDeploymentCaLifecycle(
  input: Input,
  dependencies: { exists(target: string): Promise<boolean>; read(target: string): Promise<Buffer>; invoke(value: Invocation): Promise<unknown> },
): Promise<{ handled: boolean; status: string }> {
  const event = input.argv.find((value) => value === "--squirrel-install" || value === "--squirrel-updated" || value === "--squirrel-uninstall");
  if (!event) return { handled: false, status: "not-squirrel" };
  const payload = path.join(input.resourcesPath, "deployment-ca");
  const required = ["release-manifest.json", "certificate-manifest.json", "deployment-ca.pem", "deployment-ca.confirmed.json"]
    .map((file) => path.join(payload, file));
  if (!(await Promise.all(required.map(dependencies.exists))).every(Boolean)) return { handled: true, status: "no-payload" };
  const removing = event === "--squirrel-uninstall";
  let confirmation: z.infer<typeof confirmationSchema>;
  try {
    const bytes = await dependencies.read(required[3]!);
    if (bytes.byteLength === 0 || bytes.byteLength > 16 * 1024) throw new Error("Invalid confirmation size");
    confirmation = confirmationSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch {
    return { handled: true, status: "invalid-payload" };
  }
  const script = path.join(input.resourcesPath, removing ? "remove-deployment-ca.ps1" : "enroll-deployment-ca.ps1");
  try {
    await dependencies.invoke({
      script,
      mode: removing ? "remove" : "enroll",
      arguments: removing
        ? ["-StateRoot", path.join(input.userData, "state"), "-DeploymentId", confirmation.deploymentId]
        : ["-PayloadRoot", payload, "-ManifestPath", required[1]!, "-ReleaseManifestPath", required[0]!, "-ExpectedManifestSha256", confirmation.certificateManifestSha256, "-ExpectedFingerprint", confirmation.caFingerprint, "-InstallerPath", input.execPath, "-StateRoot", path.join(input.userData, "state"), "-Mode", "Production", "-InstallerConfirmed"],
    });
    return { handled: true, status: "invoked" };
  } catch {
    return { handled: true, status: "helper-unavailable" };
  }
}
