import { create } from 'zustand'
import type { ConnectionProfile } from '../../types/ldap'

/** What the password prompt answers: the password and whether to store it. */
export interface PasswordAnswer {
  password: string
  save: boolean
}

/** Why the password is asked: a connect (default) or Test Connection of a saved profile. */
export type PasswordPurpose = 'connect' | 'test'

interface PasswordPromptRequest {
  profile: Pick<ConnectionProfile, 'id' | 'name' | 'host' | 'port' | 'bindDN' | 'authMethod' | 'askPassword'> & Partial<Pick<ConnectionProfile, 'tlsMode'>>
  /** The server rejected the previous password (shown above the field). */
  error?: string
  purpose: PasswordPurpose
  resolve: (answer: PasswordAnswer | null) => void
}

interface PasswordPromptState {
  request: PasswordPromptRequest | null
  answer: (answer: PasswordAnswer | null) => void
}

/** Drives ConnectPasswordPrompt (mounted once in AppLayout's overlay hosts). */
export const usePasswordPromptStore = create<PasswordPromptState>((set, get) => ({
  request: null,
  answer: (answer) => {
    const req = get().request
    set({ request: null })
    req?.resolve(answer)
  },
}))

/**
 * Asks for the password of a profile that has none stored (imported
 * profiles, profiles that ask on every connect); resolves null when the
 * user cancels. A pending request of another connect is cancelled.
 */
export function requestConnectPassword(profile: PasswordPromptRequest['profile'], error?: string, purpose: PasswordPurpose = 'connect'): Promise<PasswordAnswer | null> {
  return new Promise((resolve) => {
    const prev = usePasswordPromptStore.getState().request
    usePasswordPromptStore.setState({ request: { profile, error, purpose, resolve } })
    prev?.resolve(null)
  })
}
