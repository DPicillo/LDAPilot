import { useRef, useState } from 'react'
import { KeyRound } from 'lucide-react'
import { usePasswordPromptStore } from './passwordPromptStore'
import { authMethodInfo } from '../../lib/connectionAuth'
import { connectCleartextNote } from '../../lib/unencryptedConsent'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Checkbox } from '../ui/Checkbox'
import { InlineAlert } from '../ui/InlineAlert'
import { Field } from './FormField'

/**
 * Password prompt on connect (CONN-04): profiles imported from an export
 * file (exports never contain passwords) or saved without a password ask
 * for it instead of failing with "Empty password not allowed". "Save
 * password" stores it encrypted once the connection works; otherwise it is
 * kept in memory for reconnects until LDAPilot quits. A profile set to "Ask
 * for the password on every connect" (DEF-07) has no "Save password": the
 * password is used for this connect only. Purpose 'test': Test Connection of
 * a saved profile without a stored password. Mounted once in AppLayout's
 * overlay hosts; opened by connectionStore.connect / reconnect and
 * testSavedConnection.
 */
export function ConnectPasswordPrompt() {
  const request = usePasswordPromptStore((s) => s.request)
  if (!request) return null
  return <PasswordDialog key={`${request.profile.id}:${request.error ?? ''}`} />
}

function PasswordDialog() {
  const request = usePasswordPromptStore((s) => s.request)!
  const answer = usePasswordPromptStore((s) => s.answer)
  const [password, setPassword] = useState('')
  const [save, setSave] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const p = request.profile
  const user = p.bindDN?.trim()
  const ask = !!p.askPassword
  const test = request.purpose === 'test'
  // A simple bind over plain LDAP: the same wording as the password writes (DEF-21). No
  // confirmation: the profile chose plain LDAP (its dialog and the status bar chip say so).
  const plainNote = connectCleartextNote(p.authMethod, p.tlsMode)
  const who = (
    <>
      {authMethodInfo(p.authMethod).short}
      {user ? <> as <span className="font-mono text-foreground">{user}</span></> : null}
    </>
  )

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && answer(null)}
      title={`${test ? 'Test' : 'Connect to'} ${p.name || 'server'}`}
      description={`${p.host}:${p.port}`}
      icon={KeyRound}
      size="sm"
      dismissible="always"
      initialFocus={inputRef}
      onSubmit={() => {
        if (password) answer({ password, save: save && !ask && !test })
      }}
      bodyClassName="space-y-3"
      footer={
        <>
          <Button variant="ghost" onClick={() => answer(null)}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!password}>
            {test ? 'Test' : 'Connect'}
          </Button>
        </>
      }
    >
      {request.error && <InlineAlert tone="danger" title="The server rejected the password" body={<span className="break-words">{request.error}</span>} />}
      {ask ? (
        <p className="text-sm text-muted-foreground">
          This connection asks for the password on every connect ({who}). It is not stored{test ? '' : ' and is only used for this connection until you disconnect'}.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          No password is stored for this connection ({who}). Imported connections never contain passwords.
        </p>
      )}
      {plainNote && <InlineAlert tone="warning" body={plainNote} />}
      <Field label="Password" required>
        <Input ref={inputRef} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
      </Field>
      {!ask && !test && (
        <Checkbox
          checked={save}
          onCheckedChange={setSave}
          label="Save password"
          description="Stored encrypted with this connection once the connection works. Otherwise it is only kept until LDAPilot quits."
        />
      )}
    </Dialog>
  )
}
