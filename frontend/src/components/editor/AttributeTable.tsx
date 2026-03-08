import { useState, useCallback } from 'react'
import { ArrowUpDown, Plus, Trash2, Pencil, Check, X, Eye, EyeOff, Image, Calendar, Hash, Link2, Copy } from 'lucide-react'
import { LDAPAttribute } from '../../types/ldap'
import { cn } from '../../lib/utils'
import { DN_REFERENCE_ATTRS, PASSWORD_ATTRS } from '../../lib/ad-constants'

interface AttributeTableProps {
  attributes: LDAPAttribute[];
  onModify?: (attrName: string, values: string[]) => void;
  onAdd?: (attrName: string, values: string[]) => void;
  onDelete?: (attrName: string) => void;
  onNavigateDN?: (dn: string) => void;
  readOnly?: boolean;
}

type SortKey = 'name' | 'value';
type SortDir = 'asc' | 'desc';

// Attribute type detection
const TIME_ATTRS = new Set(['createtimestamp', 'modifytimestamp', 'pwdchangedtime', 'whenchanged', 'whencreated', 'accountexpires', 'lastlogon', 'lastlogontimestamp', 'pwdlastset', 'badpasswordtime', 'lockouttime']);
const IMAGE_ATTRS = new Set(['jpegphoto', 'thumbnailphoto', 'photo']);
const FLAGS_ATTRS: Record<string, Record<number, string>> = {
  useraccountcontrol: {
    0x0001: 'SCRIPT',
    0x0002: 'ACCOUNTDISABLE',
    0x0008: 'HOMEDIR_REQUIRED',
    0x0010: 'LOCKOUT',
    0x0020: 'PASSWD_NOTREQD',
    0x0040: 'PASSWD_CANT_CHANGE',
    0x0080: 'ENCRYPTED_TEXT_PWD_ALLOWED',
    0x0100: 'TEMP_DUPLICATE_ACCOUNT',
    0x0200: 'NORMAL_ACCOUNT',
    0x0800: 'INTERDOMAIN_TRUST_ACCOUNT',
    0x1000: 'WORKSTATION_TRUST_ACCOUNT',
    0x2000: 'SERVER_TRUST_ACCOUNT',
    0x10000: 'DONT_EXPIRE_PASSWORD',
    0x20000: 'MNS_LOGON_ACCOUNT',
    0x40000: 'SMARTCARD_REQUIRED',
    0x80000: 'TRUSTED_FOR_DELEGATION',
    0x100000: 'NOT_DELEGATED',
    0x200000: 'USE_DES_KEY_ONLY',
    0x400000: 'DONT_REQ_PREAUTH',
    0x800000: 'PASSWORD_EXPIRED',
    0x1000000: 'TRUSTED_TO_AUTH_FOR_DELEGATION',
  },
  grouptype: {
    0x00000001: 'BUILTIN_LOCAL',
    0x00000002: 'ACCOUNT_GROUP',
    0x00000004: 'RESOURCE_GROUP',
    0x00000008: 'UNIVERSAL_GROUP',
    0x80000000: 'SECURITY_ENABLED',
  },
  systemflags: {
    0x00000001: 'ATTR_NOT_REPLICATED',
    0x00000002: 'ATTR_REQ_PARTIAL_SET_MEMBER',
    0x00000004: 'ATTR_IS_CONSTRUCTED',
    0x00000010: 'CATEGORY_1_OBJECT',
    0x00000020: 'CONFIG_ALLOW_RENAME',
    0x00000040: 'CONFIG_ALLOW_MOVE',
    0x00000080: 'CONFIG_ALLOW_LIMITED_MOVE',
    0x02000000: 'DOMAIN_DISALLOW_RENAME',
    0x04000000: 'DOMAIN_DISALLOW_MOVE',
    0x10000000: 'DISALLOW_DELETE',
  },
};

