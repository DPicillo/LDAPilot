import {
  User, Users, Folder, Building, Globe, Monitor, Box, FileText,
  Shield, Key, Network, Mail, Printer, Server
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
    default: return FileText;
  }
}

/** Map objectClass values to an icon component (fallback when no hint) */
export function getIconForObjectClass(objectClasses: string[]) {
  const ocs = objectClasses.map(oc => oc.toLowerCase());

  if (ocs.some(oc => ['person', 'inetorgperson', 'user', 'posixaccount'].includes(oc))) return User;
  if (ocs.some(oc => ['group', 'groupofnames', 'groupofuniquenames', 'posixgroup'].includes(oc))) return Users;
  if (ocs.some(oc => ['organizationalunit'].includes(oc))) return Folder;
  if (ocs.some(oc => ['organization'].includes(oc))) return Building;
  if (ocs.some(oc => ['domain', 'domaindns', 'dcobject'].includes(oc))) return Globe;
  if (ocs.some(oc => ['computer'].includes(oc))) return Monitor;
  if (ocs.some(oc => ['container'].includes(oc))) return Box;

  return FileText;
}
