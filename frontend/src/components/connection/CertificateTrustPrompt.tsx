import { useEffect, useState } from 'react'
import { Fingerprint, ShieldX } from 'lucide-react'
import type { CertificateProblem } from '../../types/auth'
import { useCertTrustStore, type CertTrustRequest } from '../../stores/certTrustStore'
import { useConnectionStore } from '../../stores/connectionStore'
import { useUIStore } from '../../stores/uiStore'
import * as wailsAuth from '../../lib/wails-auth'
import { appendPEM, certProblemTitle, formatDate, pinDetailText } from '../../lib/connectionAuth'
import { toast } from '../ui/Toast'
import { CertificateChainView } from './CertificateChainView'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import { Spinner } from '../ui/Spinner'
import { InlineAlert } from '../ui/InlineAlert'
import { connectAndBrowse } from './connectFlow';

/**
 * Shown when Connect/Reconnect of a saved profile fails because the server
 * certificate is not trusted: displays the presented chain and offers to pin
 * the server certificate (or trust its CA) in the profile and retry.
 * Mounted once in AppLayout's overlay hosts; opened by connectionStore via
 * useCertTrustStore. A Dialog (Escape and the backdrop close it unless a trust
 * decision is being saved).
 *
 * A profile that had pinned another certificate (problem.pinnedChanged) is
 * NOT a first contact: the prompt says the certificate changed, shows the
 * old and new SHA-256 side by side, and "Trust New Certificate and Connect"
 * stays disabled until "I verified the new certificate" is ticked (a habitual
 * click must not accept a man in the middle). The old pin is removed by
 * default.
 */
export function CertificateTrustPrompt() {
  const request = useCertTrustStore((s) => s.request);
  if (!request) return null;
  return <TrustDialog key={`${request.profileId}:${request.action}`} request={request} />;
}

