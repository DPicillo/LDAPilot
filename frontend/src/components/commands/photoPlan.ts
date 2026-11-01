/**
 * Upload Photo… (pure parts, tests/cmd.photo.test.ts): which attributes get
 * the picture, the checks before writing, and the one ModifyEntry change set.
 *
 * AD clients (Outlook, Teams, the GAL) read thumbnailPhoto (at most 100 KiB);
 * jpegPhoto is updated too when asked (default: when the entry already has
 * one, so the two never disagree). inetOrgPerson directories use jpegPhoto.
 * Existing binary attributes are always replaced (never value-level
 * add/delete: OpenLDAP has no equality rule for jpegPhoto).
 */
import type { AttributeChange } from '../../types/ldap'
import { attributeChange, valuesWithUpload } from '../../lib/entryChanges.ts'
import { base64ByteLength, base64ToBytes, formatByteSize, sniffImageMime } from '../../lib/binary.ts'

export const THUMBNAIL_MAX_BYTES = 100 * 1024

export type PhotoValues = Record<string, string[]>

/** The attribute OpenBinaryFile prepares the file for (its size cap and format check). */
export function primaryPhotoAttribute(serverType: string | null | undefined): 'thumbnailPhoto' | 'jpegPhoto' {
  return serverType === 'ad' ? 'thumbnailPhoto' : 'jpegPhoto'
}

/** Values of an attribute, case-insensitive. */
export function valuesOf(values: PhotoValues, name: string): string[] {
  const k = Object.keys(values).find((x) => x.toLowerCase() === name.toLowerCase())
  return k ? values[k] : []
}

/** Default of "Also update jpegPhoto" (AD): on when the entry has a jpegPhoto. */
export function defaultAlsoJpeg(values: PhotoValues): boolean {
  return valuesOf(values, 'jpegPhoto').length > 0
}

export function photoTargets(serverType: string | null | undefined, alsoJpeg: boolean): string[] {
  return serverType === 'ad' ? (alsoJpeg ? ['thumbnailPhoto', 'jpegPhoto'] : ['thumbnailPhoto']) : ['jpegPhoto']
}

export interface PhotoCheck {
  /** Block the upload. */
  problems: string[]
  /** Shown, not blocking. */
  warnings: string[]
}

/** Type and size checks of a chosen file (base64) for the target attributes. */
export function checkPhotoFile(data: string, targets: readonly string[]): PhotoCheck {
  const problems: string[] = []
  const warnings: string[] = []
  const size = base64ByteLength(data)
  const mime = sniffImageMime(base64ToBytes(data, 16))
  if (!size) problems.push('The file is empty.')
  else if (!mime) problems.push('The file is not a JPEG, PNG or GIF image.')
  if (targets.some((t) => t.toLowerCase() === 'thumbnailphoto') && size > THUMBNAIL_MAX_BYTES) {
    problems.push(`thumbnailPhoto takes at most ${formatByteSize(THUMBNAIL_MAX_BYTES)}; this file has ${formatByteSize(size)}.`)
  }
  if (mime && mime !== 'image/jpeg' && targets.some((t) => t.toLowerCase() === 'jpegphoto')) {
    warnings.push('jpegPhoto is meant for JPEG images; some clients will not show this file.')
  }
  return { problems, warnings }
}

/**
 * The changes of one ModifyEntry: each target's value at `replaceIndex[target]`
 * (default the first; the dialog asks when there are several, DEF-13)
 * replaced, or added when the target has none.
 */
export function planPhotoChanges(targets: readonly string[], current: PhotoValues, data: string, replaceIndex: Record<string, number> = {}): AttributeChange[] {
  const out: AttributeChange[] = []
  for (const t of targets) {
    const cur = valuesOf(current, t)
    const index = replaceIndex[t] ?? 0
    const change = attributeChange(t, cur, valuesWithUpload(cur, { type: 'replace', index }, data), true)
    if (change) out.push(change)
  }
  return out
}
