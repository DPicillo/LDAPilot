import { useCallback, useState } from 'react'
import * as wails from '../../lib/wails'
import { OpenBinaryFile, SaveBinaryValue } from '../../lib/wails-binary'
import { attributeChange, valuesWithUpload, type UploadTarget } from '../../lib/entryChanges'
import { formatByteSize } from '../../lib/binary'
import type { BinaryFile } from '../../types/binary'
import { toast } from '../ui/Toast'

export function errorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'string' && err) return err;
  if (err && typeof err === 'object' && 'message' in err && typeof (err as Error).message === 'string') {
    return (err as Error).message || fallback;
  }
  return fallback;
}

/** "photo.jpg, 12.3 KiB, 96×96 px (converted from PEM to DER)" */
export function describeUploadedFile(file: BinaryFile): string {
  const parts = [file.name, formatByteSize(file.size)];
  if (file.width && file.height) parts.push(`${file.width}×${file.height} px`);
  return parts.join(', ') + (file.note ? ` (${file.note})` : '');
}

/**
 * Save/upload/remove actions for binary attribute values of one entry. Writes
 * go through EditorService.ModifyEntry with binary: true (read-only enforced
 * and audited in the backend); unchanged values are never sent.
 */
export function useBinaryActions(profileId: string | undefined, dn: string | undefined, onChanged?: () => void) {
  const [busy, setBusy] = useState(false);

  const download = useCallback(async (attrName: string, value: string) => {
    try {
      const path = await SaveBinaryValue(dn || '', attrName, value);
      if (path) toast.success(`${attrName} saved to ${path}`);
    } catch (err) {
      toast.error(`Failed to save ${attrName}`, errorMessage(err, 'Unknown error'));
    }
  }, [dn]);

  /**
   * Uploads a file into attrName; `current` are its binary (base64) values,
   * [] if it has none. Resolves to true once the value was written, false if
   * the dialog was cancelled, nothing changed or the write failed.
   */
  const upload = useCallback(async (attrName: string, current: readonly string[], target: UploadTarget): Promise<boolean> => {
    if (!profileId || !dn) return false;
    setBusy(true);
    try {
      const file = await OpenBinaryFile(profileId, attrName);
      if (!file) return false; // cancelled
      const change = attributeChange(attrName, current, valuesWithUpload(current, target, file.data), true);
      if (!change) {
        toast.info(`${attrName} already holds this file`);
        return false;
      }
      await wails.ModifyEntry(profileId, dn, [change]);
      toast.success(`${attrName} ${target.type === 'replace' ? 'replaced' : 'uploaded'}: ${describeUploadedFile(file)}`);
      onChanged?.();
      return true;
    } catch (err) {
      toast.error(`Failed to upload ${attrName}`, errorMessage(err, 'Unknown error'));
      return false;
    } finally {
      setBusy(false);
    }
  }, [profileId, dn, onChanged]);

  const removeValue = useCallback(async (attrName: string, current: readonly string[], index: number) => {
    if (!profileId || !dn) return;
    setBusy(true);
    try {
      const change = attributeChange(attrName, current, current.filter((_, i) => i !== index), true);
      if (!change) return;
      await wails.ModifyEntry(profileId, dn, [change]);
      toast.success(current.length > 1 ? `Removed value ${index + 1} of ${attrName}` : `Removed ${attrName}`);
      onChanged?.();
    } catch (err) {
      toast.error(`Failed to remove ${attrName} value`, errorMessage(err, 'Unknown error'));
    } finally {
      setBusy(false);
    }
  }, [profileId, dn, onChanged]);

  return { busy, download, upload, removeValue };
}