function TrustDialog({ request }: { request: CertTrustRequest }) {
  const close = useCertTrustStore((s) => s.close);
  const profile = useConnectionStore((s) => s.profiles.find((p) => p.id === request.profileId));
  const [problem, setProblem] = useState<CertificateProblem | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [verified, setVerified] = useState(false);
  const [dropOld, setDropOld] = useState(true);

  useEffect(() => {
    let cancelled = false;
    wailsAuth.GetCertificateProblem(request.profileId)
      .then((p) => { if (!cancelled) setProblem(p); })
      .catch(() => { if (!cancelled) setProblem(null); });
    return () => { cancelled = true; };
  }, [request.profileId]);

  async function retry() {
    const store = useConnectionStore.getState();
    try {
      if (request.action === 'reconnect') {
        await store.reconnect(request.profileId);
      } else {
        // As plain "Create and Connect": the Explorer and focus on the first tree row (RW2-C-03).
        await connectAndBrowse(request.profileId);
      }
    } catch {
      // The store shows the error (or opens this prompt again).
    }
  }

  async function trustLeaf(fingerprint: string, replace = false) {
    setBusy(true);
    try {
      const updated = replace
        ? await wailsAuth.ReplacePinnedCertificates(request.profileId, fingerprint)
        : await wailsAuth.TrustCertificate(request.profileId, fingerprint);
      useConnectionStore.setState((s) => ({
        profiles: s.profiles.map((p) => (p.id === updated.id ? updated : p)),
      }));
      toast.success(`Certificate pinned for "${updated.name}"`, { connection: updated.name });
      close();
      await retry();
    } catch (err: any) {
      toast.error('Could not trust the certificate', err?.message || String(err));
      setBusy(false);
    }
  }

  async function trustCA(pem: string) {
    if (!profile) return;
    setBusy(true);
    try {
      // An empty password keeps the stored one.
      await useConnectionStore.getState().saveProfile({
        ...profile,
        password: '',
        tlsCACertPEM: appendPEM(profile.tlsCACertPEM, pem),
      });
      close();
      await retry();
    } catch {
      // saveProfile shows the error.
      setBusy(false);
    }
  }

  const name = profile?.name || 'server';
  const changed = !!problem?.pinnedChanged;
  const leaf = problem?.chain?.[0];
  const pinnedSince = (problem?.previousPins ?? []).map((p) => p.pinnedAt).filter(Boolean).sort()[0];

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && close()}
      size="md"
      role="alertdialog"
      icon={<ShieldX size={16} strokeWidth={1.75} aria-hidden className="text-destructive" />}
      title={changed ? 'Server certificate changed' : 'Untrusted server certificate'}
      dismissible={busy ? 'never' : 'always'}
      bodyClassName="space-y-3 text-sm"
      footer={
        <>
          {busy && <Spinner size="sm" label="Saving the trust decision" />}
          <Button variant="secondary" onClick={close} disabled={busy}>
            Cancel
          </Button>
          {changed && leaf && (
            <Button variant="primary" leftIcon={Fingerprint} disabled={!verified || busy} onClick={() => void trustLeaf(leaf.sha256, dropOld)}>
              Trust New Certificate and Connect
            </Button>
          )}
        </>
      }
    >
      {problem === undefined && (
        <div className="flex items-center gap-2 text-muted-foreground" role="status">
          <Spinner size="sm" decorative /> Loading certificate…
        </div>
      )}
      {problem === null && (
        <p className="text-muted-foreground">
          The connection to {name} failed because its certificate is not trusted, but the certificate details are no
          longer available. Try to connect again, or use Test Connection in the connection settings.
        </p>
      )}
      {problem && changed && leaf && (
        <>
          <InlineAlert
            tone="danger"
            title="The server presented a different certificate than the one you trusted"
            body={
              <>
                <span className="font-medium">{name}</span> (<span className="font-mono">{problem.host}</span>) no longer presents the pinned
                certificate{pinnedSince ? ` you trusted on ${formatDate(pinnedSince)}` : ''}. This happens when the server gets a new
                certificate, but it is also exactly what an attacker between you and the server looks like. Confirm the new fingerprint
                with the server administrator before trusting it.
              </>
            }
          />
          <table className="w-full text-xs border border-border rounded" aria-label="Pinned and presented certificate fingerprints">
            <tbody>
              {(problem.previousPins ?? []).map((p) => (
                <tr key={p.fingerprint} className="border-b border-border align-top">
                  <th scope="row" className="text-left font-medium text-muted-foreground px-2 py-1 w-36">
                    Trusted (pinned){p.pinnedAt ? <span className="block font-normal">since {formatDate(p.pinnedAt)}</span> : null}
                  </th>
                  <td className="px-2 py-1 select-text">
                    <span className="font-mono break-all">{p.fingerprint}</span>
                    {/* What the old certificate was, when the pin recorded it (DEF-04). */}
                    {pinDetailText(p.subject ? { subject: p.subject, issuer: p.issuer, notAfter: p.notAfter } : undefined) && (
                      <span className="block break-words text-muted-foreground">{pinDetailText({ subject: p.subject!, issuer: p.issuer, notAfter: p.notAfter })}</span>
                    )}
                  </td>
                </tr>
              ))}
              <tr className="align-top">
                <th scope="row" className="text-left font-medium text-destructive px-2 py-1 w-36">Presented now</th>
                <td className="px-2 py-1 select-text text-destructive">
                  <span className="font-mono break-all">{leaf.sha256}</span>
                  <span className="block break-words">{pinDetailText({ subject: leaf.subject, issuer: leaf.issuer, notAfter: leaf.notAfter })}</span>
                </td>
              </tr>
            </tbody>
          </table>
          <CertificateChainView chain={problem.chain ?? []} pinned={profile?.tlsPinnedCerts ?? []} />
          <Checkbox
            checked={verified}
            onCheckedChange={setVerified}
            label="I verified the new certificate"
            description="The SHA-256 fingerprint above matches the one the server administrator gave me."
          />
          <Checkbox
            checked={dropOld}
            onCheckedChange={setDropOld}
            label="Remove the old pin"
            description="The previous certificate is no longer accepted for this connection."
          />
        </>
      )}
      {problem && !changed && (
        <>
          <p>
            LDAPilot could not verify the certificate of <span className="font-medium">{name}</span>
            {' '}(<span className="font-mono">{problem.host}</span>).
          </p>
          <InlineAlert
            tone="danger"
            title={certProblemTitle(problem.kind)}
            body={(problem.issues ?? []).length > 0 ? (
              <ul className="list-disc pl-4 space-y-0.5">
                {problem.issues!.map((issue) => <li key={issue}>{issue}</li>)}
              </ul>
            ) : undefined}
          />
          <p className="text-muted-foreground">
            Compare the SHA-256 fingerprint with the one your server administrator gives you before trusting it.
            Pinning trusts exactly this certificate for this connection, even if its issuer, host name or validity
            cannot be verified; you will be asked again when the server presents a different certificate.
          </p>
          <CertificateChainView
            chain={problem.chain ?? []}
            pinned={profile?.tlsPinnedCerts ?? []}
            onTrust={busy ? undefined : trustLeaf}
            trustLabel="Trust this certificate and connect"
            onUseAsCA={busy || !profile ? undefined : trustCA}
          />
        </>
      )}
    </Dialog>
  );
}
