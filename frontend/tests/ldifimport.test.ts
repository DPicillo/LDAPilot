/**
 * LDIF import options (components/export/ldifImportOptions.ts): defaults,
 * stored choices, server hints and the dry run's adjustment summary.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AD_EXPORT_PASSWORDS, DEFAULT_IMPORT_CHOICES, adjustmentGroups, adjustmentItemsText, existingText, importOptionsOf, parseImportChoices,
  serverAttributesHint,
} from '../src/components/export/ldifImportOptions.ts'

test('defaults adapt instead of blocking: skip existing entries, leave out what the server refuses, keep going', () => {
  assert.deepEqual(DEFAULT_IMPORT_CHOICES, { existing: 'skip', serverAttributes: 'omit', unknownSchema: 'omit', missingReferences: 'omit', continueOnError: true })
  assert.deepEqual(parseImportChoices(null), DEFAULT_IMPORT_CHOICES)
  assert.deepEqual(parseImportChoices('not json'), DEFAULT_IMPORT_CHOICES)
})

test('stored choices are read back, unknown values fall back to the default', () => {
  const c = parseImportChoices(JSON.stringify({ existing: 'update', serverAttributes: 'send', unknownSchema: 'bogus', continueOnError: false }))
  assert.equal(c.existing, 'update')
  assert.equal(c.serverAttributes, 'send')
  assert.equal(c.unknownSchema, 'omit')
  assert.equal(c.missingReferences, 'omit')
  assert.equal(c.continueOnError, false)
  assert.deepEqual(importOptionsOf(c), { existing: 'update', serverAttributes: 'send', unknownSchema: 'omit', missingReferences: 'omit' })
})

test('the dialog says per server type what sending IDs and timestamps does', () => {
  assert.match(serverAttributesHint('openldap'), /Relax Rules/)
  assert.match(serverAttributesHint('openldap'), /entryCSN.*cannot be set/)
  assert.match(serverAttributesHint('389ds'), /assigns nsUniqueId, entryUUID/)
  assert.match(serverAttributesHint('ad'), /objectGUID, objectSid/)
  assert.equal(serverAttributesHint(null), '')
  assert.match(AD_EXPORT_PASSWORDS, /never returns passwords/)
})

test('adjustment totals are grouped by kind and reason', () => {
  const groups = adjustmentGroups([
    { kind: 'serverOmitted', attribute: 'entryUUID', reason: 'maintained', records: 7 },
    { kind: 'classOmitted', attribute: 'nsMemberOf', reason: 'not defined', records: 35 },
    { kind: 'serverOmitted', attribute: 'createTimestamp', reason: 'maintained', records: 7 },
    { kind: 'serverOmitted', attribute: 'entryCSN', reason: 'OpenLDAP does not let an import set it', records: 7 },
    { kind: 'existing', attribute: '', reason: 'The entry exists already: skipped', records: 3 },
  ])
  assert.deepEqual(groups.map((g) => [g.label, g.items.map((i) => i.name).join(',')]), [
    ['Left out', 'entryUUID,createTimestamp'],
    ['Object classes left out', 'nsMemberOf'],
    ['Left out', 'entryCSN'],
    ['Existing entries', ''],
  ])
  assert.equal(adjustmentItemsText(groups[0].items), 'entryUUID, createTimestamp (7 records each)')
  assert.equal(adjustmentItemsText(groups[1].items), 'nsMemberOf (35 records)')
  assert.equal(adjustmentItemsText([{ name: 'a', records: 1 }, { name: 'b', records: 2 }]), 'a (1), b (2)')
  assert.equal(existingText(groups[3]), '3 records: the entry exists already: skipped')
  assert.deepEqual(adjustmentGroups(undefined), [])
})