const ENUM_ATTRS: Record<string, Record<number, string>> = {
  samaccounttype: {
    0x00000000: 'DOMAIN_OBJECT',
    0x10000000: 'GROUP_OBJECT',
    0x10000001: 'NON_SECURITY_GROUP_OBJECT',
    0x20000000: 'ALIAS_OBJECT',
    0x20000001: 'NON_SECURITY_ALIAS_OBJECT',
    0x30000000: 'USER_OBJECT',
    0x30000001: 'MACHINE_ACCOUNT',
    0x30000002: 'TRUST_ACCOUNT',
    0x40000000: 'APP_BASIC_GROUP',
    0x40000001: 'APP_QUERY_GROUP',
  },
};

type AttrType = 'password' | 'time' | 'image' | 'flags' | 'enum' | 'dn-reference' | 'binary' | 'text';

function getAttrType(name: string): AttrType {
  const lower = name.toLowerCase();
  if (PASSWORD_ATTRS.has(lower)) return 'password';
  if (TIME_ATTRS.has(lower)) return 'time';
  if (IMAGE_ATTRS.has(lower)) return 'image';
  if (FLAGS_ATTRS[lower]) return 'flags';
  if (ENUM_ATTRS[lower]) return 'enum';
  if (DN_REFERENCE_ATTRS.has(lower)) return 'dn-reference';
  return 'text';
}

