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
    ({ profiles, selectedId }) =>
      selectedId === null || profiles.some(({ id }) => id === selectedId),
    { message: "Selected profile does not exist" },
  );

interface ProfileStoreDependencies {
  read(): Promise<unknown>;
  write(value: unknown): Promise<void>;
  packaged: boolean;
  allowDevelopmentHttp?: boolean;
}

export interface ProfileStore {
  list(): Promise<ServerProfile[]>;
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
}: ProfileStoreDependencies): Promise<ProfileStore> {
  const loaded = persistedProfilesSchema.safeParse(await read());
  let profiles: ServerProfile[] = [];
  let selectedId: string | null = null;

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

  const persist = (
    candidateProfiles: ServerProfile[],
    candidateSelectedId: string | null,
  ) =>
    write({
      profiles: candidateProfiles.map(copyProfile),
      selectedId: candidateSelectedId,
    });

  return {
    async list() {
      return profiles.map(copyProfile);
    },

    async save(input) {
      const profile = parseServerProfile(input, packaged, allowDevelopmentHttp);
      const existingIndex = input.id
        ? profiles.findIndex(({ id }) => id === input.id)
        : -1;

      if (input.id && existingIndex === -1) {
        throw new Error(`Unknown profile: ${input.id}`);
      }
      const candidateProfiles = [...profiles];
      if (existingIndex === -1) {
        candidateProfiles.push(profile);
      } else {
        candidateProfiles[existingIndex] = profile;
      }
      await persist(candidateProfiles, selectedId);
      profiles = candidateProfiles;
      return copyProfile(profile);
    },

    async select(id) {
      if (!profiles.some((profile) => profile.id === id)) {
        throw new Error(`Unknown profile: ${id}`);
      }
      await persist(profiles, id);
      selectedId = id;
    },

    async remove(id) {
      const candidateProfiles = profiles.filter((profile) => profile.id !== id);
      const candidateSelectedId = selectedId === id ? null : selectedId;
      await persist(candidateProfiles, candidateSelectedId);
      profiles = candidateProfiles;
      selectedId = candidateSelectedId;
    },

    selected() {
      const selected = profiles.find(({ id }) => id === selectedId);
      return selected && copyProfile(selected);
    },
  };
}
