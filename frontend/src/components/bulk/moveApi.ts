/** BatchService.BatchMovePreview (the move dry run, RW3-S-07). */
import { getBinding } from '../../lib/wails'
import { localMovePlan, normalizePlan, type MovePlan } from './moveModel'

/** The dry run of moving `dns` below `target`; a backend without it gets the local plan. */
export async function BatchMovePreview(profileID: string, dns: string[], target: string): Promise<MovePlan> {
  const svc = getBinding('BatchService')
  if (svc?.BatchMovePreview) return normalizePlan(await svc.BatchMovePreview(profileID, dns, target), dns)
  return localMovePlan(dns, target)
}
