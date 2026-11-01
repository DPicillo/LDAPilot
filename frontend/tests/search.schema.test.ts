// Run: cd frontend && node --test 'tests/*.test.ts'
// Schema views: inherited MUST / MAY grouped by class, definitions for
// "Copy Definition"; log views: op colours, results, DNs of log rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attributeDefinition, classAncestors, classAttributes, objectClassDefinition, sortedNames } from '../src/components/schema/schemaModel.ts';
import { auditNewDN, logEntryDN, logResult, opTone } from '../src/components/layout/opTone.ts';
import type { SchemaInfo, SchemaObjectClass } from '../src/types/ldap';

const oc = (name: string, superClass: string[], must: string[], may: string[], kind = 'structural'): SchemaObjectClass =>
  ({ oid: `1.1.${name.length}`, name, description: '', superClass, kind, must, may }) as SchemaObjectClass;

const schema = {
  objectClasses: [
    oc('top', [], ['objectClass'], [], 'abstract'),
    oc('person', ['top'], ['cn', 'sn'], ['telephoneNumber', 'description', 'seeAlso']),
    oc('organizationalPerson', ['person'], [], ['title', 'ou', 'description']),
    oc('user', ['organizationalPerson'], [], ['sAMAccountName', 'Mail', 'cn']),
    // A cycle never loops
    oc('loopA', ['loopB'], ['a'], []),
    oc('loopB', ['loopA'], ['b'], []),
  ],
  attributes: [],
} as unknown as SchemaInfo;

test('classAncestors walks SUP nearest first, each class once, cycles ignored', () => {
  assert.deepEqual(classAncestors(schema, schema.objectClasses[3]).map((c) => c.name), ['organizationalPerson', 'person', 'top']);
  assert.deepEqual(classAncestors(schema, schema.objectClasses[4]).map((c) => c.name), ['loopB']);
});

test('classAttributes lists inherited MUST / MAY under the nearest class, sorted, required never optional', () => {
  const a = classAttributes(schema, schema.objectClasses[3]);
  assert.deepEqual(a.must, [
    { from: '', names: [] },
    { from: 'person', names: ['cn', 'sn'] },
    { from: 'top', names: ['objectClass'] },
  ]);
  assert.deepEqual(a.may, [
    { from: '', names: ['Mail', 'sAMAccountName'] },
    { from: 'organizationalPerson', names: ['description', 'ou', 'title'] },
    { from: 'person', names: ['seeAlso', 'telephoneNumber'] },
  ]);
  assert.equal(a.mustCount, 3);
  assert.equal(a.mayCount, 7);
  assert.deepEqual(sortedNames(['b', 'A', 'a', 'C']), ['A', 'b', 'C']);
});

test('definitions are RFC 4512 descriptions', () => {
  assert.equal(
    objectClassDefinition({ ...schema.objectClasses[1], oid: '2.5.6.6', description: "It's a person" }),
    "( 2.5.6.6 NAME 'person' DESC 'It\\27s a person' SUP top STRUCTURAL MUST ( cn $ sn ) MAY ( telephoneNumber $ description $ seeAlso ) )",
  );
  assert.equal(
    attributeDefinition({ oid: '2.5.4.4', name: 'sn', description: '', superType: 'name', syntax: '1.3.6.1.4.1.1466.115.121.1.15', equality: 'caseIgnoreMatch', singleValue: false, noUserMod: false, usage: 'userApplications' } as never),
    "( 2.5.4.4 NAME 'sn' SUP name EQUALITY caseIgnoreMatch SYNTAX 1.3.6.1.4.1.1466.115.121.1.15 )",
  );
});

test('opTone covers every logged and audited operation', () => {
  for (const op of ['MOVE', 'RENAME', 'MODRDN']) assert.equal(opTone(op), 'text-op-modrdn');
  assert.equal(opTone('AUDIT_CLEARED'), 'text-op-delete');
  assert.equal(opTone('READ'), 'text-op-search');
  assert.equal(opTone('bulk_delete'), 'text-op-delete');
  assert.equal(opTone('whatever'), 'text-muted-foreground');
});

test('logResult and logEntryDN read the operations log details', () => {
  assert.equal(logResult({ details: 'base=dc=x scope=sub filter=(cn=*) -> cancelled after 12 entries' }), 'cancelled');
  assert.equal(logResult({ details: 'base=dc=x', error: 'No Such Object' }), 'error');
  assert.equal(logResult({ details: 'base=dc=x scope=sub filter=(cn=*) -> 3 entries' }), 'ok');
  assert.equal(logEntryDN('base=OU=Sales,DC=ad scope=sub filter=(cn=*)'), 'OU=Sales,DC=ad');
  assert.equal(logEntryDN('dn=CN=Schmidt\\, Anna,OU=A,DC=x replace description(1)'), 'CN=Schmidt\\, Anna,OU=A,DC=x');
  assert.equal(logEntryDN('dn=cn=a,dc=x newRDN=cn=b'), 'cn=a,dc=x');
  assert.equal(logEntryDN('server=ldap://x'), '');
});

test('auditNewDN links RENAME / MOVE rows to the new DN', () => {
  assert.equal(auditNewDN({ operation: 'MOVE', dn: 'cn=a,ou=x,dc=y', details: 'newRDN=cn=a newSuperior=ou=z,dc=y newDN=cn=a,ou=z,dc=y' }), 'cn=a,ou=z,dc=y');
  // Older rows without newDN=
  assert.equal(auditNewDN({ operation: 'RENAME', dn: 'cn=a,ou=x,dc=y', details: 'newRDN=cn=b deleteOldRDN=false' }), 'cn=b,ou=x,dc=y');
  assert.equal(auditNewDN({ operation: 'RENAME', dn: 'cn=a,ou=x,dc=y', details: 'newRDN=cn=b newSuperior=ou=q,dc=y' }), 'cn=b,ou=q,dc=y');
  assert.equal(auditNewDN({ operation: 'MODIFY', dn: 'cn=a', details: 'newDN=cn=b' }), '');
});

test('logEntryDN ends the DN at every key the Go logger writes after it', () => {
  for (const [details, dn] of [
    ['dn=CN=Anna Schmidt,OU=A,DC=x changes=replace:description(1)', 'CN=Anna Schmidt,OU=A,DC=x'],
    ['dn=CN=a,DC=x target=OU=b,DC=x', 'CN=a,DC=x'],
    ['dn=CN=G,DC=x members effective=true -> 3 queries', 'CN=G,DC=x'],
    ['dn=CN=a,DC=x -> failed', 'CN=a,DC=x'],
    ['dn=CN=a,DC=x (RFC 3062 extended operation)', 'CN=a,DC=x'],
    ['dn=CN=a,DC=x WARNING: stored in cleartext', 'CN=a,DC=x'],
    ['dn=CN=a,DC=x controls=TreeDelete', 'CN=a,DC=x'],
  ]) assert.equal(logEntryDN(details), dn, details);
});