export function AttributeTable({
  attributes,
  onModify,
  onAdd,
  onDelete,
  onNavigateDN,
  readOnly = false,
}: AttributeTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [editingAttr, setEditingAttr] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [filter, setFilter] = useState('');
  const [showAddRow, setShowAddRow] = useState(false);
  const [newAttrName, setNewAttrName] = useState('');
  const [newAttrValue, setNewAttrValue] = useState('');

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  const sorted = [...attributes]
    .filter(attr => {
      if (!filter) return true;
      const f = filter.toLowerCase();
      return attr.name.toLowerCase().includes(f) ||
        attr.values.some(v => v.toLowerCase().includes(f));
    })
    .sort((a, b) => {
      const aVal = sortKey === 'name' ? a.name : (a.values[0] || '');
      const bVal = sortKey === 'name' ? b.name : (b.values[0] || '');
      const cmp = aVal.localeCompare(bVal);
      return sortDir === 'asc' ? cmp : -cmp;
    });

  function startEdit(attr: LDAPAttribute) {
    setEditingAttr(attr.name);
    setEditValue(attr.values.join('\n'));
  }

  function saveEdit(attrName: string) {
    const values = editValue.split('\n').filter(v => v.trim());
    onModify?.(attrName, values);
    setEditingAttr(null);
  }

  function cancelEdit() {
    setEditingAttr(null);
  }

  function handleAddAttribute() {
    if (newAttrName.trim() && newAttrValue.trim()) {
      onAdd?.(newAttrName.trim(), [newAttrValue.trim()]);
      setNewAttrName('');
      setNewAttrValue('');
      setShowAddRow(false);
    }
  }

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-card">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter attributes..."
          className="flex-1 px-2 py-1 text-xs bg-input border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring"
        />
        {!readOnly && (
          <button
            onClick={() => setShowAddRow(true)}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-accent text-muted-foreground"
            title="Add Attribute"
          >
            <Plus size={12} />
          </button>
        )}
        <span className="text-xs text-muted-foreground">
          {sorted.length} attr{sorted.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-card">
            <tr className="border-b border-border">
              <th
                className="text-left px-3 py-1.5 font-medium text-muted-foreground cursor-pointer hover:text-foreground select-none w-1/3"
                onClick={() => handleSort('name')}
              >
                <span className="flex items-center gap-1">
                  Attribute
                  <ArrowUpDown size={10} className={sortKey === 'name' ? 'text-primary' : ''} />
                </span>
              </th>
              <th
                className="text-left px-3 py-1.5 font-medium text-muted-foreground cursor-pointer hover:text-foreground select-none"
                onClick={() => handleSort('value')}
              >
                <span className="flex items-center gap-1">
                  Value
                  <ArrowUpDown size={10} className={sortKey === 'value' ? 'text-primary' : ''} />
                </span>
              </th>
              {!readOnly && (
                <th className="w-16 px-2 py-1.5"></th>
              )}
            </tr>
          </thead>
          <tbody>
            {/* Add new attribute row */}
            {showAddRow && (
              <tr className="border-b border-border bg-accent/30">
                <td className="px-3 py-1">
                  <input
                    type="text"
                    value={newAttrName}
                    onChange={(e) => setNewAttrName(e.target.value)}
                    placeholder="Attribute name"
                    className="w-full px-1 py-0.5 text-xs bg-input border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring"
                    autoFocus
                  />
                </td>
                <td className="px-3 py-1">
                  <input
                    type="text"
                    value={newAttrValue}
                    onChange={(e) => setNewAttrValue(e.target.value)}
                    placeholder="Value"
                    className="w-full px-1 py-0.5 text-xs bg-input border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring"
                    onKeyDown={(e) => e.key === 'Enter' && handleAddAttribute()}
                  />
                </td>
                <td className="px-2 py-1">
                  <div className="flex gap-0.5">
                    <button onClick={handleAddAttribute} className="p-0.5 text-green-400 hover:text-green-300">
                      <Check size={12} />
                    </button>
                    <button onClick={() => setShowAddRow(false)} className="p-0.5 text-muted-foreground hover:text-foreground">
                      <X size={12} />
                    </button>
                  </div>
                </td>
              </tr>
            )}

            {sorted.map((attr) => (
              <tr
                key={attr.name}
                className={cn(
                  'border-b border-border hover:bg-accent/30',
                  editingAttr === attr.name && 'bg-accent/50'
                )}
              >
                <td className="px-3 py-1 font-mono text-primary/80 align-top group/name">
                  <div className="flex items-center gap-1">
                    <AttrIcon type={getAttrType(attr.name)} />
                    <span className="truncate">{attr.name}</span>
                    <CopyBtn
                      text={attr.values.join('\n')}
                      className="opacity-0 group-hover/name:opacity-100"
                      title="Copy value"
                    />
                  </div>
                </td>
                <td className="px-3 py-1 align-top">
                  {editingAttr === attr.name ? (
                    <textarea
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      className="w-full px-1 py-0.5 text-xs bg-input border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring font-mono resize-y min-h-[24px]"
                      rows={editValue.split('\n').length}
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') cancelEdit();
                        if (e.key === 'Enter' && e.ctrlKey) saveEdit(attr.name);
                      }}
                    />
                  ) : (
                    <AttrValueRenderer attr={attr} onNavigateDN={onNavigateDN} />
                  )}
                </td>
                {!readOnly && (
                  <td className="px-2 py-1 align-top">
                    {editingAttr === attr.name ? (
                      <div className="flex gap-0.5">
                        <button onClick={() => saveEdit(attr.name)} className="p-0.5 text-green-400 hover:text-green-300">
                          <Check size={12} />
                        </button>
                        <button onClick={cancelEdit} className="p-0.5 text-muted-foreground hover:text-foreground">
                          <X size={12} />
                        </button>
                      </div>
                    ) : (
                      <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 hover:opacity-100">
                        <button
                          onClick={() => startEdit(attr)}
                          className="p-0.5 text-muted-foreground hover:text-foreground"
                          title="Edit"
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          onClick={() => onDelete?.(attr.name)}
                          className="p-0.5 text-muted-foreground hover:text-destructive"
                          title="Delete"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AttrIcon({ type }: { type: AttrType }) {
  switch (type) {
    case 'password': return <EyeOff size={10} className="text-yellow-500 shrink-0" />;
    case 'time': return <Calendar size={10} className="text-blue-400 shrink-0" />;
    case 'image': return <Image size={10} className="text-green-400 shrink-0" />;
    case 'flags': return <Hash size={10} className="text-purple-400 shrink-0" />;
    case 'enum': return <Hash size={10} className="text-orange-400 shrink-0" />;
    case 'dn-reference': return <Link2 size={10} className="text-blue-400 shrink-0" />;
    default: return null;
  }
}

function AttrValueRenderer({ attr, onNavigateDN }: { attr: LDAPAttribute; onNavigateDN?: (dn: string) => void }) {
  const [showPassword, setShowPassword] = useState(false);
  const type = getAttrType(attr.name);

  // Special: objectClass with color-coded chips
  if (attr.name === 'objectClass') {
    return (
      <div className="flex flex-wrap gap-0.5 font-mono">
        {attr.values.map((v, i) => (
          <span
            key={i}
            className={cn(
              'px-1.5 py-0 rounded text-[10px]',
              v === 'top' ? 'bg-muted text-muted-foreground'
                : v === 'person' || v === 'inetOrgPerson' || v === 'user' ? 'bg-blue-500/15 text-blue-400'
                : v === 'group' || v === 'groupOfNames' || v === 'posixGroup' ? 'bg-green-500/15 text-green-400'
                : v === 'organizationalUnit' ? 'bg-yellow-500/15 text-yellow-400'
                : v === 'computer' ? 'bg-orange-500/15 text-orange-400'
                : 'bg-accent/50 text-foreground'
            )}
          >
            {v}
          </span>
        ))}
      </div>
    );
  }

  if (attr.binary) {
    return (
      <div className="font-mono">
        <span className="text-muted-foreground italic">(binary data, {attr.values.length > 0 ? `${attr.values[0].length} chars` : 'empty'})</span>
      </div>
    );
  }

  switch (type) {
    case 'password':
      return (
        <div className="flex items-center gap-1 font-mono">
          {showPassword ? (
            <span className="break-all">{attr.values[0]}</span>
          ) : (
            <span className="text-muted-foreground">{'•'.repeat(Math.min(attr.values[0]?.length || 8, 16))}</span>
          )}
          <button
            onClick={() => setShowPassword(!showPassword)}
            className="p-0.5 text-muted-foreground hover:text-foreground shrink-0"
          >
            {showPassword ? <EyeOff size={10} /> : <Eye size={10} />}
          </button>
        </div>
      );

    case 'time':
      return (
        <div className="font-mono">
          {attr.values.map((v, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="break-all">{v}</span>
              <span className="text-muted-foreground text-[10px] shrink-0">
                {formatLDAPTime(v, attr.name)}
              </span>
            </div>
          ))}
        </div>
      );

    case 'flags': {
      const flagDefs = FLAGS_ATTRS[attr.name.toLowerCase()];
      if (flagDefs && attr.values[0]) {
        const numVal = parseInt(attr.values[0]);
        if (!isNaN(numVal)) {
          const activeFlags = Object.entries(flagDefs)
            .filter(([bit]) => (numVal & parseInt(bit)) !== 0)
            .map(([, name]) => name);

          return (
            <div>
              <div className="font-mono break-all">{attr.values[0]}</div>
              {activeFlags.length > 0 && (
                <div className="flex flex-wrap gap-0.5 mt-0.5">
                  {activeFlags.map(flag => (
                    <span key={flag} className="px-1 py-0 bg-purple-500/15 text-purple-400 rounded text-[9px] font-mono">
                      {flag}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        }
      }
      return <div className="font-mono break-all">{attr.values.join(', ')}</div>;
    }

    case 'enum': {
      const enumDefs = ENUM_ATTRS[attr.name.toLowerCase()];
      if (enumDefs && attr.values[0]) {
        const numVal = parseInt(attr.values[0]);
        const label = !isNaN(numVal) ? enumDefs[numVal] : undefined;
        return (
          <div>
            <div className="font-mono break-all">{attr.values[0]}</div>
            {label && (
              <span className="px-1 py-0 bg-orange-500/15 text-orange-400 rounded text-[9px] font-mono">
                {label}
              </span>
            )}
          </div>
        );
      }
      return <div className="font-mono break-all">{attr.values.join(', ')}</div>;
    }

    case 'dn-reference':
      return (
        <div className="font-mono">
          {attr.values.length > 3 ? (
            // Compact chip display for many DN references
            <div className="flex flex-wrap gap-0.5">
              {attr.values.slice(0, 10).map((v, i) => {
                const rdn = v.split(',')[0];
                return (
                  <button
                    key={i}
                    onClick={() => onNavigateDN?.(v)}
                    className="inline-flex items-center gap-0.5 px-1.5 py-0 bg-blue-500/10 text-blue-300 rounded text-[10px] hover:bg-blue-500/20 hover:text-blue-200 cursor-pointer"
                    title={`Navigate to ${v}`}
                  >
                    <Link2 size={8} className="shrink-0" />
                    {rdn}
                  </button>
                );
              })}
              {attr.values.length > 10 && (
                <span className="text-[10px] text-muted-foreground px-1">+{attr.values.length - 10} more</span>
              )}
            </div>
          ) : (
            attr.values.map((v, i) => (
              <div key={i} className="flex items-center gap-1 break-all">
                <Link2 size={10} className="text-blue-400 shrink-0" />
                <button
                  onClick={() => onNavigateDN?.(v)}
                  className="text-blue-300 hover:text-blue-200 hover:underline cursor-pointer text-left"
                  title={`Navigate to ${v}`}
                >
                  {v}
                </button>
              </div>
            ))
          )}
        </div>
      );

    default:
      if (attr.values.length > 3) {
        // Multi-value chips for attributes with many values
        return (
          <div className="flex flex-wrap gap-0.5 font-mono">
            {attr.values.slice(0, 20).map((v, i) => (
              <span key={i} className="px-1.5 py-0 bg-accent/50 rounded text-[10px] break-all max-w-[300px] truncate" title={v}>
                {v}
              </span>
            ))}
            {attr.values.length > 20 && (
              <span className="text-[10px] text-muted-foreground px-1">+{attr.values.length - 20} more</span>
            )}
          </div>
        );
      }
      return (
        <div className="font-mono">
          {attr.values.map((v, i) => (
            <div key={i} className="break-all">{v}</div>
          ))}
        </div>
      );
  }
}

function formatLDAPTime(value: string, attrName?: string): string {
  const lower = attrName?.toLowerCase() || '';

  // AD special sentinel values
  if (lower === 'pwdlastset' && value === '0') return 'Must change at next logon';
  if (lower === 'accountexpires' && (value === '0' || value === '9223372036854775807')) return 'Never';
  if (lower === 'lockouttime' && value === '0') return 'Not locked out';

  // Generalized Time: YYYYMMDDHHmmssZ or YYYYMMDDHHMMSS.0Z
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (match) {
    const [, y, m, d, hh, mm, ss] = match;
    return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
  }

  // Windows FileTime (100-nanosecond intervals since 1601-01-01)
  const num = parseInt(value);
  if (!isNaN(num) && num > 116444736000000000) {
    const ms = (num - 116444736000000000) / 10000;
    const date = new Date(ms);
    if (!isNaN(date.getTime())) {
      return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    }
  }

  return '';
}

function CopyBtn({ text, className, title }: { text: string; className?: string; title?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className={cn('p-0.5 text-muted-foreground hover:text-foreground shrink-0 transition-opacity', className)}
      title={title || 'Copy'}
    >
      {copied ? <Check size={10} className="text-green-400" /> : <Copy size={10} />}
    </button>
  );
}
