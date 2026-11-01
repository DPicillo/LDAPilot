/**
 * Wails wrappers for binary attribute support (services/binary_service.go).
 * Writing uploaded values goes through wails.ModifyEntry with binary: true.
 */
import { getBinding } from './wails';
import type { BinaryFile, CertificateSummary, PKCS7Summary } from '../types/binary';

/** Summarizes a certificate value (base64 DER as delivered for binary attributes; PEM text works too). */
export async function DescribeCertificate(value: string): Promise<CertificateSummary> {
  const svc = getBinding('EditorService');
  if (svc?.DescribeCertificate) return svc.DescribeCertificate(value);
  throw new Error('Not running under Wails - cannot parse certificates');
}

/** Summarizes PKCS #7 SignedData such as a userSMIMECertificate value (base64 BER/DER; PEM text works too). */
export async function DescribePKCS7(value: string): Promise<PKCS7Summary> {
  const svc = getBinding('EditorService');
  if (svc?.DescribePKCS7) return svc.DescribePKCS7(value);
  throw new Error('Not running under Wails - cannot parse PKCS #7 data');
}

/**
 * Opens a file dialog and returns the chosen file prepared for the attribute
 * (format validated, PEM certificates converted to DER, PEM PKCS #7 decoded), or null if the user
 * cancelled. Rejects on read-only connections before the dialog opens.
 */
export async function OpenBinaryFile(profileID: string, attribute: string): Promise<BinaryFile | null> {
  const svc = getBinding('ExportService');
  if (svc?.OpenBinaryFile) return svc.OpenBinaryFile(profileID, attribute);
  throw new Error('Not running under Wails - cannot open files');
}

/**
 * Opens a save dialog (default name derived from the entry, attribute and
 * content) and writes the base64 value as raw bytes. Resolves to the written
 * path, or '' if the user cancelled.
 */
export async function SaveBinaryValue(dn: string, attribute: string, value: string): Promise<string> {
  const svc = getBinding('ExportService');
  if (svc?.SaveBinaryValue) return svc.SaveBinaryValue(dn, attribute, value);
  throw new Error('Not running under Wails - cannot save files');
}

/**
 * Which of the attributes the entry has (names only, no values are read; not
 * written to the operation log): the menus' presence check for Download
 * Photo / Certificate.
 */
export async function AttributesPresent(profileID: string, dn: string, attributes: string[]): Promise<string[]> {
  const svc = getBinding('BrowserService');
  if (svc?.AttributesPresent) return (await svc.AttributesPresent(profileID, dn, attributes)) ?? [];
  throw new Error('Not running under Wails - cannot read the entry');
}

/**
 * Login attribute names (uid, userPassword, …) per DN: types-only base reads,
 * not logged (M-06: contact or user). DNs that could not be read are missing.
 */
export async function LoginAttributesOf(profileID: string, dns: string[]): Promise<Record<string, string[]>> {
  const svc = getBinding('BrowserService');
  if (svc?.LoginAttributesOf) return (await svc.LoginAttributesOf(profileID, dns)) ?? {};
  throw new Error('Not running under Wails - cannot read the entries');
}
