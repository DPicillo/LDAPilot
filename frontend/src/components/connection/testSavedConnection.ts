/**
 * "Test Connection" for a saved profile outside the dialog (status bar
 * switcher, Connections row menu): connects and binds with the stored (or
 * this session's) password on a temporary connection, then reports the
 * result as a notification with "Edit…" on failure. A profile without a
 * stored password (imported, or "Ask for the password on every connect")
 * asks for it first; the typed password is only used for the test.
 */
import { TestConnectionDetailed } from '../../lib/wails-auth'
import { certProblemTitle, describeTestSuccess, stageLabel } from '../../lib/connectionAuth'
import { useConnectionStore } from '../../stores/connectionStore'
import { toast } from '../ui/Toast'
import { editConnection } from './ConnectionDialog'
import { needsPasswordPrompt } from './profileLogic'
import { requestConnectPassword } from './passwordPromptStore'

export async function testSavedConnection(profileId: string): Promise<void> {
  const profile = useConnectionStore.getState().profiles.find((p) => p.id === profileId)
  if (!profile) return
  const name = profile.name || 'Unnamed'
  // An empty password means "use the stored one" (TestConnectionDetailed).
  let password = ''
  // A profile connected with a password typed for this session tests with that one (Go keeps it);
  // "ask on every connect" keeps none.
  const sessionPassword = !profile.askPassword && useConnectionStore.getState().connectionStatuses[profileId] === true
  if (needsPasswordPrompt(profile) && !sessionPassword) {
    const answer = await requestConnectPassword(profile, undefined, 'test')
    if (!answer) return
    password = answer.password
  }
  const info = toast.info(`Testing ${name}…`, { duration: 0, connection: name, history: false })
  try {
    const r = await TestConnectionDetailed({ ...profile, password })
    toast.dismiss(info)
    if (r.success) {
      toast.success(`${name}: connection works`, { detail: describeTestSuccess(r).join('\n'), duration: 6000, connection: name })
      return
    }
    const title = r.certProblem ? certProblemTitle(r.certProblem.kind) : stageLabel(r.stage)
    toast.error(`${name}: ${title}`, r.error, {
      connection: name,
      action: { label: 'Edit…', run: () => editConnection(profileId, r.certProblem || r.stage === 'tls' ? 'tls' : r.stage === 'bind' ? 'credentials' : undefined) },
    })
  } catch (err) {
    toast.dismiss(info)
    toast.error(`${name}: test failed`, err instanceof Error ? err.message : String(err), { connection: name })
  }
}
