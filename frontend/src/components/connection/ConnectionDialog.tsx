import { useState } from 'react'
import { X, FlaskConical, Loader2, Check, AlertCircle } from 'lucide-react'
import { ConnectionProfile, AuthMethod, TLSMode, newConnectionProfile } from '../../types/ldap'
import { cn } from '../../lib/utils'

interface ConnectionDialogProps {
  profile?: ConnectionProfile;
  onSave: (profile: ConnectionProfile) => void;
  onCancel: () => void;
  onTest?: (profile: ConnectionProfile) => Promise<void>;
}

export function ConnectionDialog({ profile, onSave, onCancel, onTest }: ConnectionDialogProps) {
  const [form, setForm] = useState<ConnectionProfile>(
    profile ? { ...profile } : newConnectionProfile()
  );
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'error' | null>(null);
  const [testError, setTestError] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const isEdit = !!profile?.id;

  function updateField<K extends keyof ConnectionProfile>(key: K, value: ConnectionProfile[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: '' }));
    setTestResult(null);
  }

  function validate(): boolean {
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = 'Name is required';
    if (!form.host.trim()) errs.host = 'Host is required';
    if (form.port < 1 || form.port > 65535) errs.port = 'Port must be 1-65535';
    if (form.authMethod === 'simple' && !form.bindDN.trim()) errs.bindDN = 'Bind DN is required for simple auth';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function handleSave() {
    if (!validate()) return;
    // Auto-set port based on TLS mode if still default
    const finalProfile = { ...form };
    if (finalProfile.tlsMode === 'ssl' && finalProfile.port === 389) {
      finalProfile.port = 636;
    }
    onSave(finalProfile);
  }

  async function handleTest() {
    if (!validate()) return;
    setTesting(true);
    setTestResult(null);
    setTestError('');
    try {
      await onTest?.(form);
      setTestResult('success');
    } catch (err: any) {
      setTestResult('error');
      setTestError(err?.message || 'Connection test failed');
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-card border border-border rounded-md shadow-2xl w-[520px] max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">
            {isEdit ? 'Edit Connection' : 'New Connection'}
          </h2>
          <button onClick={onCancel} className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground">
            <X size={16} />
          </button>
        </div>

        {/* Form */}
        <div className="flex-1 overflow-auto p-4 space-y-4">
          {/* Connection Name */}
          <Field label="Connection Name" error={errors.name}>
            <input
              type="text"
              value={form.name}
              onChange={(e) => updateField('name', e.target.value)}
              placeholder="My LDAP Server"
              className="input-field"
              autoFocus
            />
          </Field>

          {/* Host & Port */}
          <div className="flex gap-3">
            <div className="flex-1">
              <Field label="Host" error={errors.host}>
                <input
                  type="text"
                  value={form.host}
                  onChange={(e) => updateField('host', e.target.value)}
                  placeholder="ldap.example.com"
                  className="input-field"
                />
              </Field>
            </div>
            <div className="w-24">
              <Field label="Port" error={errors.port}>
                <input
                  type="number"
                  value={form.port}
                  onChange={(e) => updateField('port', parseInt(e.target.value) || 389)}
                  className="input-field"
                />
              </Field>
            </div>
          </div>

          {/* Base DN */}
          <Field label="Base DN">
            <input
              type="text"
              value={form.baseDN}
              onChange={(e) => updateField('baseDN', e.target.value)}
              placeholder="dc=example,dc=com"
              className="input-field"
            />
          </Field>

          {/* TLS Mode */}
          <Field label="Security">
            <select
              value={form.tlsMode}
              onChange={(e) => {
                const mode = e.target.value as TLSMode;
                updateField('tlsMode', mode);
                if (mode === 'ssl') updateField('port', 636);
                else if (mode === 'none' || mode === 'starttls') updateField('port', 389);
              }}
              className="input-field"
            >
              <option value="none">None (Plain)</option>
              <option value="starttls">StartTLS</option>
              <option value="ssl">SSL/TLS (LDAPS)</option>
            </select>
          </Field>

          {form.tlsMode !== 'none' && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={form.tlsSkipVerify}
                onChange={(e) => updateField('tlsSkipVerify', e.target.checked)}
                className="rounded border-border"
              />
              Skip certificate verification (insecure)
            </label>
          )}

          {/* Authentication */}
          <Field label="Authentication">
            <select
              value={form.authMethod}
              onChange={(e) => updateField('authMethod', e.target.value as AuthMethod)}
              className="input-field"
            >
              <option value="simple">Simple Bind</option>
              <option value="none">Anonymous</option>
            </select>
          </Field>

          {form.authMethod === 'simple' && (
            <>
              <Field label="Bind DN" error={errors.bindDN}>
                <input
                  type="text"
                  value={form.bindDN}
                  onChange={(e) => updateField('bindDN', e.target.value)}
                  placeholder="cn=admin,dc=example,dc=com"
                  className="input-field"
                />
              </Field>
              <Field label="Password">
                <input
                  type="password"
                  value={form.password}
                  onChange={(e) => updateField('password', e.target.value)}
                  placeholder="Enter password"
                  className="input-field"
                />
              </Field>
            </>
          )}

          {/* Advanced */}
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground py-1">
              Advanced Settings
            </summary>
            <div className="space-y-3 mt-2 pl-2 border-l border-border">
              <div className="flex gap-3">
                <div className="flex-1">
                  <Field label="Page Size">
                    <input
                      type="number"
                      value={form.pageSize}
                      onChange={(e) => updateField('pageSize', parseInt(e.target.value) || 500)}
                      className="input-field"
                    />
                  </Field>
                </div>
                <div className="flex-1">
                  <Field label="Timeout (sec)">
                    <input
                      type="number"
                      value={form.timeout}
                      onChange={(e) => updateField('timeout', parseInt(e.target.value) || 10)}
                      className="input-field"
                    />
                  </Field>
                </div>
              </div>
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground mt-2">
              <input
                type="checkbox"
                checked={form.readOnly}
                onChange={(e) => updateField('readOnly', e.target.checked)}
                className="rounded border-border"
              />
              Read-only mode (prevents accidental modifications)
            </label>
          </details>

          {/* Test Result */}
          {testResult && (
            <div className={cn(
              'flex items-center gap-2 text-xs px-3 py-2 rounded',
              testResult === 'success'
                ? 'bg-green-500/10 text-green-400'
                : 'bg-destructive/10 text-destructive'
            )}>
              {testResult === 'success' ? <Check size={14} /> : <AlertCircle size={14} />}
              {testResult === 'success' ? 'Connection successful!' : testError}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-border">
          <button
            onClick={handleTest}
            disabled={testing}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-border hover:bg-accent disabled:opacity-50"
          >
            {testing ? <Loader2 size={14} className="animate-spin" /> : <FlaskConical size={14} />}
            Test Connection
          </button>
          <div className="flex gap-2">
            <button
              onClick={onCancel}
              className="text-xs px-3 py-1.5 rounded border border-border hover:bg-accent"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {isEdit ? 'Save Changes' : 'Create Connection'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-muted-foreground mb-1">{label}</label>
      {children}
      {error && <p className="text-xs text-destructive mt-0.5">{error}</p>}
    </div>
  );
}
