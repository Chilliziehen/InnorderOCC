import path from "node:path";
import { z } from "zod";

type Input = { argv: string[]; resourcesPath: string; userData: string; execPath: string };
type Invocation = { script: string; mode: "enroll" | "remove"; arguments: string[] };
type VerificationInput = {
  payloadRoot: string;
  certificateManifestPath: string;
  releaseManifestPath: string;
  enrollmentHelperPath: string;
  removalHelperPath: string;
  installerPath: string;
  expectedCertificateManifestSha256: string;
  expectedFingerprint: string;
};
type VerifiedRelease = { releaseManifest: { productVersion: string; publisher: { subject: string; thumbprint: string } } };
type PreflightInput = { helperPath: string; installerPath: string; productVersion: string; publisherSubject: string; publisherThumbprint: string };
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
  dependencies: {
    exists(target: string): Promise<boolean>;
    read(target: string): Promise<Buffer>;
    verify(input: VerificationInput): Promise<VerifiedRelease>;
    preflight(input: PreflightInput): Promise<void>;
    invoke(value: Invocation): Promise<unknown>;
  },
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
  const enrollmentHelperPath = path.join(input.resourcesPath, "enroll-deployment-ca.ps1");
  const removalHelperPath = path.join(input.resourcesPath, "remove-deployment-ca.ps1");
  const script = removing ? removalHelperPath : enrollmentHelperPath;
  let verified: VerifiedRelease;
  try {
    verified = await dependencies.verify({
      payloadRoot: payload,
      certificateManifestPath: required[1]!,
      releaseManifestPath: required[0]!,
      enrollmentHelperPath,
      removalHelperPath,
      installerPath: input.execPath,
      expectedCertificateManifestSha256: confirmation.certificateManifestSha256,
      expectedFingerprint: confirmation.caFingerprint,
    });
  } catch {
    return { handled: true, status: "invalid-payload" };
  }
  try {
    await dependencies.preflight({
      helperPath: script,
      installerPath: input.execPath,
      productVersion: verified.releaseManifest.productVersion,
      publisherSubject: verified.releaseManifest.publisher.subject,
      publisherThumbprint: verified.releaseManifest.publisher.thumbprint,
    });
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
