/** Attributes whose values are Distinguished Names referencing other entries. */
export const DN_REFERENCE_ATTRS = new Set([
  'member',
  'memberof',
  'managedby',
  'manager',
  'directreports',
  'msds-membertransitive',
  'msds-memberoftransitive',
  'distinguishedname',
  'defaultnamingcontext',
  'schemanamingcontext',
  'configurationnamingcontext',
  'rootdomainnamingcontext',
  'namingcontexts',
  'subschemasubentry',
  'dscorepropagationdata',
  'msds-lastknownrdn',
  'objectcategory',
  'seealso',
  'modifiedcountatlastprom',
  'lastknownparent',
]);

/** Attributes containing password / credential data. */
export const PASSWORD_ATTRS = new Set([
  'userpassword',
  'unicodepwd',
  'sambantpassword',
  'sambalmpassword',
]);
