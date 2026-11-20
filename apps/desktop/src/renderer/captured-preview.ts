import type { DocumentAuthority, VersionPreview } from "@rewind/contracts";

export function currentPreview(
  preview: VersionPreview | null,
  authority: DocumentAuthority | undefined,
): preview is VersionPreview {
  return Boolean(
    preview &&
    authority &&
    preview.authority.generation === authority.generation &&
    preview.authority.revision === authority.revision,
  );
}
