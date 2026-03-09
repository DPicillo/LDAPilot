import { useState } from 'react'
import { X, KeyRound, Loader2, AlertCircle, Eye, EyeOff, Check, Copy } from 'lucide-react'
import { useConnectionStore } from '../../stores/connectionStore'
import * as wails from '../../lib/wails'
import { toast } from '../ui/Toast'

interface PasswordDialogProps {
  dn: string;
  onClose: () => void;
  onChanged?: () => void;
}

const PASSWORD_ATTR_OPTIONS = [
  { value: 'userPassword', label: 'userPassword (OpenLDAP / standard)' },
  { value: 'unicodePwd', label: 'unicodePwd (Active Directory)' },
];

function generatePassword(length = 16): string {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const digits = '0123456789';
  const symbols = '!@#$%^&*()-_=+[]{}|;:,.<>?';
  const all = upper + lower + digits + symbols;

  // Ensure at least one of each category
  const result = [
    upper[Math.floor(Math.random() * upper.length)],
    lower[Math.floor(Math.random() * lower.length)],
    digits[Math.floor(Math.random() * digits.length)],
    symbols[Math.floor(Math.random() * symbols.length)],
  ];

  for (let i = result.length; i < length; i++) {
    result.push(all[Math.floor(Math.random() * all.length)]);
  }

  // Shuffle
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result.join('');
}

export function PasswordDialog({ dn, onClose, onChanged }: PasswordDialogProps) {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);

  const [passwordAttr, setPasswordAttr] = useState('userPassword');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pwdLength, setPwdLength] = useState(16);

  const passwordsMatch = newPassword === confirmPassword;
  const isValid = newPassword.length >= 1 && passwordsMatch;

  function handleGenerate() {
    const pwd = generatePassword(pwdLength);
    setNewPassword(pwd);
    setConfirmPassword(pwd);
    setShowPassword(true);
  }

  function handleCopy() {
    navigator.clipboard.writeText(newPassword);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function handleSubmit() {
    if (!activeProfileId || !isValid) return;
    setLoading(true);
    setError(null);
    try {
      await wails.ModifyAttribute(activeProfileId, dn, passwordAttr, [newPassword]);
      toast.success('Password changed successfully');
      onChanged?.();
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to change password');
      toast.error('Failed to change password', err?.message);
    } finally {
      setLoading(false);
    }
  }

  // Password strength indicator
  const strength = getPasswordStrength(newPassword);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-lg shadow-2xl w-[450px] max-w-[90vw] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <KeyRound size={14} className="text-primary" />
            Change Password
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground">
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-3">
          {/* Target DN */}
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Target Entry</label>
            <div className="text-xs font-mono bg-background/50 px-2 py-1.5 rounded border border-border text-muted-foreground truncate" title={dn}>
              {dn}
            </div>
          </div>

          {/* Password Attribute */}
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Password Attribute</label>
            <select
              value={passwordAttr}
              onChange={e => setPasswordAttr(e.target.value)}
              className="input-field"
            >
              {PASSWORD_ATTR_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          {/* New Password */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs text-muted-foreground">New Password</label>
              <div className="flex items-center gap-2">
                <select
                  value={pwdLength}
                  onChange={e => setPwdLength(parseInt(e.target.value))}
                  className="text-[10px] bg-transparent border border-border rounded px-1 py-0.5 text-muted-foreground"
                  title="Password length"
                >
                  {[8, 12, 16, 20, 24, 32].map(l => (
                    <option key={l} value={l}>{l} chars</option>
                  ))}
                </select>
                <button
                  onClick={handleGenerate}
                  className="text-[10px] text-primary hover:text-primary/80"
                >
                  Generate
                </button>
                {newPassword && (
                  <button
                    onClick={handleCopy}
                    className="text-muted-foreground hover:text-foreground"
                    title="Copy password"
                  >
                    {copied ? <Check size={10} className="text-green-400" /> : <Copy size={10} />}
                  </button>
                )}
              </div>
            </div>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                className="input-field font-mono pr-8"
                placeholder="Enter new password..."
                autoFocus
              />
              <button
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showPassword ? <EyeOff size={12} /> : <Eye size={12} />}
              </button>
            </div>

            {/* Strength bar */}
            {newPassword && (
              <div className="mt-1.5 flex items-center gap-2">
                <div className="flex-1 flex gap-0.5">
                  {[0, 1, 2, 3].map(i => (
                    <div
                      key={i}
                      className={`h-1 flex-1 rounded-full transition-colors ${
                        i < strength.level
                          ? strength.level <= 1 ? 'bg-red-500'
                            : strength.level === 2 ? 'bg-yellow-500'
                            : strength.level === 3 ? 'bg-blue-500'
                            : 'bg-green-500'
                          : 'bg-muted'
                      }`}
                    />
                  ))}
                </div>
                <span className={`text-[10px] ${
                  strength.level <= 1 ? 'text-red-400'
                    : strength.level === 2 ? 'text-yellow-400'
                    : strength.level === 3 ? 'text-blue-400'
                    : 'text-green-400'
                }`}>
                  {strength.label}
                </span>
              </div>
            )}
          </div>

          {/* Confirm Password */}
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Confirm Password</label>
            <input
              type={showPassword ? 'text' : 'password'}
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              className={`input-field font-mono ${confirmPassword && !passwordsMatch ? 'border-red-500/50' : ''}`}
              placeholder="Confirm password..."
              onKeyDown={e => { if (e.key === 'Enter' && isValid) handleSubmit(); }}
            />
            {confirmPassword && !passwordsMatch && (
              <p className="text-[10px] text-red-400 mt-0.5">Passwords do not match</p>
            )}
          </div>

          {error && (
            <div className="flex items-center gap-2 text-xs px-3 py-2 rounded bg-destructive/10 text-destructive">
              <AlertCircle size={12} />
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
          <button
            onClick={onClose}
            className="text-xs px-3 py-1.5 rounded border border-border hover:bg-accent"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={loading || !isValid}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {loading && <Loader2 size={12} className="animate-spin" />}
            <KeyRound size={12} />
            Change Password
          </button>
        </div>
      </div>
    </div>
  );
}

function getPasswordStrength(password: string): { level: number; label: string } {
  if (!password) return { level: 0, label: '' };
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;

  if (score <= 1) return { level: 1, label: 'Weak' };
  if (score <= 2) return { level: 2, label: 'Fair' };
  if (score <= 3) return { level: 3, label: 'Good' };
  return { level: 4, label: 'Strong' };
}
