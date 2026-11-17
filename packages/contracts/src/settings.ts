import { z } from "zod";
import { idSchema } from "./common";

export const userSettingsSchema = z.strictObject({
  collectionConsent: z.boolean(),
  folderCollectionConsent: z.boolean().default(false),
  browserCollectionConsent: z.boolean().default(false),
  cloudAiEnabled: z.boolean(),
  articleExtractionEnabled: z.boolean(),
  retentionHours: z.number().int().min(1).max(8760),
  storageLimitBytes: z.number().int().positive(),
  excludedApplications: z.array(z.string().min(1).max(255)).max(1000),
  excludedSiteHosts: z.array(z.string().min(1).max(253)).max(1000),
  excludedFolderPaths: z.array(z.string().min(1).max(32767)).max(1000),
  protectedFolderIds: z.array(idSchema).max(100),
});
export type UserSettings = z.infer<typeof userSettingsSchema>;

export function createDefaultSettings(): UserSettings {
  return {
    collectionConsent: false,
    folderCollectionConsent: false,
    browserCollectionConsent: false,
    cloudAiEnabled: false,
    articleExtractionEnabled: false,
    retentionHours: 72,
    storageLimitBytes: 2 * 1024 ** 3,
    excludedApplications: [],
    excludedSiteHosts: [],
    excludedFolderPaths: [],
    protectedFolderIds: [],
  };
}
