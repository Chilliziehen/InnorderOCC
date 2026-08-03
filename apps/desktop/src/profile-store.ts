import {
  parseServerProfile,
  serverProfileSchema,
  type ProfileInput,
  type ServerProfile,
} from "./desktop-contract";
import { z } from "zod";

const persistedProfilesSchema = z
  .object({
    profiles: z.array(serverProfileSchema),
    selectedId: z.uuid().nullable(),
  })
  .strict()
  .refine(
    ({ profiles }) =>
      new Set(profiles.map(({ id }) => id)).size === profiles.length,
    { message: "Profile ids must be unique" },
  )
  .refine(
    ({ profiles, selectedId }) =>
      selectedId === null || profiles.some(({ id }) => id === selectedId),
    { message: "Selected profile does not exist" },
  );

interface ProfileStoreDependencies {
  read(): Promise<unknown>;
  write(value: unknown): Promise<void>;
  packaged: boolean;
  allowDevelopmentHttp?: boolean;
  synchronizeCertificateReferences?(
    profiles: ServerProfile[],
    selectedId: string | null,
  ): Promise<void>;
}

export interface ProfileStore {
  list(): Promise<ServerProfile[]>;
  validate(input: ProfileInput): ServerProfile;
  save(input: ProfileInput): Promise<ServerProfile>;
  select(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  selected(): ServerProfile | undefined;
}

function copyProfile(profile: ServerProfile): ServerProfile {
  return { ...profile };
}

export async function createProfileStore({
  read,
  write,
  packaged,
  allowDevelopmentHttp = false,
  synchronizeCertificateReferences = async () => undefined,
}: ProfileStoreDependencies): Promise<ProfileStore> {
  const loaded = persistedProfilesSchema.safeParse(await read());
  let profiles: ServerProfile[] = [];
  let selectedId: string | null = null;
  let mutationQueue = Promise.resolve();

  if (loaded.success) {
    try {
      profiles = loaded.data.profiles.map((profile) =>
        parseServerProfile(profile, packaged, allowDevelopmentHttp),
      );
      selectedId = loaded.data.selectedId;
    } catch {
      profiles = [];
    }
  }

  await synchronizeCertificateReferences(profiles.map(copyProfile), selectedId);

  const persist = (
    candidateProfiles: ServerProfile[],
    candidateSelectedId: string | null,
  ) =>
    write({
      profiles: candidateProfiles.map(copyProfile),
      selectedId: candidateSelectedId,
    });

  const synchronize = (
    candidateProfiles: ServerProfile[],
    candidateSelectedId: string | null,
  ) => synchronizeCertificateReferences(candidateProfiles.map(copyProfile), candidateSelectedId);

  const safeUnion = (candidateProfiles: ServerProfile[]): ServerProfile[] => {
    const references = new Map<string, ServerProfile>();
    for (const profile of [...profiles, ...candidateProfiles]) {
      references.set(`${profile.id}:${profile.caFingerprint ?? ""}`, profile);
    }
    return [...references.values()];
  };

  const enqueueMutation = <T>(mutation: () => Promise<T>): Promise<T> => {
    const result = mutationQueue.then(mutation);
    mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    async list() {
      return profiles.map(copyProfile);
    },

    validate(input) {
      return parseServerProfile(input, packaged, allowDevelopmentHttp);
    },

    async save(input) {
      const profile = parseServerProfile(input, packaged, allowDevelopmentHttp);
      const isUpdate = input.id !== undefined;
      return enqueueMutation(async () => {
        const existingIndex = isUpdate
          ? profiles.findIndex(({ id }) => id === profile.id)
          : -1;

        if (isUpdate && existingIndex === -1) {
          throw new Error(`Unknown profile: ${profile.id}`);
        }
        const candidateProfiles = [...profiles];
        if (existingIndex === -1) {
          candidateProfiles.push(profile);
        } else {
          candidateProfiles[existingIndex] = profile;
        }
        await synchronize(safeUnion(candidateProfiles), selectedId);
        await persist(candidateProfiles, selectedId);
        await synchronize(candidateProfiles, selectedId);
        profiles = candidateProfiles;
        return copyProfile(profile);
      });
    },

    async select(id) {
      return enqueueMutation(async () => {
        if (!profiles.some((profile) => profile.id === id)) {
          throw new Error(`Unknown profile: ${id}`);
        }
        await persist(profiles, id);
        await synchronize(profiles, id);
        selectedId = id;
      });
    },

    async remove(id) {
      return enqueueMutation(async () => {
        const candidateProfiles = profiles.filter((profile) => profile.id !== id);
        const candidateSelectedId = selectedId === id ? null : selectedId;
        await persist(candidateProfiles, candidateSelectedId);
        await synchronize(candidateProfiles, candidateSelectedId);
        profiles = candidateProfiles;
        selectedId = candidateSelectedId;
      });
    },

    selected() {
      const selected = profiles.find(({ id }) => id === selectedId);
      return selected && copyProfile(selected);
    },
  };
}
