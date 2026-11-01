import { create } from 'zustand'

/** A Connect/Reconnect that failed because the server certificate is not trusted. */
export interface CertTrustRequest {
  profileId: string;
  /** What to retry once the certificate is trusted. */
  action: 'connect' | 'reconnect';
}

interface CertTrustState {
  request: CertTrustRequest | null;
  open: (request: CertTrustRequest) => void;
  close: () => void;
}

/** Drives CertificateTrustPrompt (mounted once in App). */
export const useCertTrustStore = create<CertTrustState>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));
