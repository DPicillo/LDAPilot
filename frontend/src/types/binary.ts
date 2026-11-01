/** Mirrors internal/models/binary.go. */

/**
 * Summary of one X.509 certificate (EditorService.DescribeCertificate).
 * Times are RFC 3339 UTC; serial number, key IDs and fingerprints are
 * upper-case hex bytes separated by colons.
 */
export interface CertificateSummary {
  subject: string;
  issuer: string;
  serialNumber: string;
  notBefore: string;
  notAfter: string;
  version: number;
  signatureAlgorithm: string;
  publicKeyAlgorithm: string;
  publicKeyBits: number;
  isCA: boolean;
  selfSigned: boolean;
  dnsNames: string[];
  emailAddresses: string[];
  ipAddresses: string[];
  uris: string[];
  /** Microsoft UPN otherName SAN entries (smart card logon). */
  upns: string[];
  keyUsage: string[];
  extKeyUsage: string[];
  subjectKeyId: string;
  authorityKeyId: string;
  sha1Fingerprint: string;
  sha256Fingerprint: string;
  /** DER size in bytes. */
  size: number;
  /** Base64 of the DER encoding (e.g. "Copy as PEM" of a certificate inside PKCS #7 data). */
  der: string;
  /**
   * Every subjectAltName entry in certificate order: type 'DNS' | 'Email' |
   * 'IP' | 'URI' | 'UPN' | 'DirName' | 'RegisteredID' | 'otherName <OID>' |
   * 'X400' | 'EDIParty'. Optional: older backends only fill the flat lists.
   */
  altNames?: CertificateAltName[];
  keyUsageCritical?: boolean;
  extKeyUsageCritical?: boolean;
  /** Dotted OIDs of extKeyUsage, same order. */
  extKeyUsageOids?: string[];
  /** CA path length constraint; -1 = none / no CA. */
  maxPathLen?: number;
  /** AD CS certificate template: v1 name ("User") or "<OID> v<major>.<minor>". */
  template?: string;
  /** Account SID of the AD CS strong mapping extension (KB5014754). */
  sid?: string;
  crlDistributionPoints?: string[];
  ocspServers?: string[];
  issuingCertificateUrls?: string[];
  policyOids?: string[];
}

/** One subjectAltName entry (Go models.CertificateAltName). */
export interface CertificateAltName {
  type: string;
  value: string;
}

/**
 * Summary of PKCS #7 (CMS) SignedData such as a userSMIMECertificate value
 * (EditorService.DescribePKCS7).
 */
export interface PKCS7Summary {
  /** Always 'signedData'. */
  contentType: string;
  version: number;
  /** Dotted OID of the signed content, e.g. '1.2.840.113549.1.7.1' (data). */
  encapsulatedContentType: string;
  /** True if the signed content is not included. */
  detached: boolean;
  /** Embedded X.509 certificates in stored order. */
  certificates: CertificateSummary[];
  /** Embedded certificates that are not readable X.509 certificates. */
  otherCertificates: number;
  crlCount: number;
  signerCount: number;
  /** Encoded size in bytes. */
  size: number;
}

/** A local file prepared for upload into a binary attribute (ExportService.OpenBinaryFile). */
export interface BinaryFile {
  /** Base name of the file. */
  name: string;
  /** Bytes in data (after a PEM to DER conversion). */
  size: number;
  /** Base64 of the bytes to store (binary contract). */
  data: string;
  /** Detected content: 'jpeg' | 'png' | 'gif' | 'x509' | 'pkcs7' | '' (unknown). */
  format: string;
  /** Image dimensions in pixels, 0 if not an image. */
  width: number;
  height: number;
  /** Conversion applied, e.g. "converted from PEM to DER". */
  note: string;
}
