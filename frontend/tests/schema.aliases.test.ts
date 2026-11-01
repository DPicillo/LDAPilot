// Run: cd frontend && node --test 'tests/*.test.ts'
// DEF-25: schema attribute / class aliases (rfc822Mailbox is mail) in the
// schema views: lookups, inherited MUST / MAY, filter, definitions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aliasesOf, attributeDefinition, attributeName, classAttributes, findAttribute, findObjectClass, hasSchemaName, objectClassDefinition,
  schemaElementMatches,
} from '../src/components/schema/schemaModel.ts';
import type { SchemaAttribute, SchemaInfo, SchemaObjectClass } from '../src/types/ldap';

const at = (name: string, oid: string, aliases: string[] = []): SchemaAttribute =>
  ({ oid, name, description: '', syntax: '', syntaxName: '', singleValue: false, noUserMod: false, usage: 'userApplications', superType: '', equality: '', ordering: '', substring: '', aliases }) as SchemaAttribute;
const oc = (name: string, superClass: string[], must: string[], may: string[], aliases: string[] = []): SchemaObjectClass =>
  ({ oid: `1.9.${name.length}`, name, description: '', superClass, kind: 'structural', must, may, aliases }) as SchemaObjectClass;

const schema = {
  attributes: [
    at('mail', '0.9.2342.19200300.100.1.3', ['rfc822Mailbox']),
    at('uid', '0.9.2342.19200300.100.1.1', ['userid']),
    at('cn', '2.5.4.3', ['commonName']),
    at('b', '1.2'),
    at('a', '1.1', ['b']),
  ],
  objectClasses: [
    oc('top', [], ['objectClass'], []),
    oc('pilotPerson', ['top'], ['commonName'], ['rfc822Mailbox', 'mail', 'userid'], ['newPilotPerson']),
    oc('pilotChild', ['newPilotPerson'], [], ['0.9.2342.19200300.100.1.3']),
  ],
} as unknown as SchemaInfo;

test('lookups by name, alias, OID and with options resolve to the same attribute', () => {
  for (const n of ['mail', 'MAIL', 'rfc822Mailbox', 'RFC822mailbox', '0.9.2342.19200300.100.1.3', 'mail;lang-de', ' mail ']) {
    assert.equal(findAttribute(schema, n)?.name, 'mail', n);
  }
  assert.equal(findAttribute(schema, 'surname'), undefined);
  assert.equal(attributeName(schema, 'userid'), 'uid');
  assert.equal(attributeName(schema, 'surname'), 'surname');
  // An alias never shadows another type's own name.
  assert.equal(findAttribute(schema, 'b')?.oid, '1.2');
  assert.equal(findObjectClass(schema, 'NEWPILOTPERSON')?.name, 'pilotPerson');
  assert.ok(hasSchemaName(schema.attributes[0], 'rfc822Mailbox'));
  assert.ok(!hasSchemaName(schema.attributes[0], ''));
  assert.deepEqual(aliasesOf(schema.objectClasses[1]), ['newPilotPerson']);
  assert.deepEqual(aliasesOf({ name: 'x' }), []);
});

test('inherited MUST / MAY list each type once, by its primary name, also through a class alias', () => {
  const own = classAttributes(schema, schema.objectClasses[1]);
  assert.deepEqual(own.must[0].names, ['cn']);
  assert.deepEqual(own.may[0].names, ['mail', 'uid']);
  const child = classAttributes(schema, schema.objectClasses[2]);
  // SUP newPilotPerson is pilotPerson; the OID in its own MAY is mail, so pilotPerson only adds uid.
  assert.deepEqual(child.may.map((g) => [g.from, g.names]), [['', ['mail']], ['pilotPerson', ['uid']]]);
  assert.deepEqual(child.must.find((g) => g.from === 'pilotPerson')?.names, ['cn']);
  assert.equal(child.mustCount, 2); // cn + objectClass
});

test('the schema filter matches aliases; definitions carry every NAME', () => {
  assert.ok(schemaElementMatches(schema.attributes[0], 'rfc822'));
  assert.ok(schemaElementMatches(schema.attributes[0], '100.1.3'));
  assert.ok(!schemaElementMatches(schema.attributes[1], 'rfc822'));
  assert.ok(schemaElementMatches(schema.objectClasses[1], 'newpilot'));
  assert.ok(schemaElementMatches(schema.attributes[0], '  '));
  assert.match(attributeDefinition(schema.attributes[0]), /NAME \( 'mail' 'rfc822Mailbox' \)/);
  assert.match(attributeDefinition(schema.attributes[3]), /NAME 'b' /);
  assert.match(objectClassDefinition(schema.objectClasses[1]), /NAME \( 'pilotPerson' 'newPilotPerson' \)/);
});
