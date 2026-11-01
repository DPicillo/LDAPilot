import {
  User, Users, Folder, Building, Globe, Monitor, Box, FileText,
  Shield, Key, Network, Mail, Printer, Server, Settings, HardDrive,
  Database, Lock, Landmark, Contact, UserCheck, UserCog, Share2,
  Cpu, Waypoints, BookOpen, Shapes, Tag
} from 'lucide-react'

/** Map an icon hint (from Go backend) to a lucide-react icon component */
export function getIconForHint(hint: string) {
  switch (hint) {
    case 'user': return User;
    case 'users': return Users;
    case 'folder': return Folder;
    case 'building': return Building;
    case 'globe': return Globe;
    case 'monitor': return Monitor;
    case 'box': return Box;
    case 'shield': return Shield;
    case 'key': return Key;
    case 'network': return Network;
    case 'mail': return Mail;
    case 'printer': return Printer;
    case 'server': return Server;
    case 'settings': return Settings;
    case 'harddrive': return HardDrive;
    case 'database': return Database;
    case 'lock': return Lock;
    case 'landmark': return Landmark;
    case 'contact': return Contact;
    case 'usercheck': return UserCheck;
    case 'usercog': return UserCog;
    case 'share': return Share2;
    case 'cpu': return Cpu;
    case 'waypoints': return Waypoints;
    case 'schema': return BookOpen;        // AD schema partition (dMD)
    case 'schemaclass': return Shapes;     // classSchema
    case 'schemaattr': return Tag;         // attributeSchema
    default: return FileText;
  }
}

/**
 * Map objectClass values to an icon component (fallback when no hint).
 * Icon colour is not decided here: use `OBJECT_KIND_COLOR[resolveObjectKind(oc)]`
 * (components/ui/objectKind.ts, text-oc-* tokens), the one resolver of SPEC 6.4.
 */
export function getIconForObjectClass(objectClasses: string[]) {
  const ocs = new Set(objectClasses.map(oc => oc.toLowerCase()));

  // AD-specific
  if (ocs.has('classschema')) return Shapes;
  if (ocs.has('attributeschema')) return Tag;
  if (ocs.has('dmd')) return BookOpen;
  if (ocs.has('grouppolicycontainer')) return Settings;
  if (ocs.has('msmq-configuration') || ocs.has('msmq-queue')) return Waypoints;
  if (ocs.has('foreignsecurityprincipal')) return Shield;
  if (ocs.has('trustedDomain') || ocs.has('trusteddomain')) return Share2;
  if (ocs.has('msds-managedserviceaccount') || ocs.has('msds-groupmanagedserviceaccount')) return UserCog;
  if (ocs.has('contact')) return Contact;
  if (ocs.has('printqueue')) return Printer;
  if (ocs.has('volume')) return HardDrive;
  if (ocs.has('subnet')) return Network;
  if (ocs.has('site') || ocs.has('sitelink')) return Landmark;
  if (ocs.has('server')) return Server;
  if (ocs.has('ntsdsservice') || ocs.has('ntdsdsa')) return Database;
  if (ocs.has('computer')) return Monitor;

  // Standard LDAP
  if (ocs.has('person') || ocs.has('inetorgperson') || ocs.has('user') || ocs.has('posixaccount') || ocs.has('organizationalperson')) return User;
  if (ocs.has('group') || ocs.has('groupofnames') || ocs.has('groupofuniquenames') || ocs.has('posixgroup')) return Users;
  if (ocs.has('organizationalunit')) return Folder;
  if (ocs.has('organization')) return Building;
  if (ocs.has('domain') || ocs.has('domaindns') || ocs.has('dcobject')) return Globe;
  // organizationalRole: the LDAP "Container" template (a container kind, M-08).
  if (ocs.has('container') || ocs.has('builtindomain') || ocs.has('lostandfound') || ocs.has('organizationalrole')) return Box;

  return FileText;
}
