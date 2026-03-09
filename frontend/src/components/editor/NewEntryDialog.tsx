import { useState, useEffect } from 'react'
import { Plus, Loader2, X, Trash2 } from 'lucide-react'
import { useConnectionStore } from '../../stores/connectionStore'
import { SchemaObjectClass, LDAPAttribute, ValidationError } from '../../types/ldap'
import * as wails from '../../lib/wails'
import { toast } from '../ui/Toast'

interface NewEntryDialogProps {
  parentDN: string;
  onClose: () => void;
  onCreated?: () => void;
}

const TEMPLATES = [
  { label: 'Organizational Unit', objectClasses: ['top', 'organizationalUnit'], rdnAttr: 'ou' },
  { label: 'User (inetOrgPerson)', objectClasses: ['top', 'person', 'organizationalPerson', 'inetOrgPerson'], rdnAttr: 'cn' },
  { label: 'POSIX User', objectClasses: ['top', 'person', 'organizationalPerson', 'inetOrgPerson', 'posixAccount', 'shadowAccount'], rdnAttr: 'uid' },
  { label: 'Group', objectClasses: ['top', 'groupOfNames'], rdnAttr: 'cn' },
  { label: 'POSIX Group', objectClasses: ['top', 'posixGroup'], rdnAttr: 'cn' },
  { label: 'Container', objectClasses: ['top', 'container'], rdnAttr: 'cn' },
  { label: 'Custom...', objectClasses: ['top'], rdnAttr: 'cn' },
];

export function NewEntryDialog({ parentDN, onClose, onCreated }: NewEntryDialogProps) {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);

  const [selectedTemplate, setSelectedTemplate] = useState(0);
  const [rdnAttr, setRdnAttr] = useState('ou');
  const [rdnValue, setRdnValue] = useState('');
  const [attributes, setAttributes] = useState<{ name: string; value: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>([]);
  const [schemaOCs, setSchemaOCs] = useState<SchemaObjectClass[]>([]);

  useEffect(() => {
    if (activeProfileId) {
      wails.GetSchema(activeProfileId).then(schema => {
        if (schema?.objectClasses) {
          setSchemaOCs(schema.objectClasses);
        }
      }).catch(() => {});
    }
  }, [activeProfileId]);

  useEffect(() => {
    const tpl = TEMPLATES[selectedTemplate];
    setRdnAttr(tpl.rdnAttr);
    setRdnValue('');

    // Build required attributes from schema
    const requiredAttrs = new Set<string>();
    for (const ocName of tpl.objectClasses) {
      const oc = schemaOCs.find(o => o.name.toLowerCase() === ocName.toLowerCase());
      if (oc?.must) {
        oc.must.forEach(a => requiredAttrs.add(a));
      }
    }

    // Remove objectClass and RDN attr (we handle those separately)
    requiredAttrs.delete('objectClass');
    requiredAttrs.delete(tpl.rdnAttr);

    const attrs = Array.from(requiredAttrs).map(name => ({ name, value: '' }));
    setAttributes(attrs);
  }, [selectedTemplate, schemaOCs]);

  function addAttribute() {
    setAttributes([...attributes, { name: '', value: '' }]);
  }

  function removeAttribute(index: number) {
    setAttributes(attributes.filter((_, i) => i !== index));
  }

  function updateAttribute(index: number, field: 'name' | 'value', val: string) {
    setAttributes(attributes.map((a, i) => i === index ? { ...a, [field]: val } : a));
  }

  // Clear validation errors when form changes
  useEffect(() => {
    setValidationErrors([]);
  }, [selectedTemplate, rdnAttr, rdnValue, attributes]);

  async function handleCreate() {
    if (!activeProfileId || !rdnValue.trim()) return;

    const tpl = TEMPLATES[selectedTemplate];
    const dn = `${rdnAttr}=${rdnValue},${parentDN}`;

    // Build attributes map for validation
    const attrMap: Record<string, string[]> = {};
    attrMap[rdnAttr] = [rdnValue];
    for (const attr of attributes) {
      if (attr.name.trim()) {
        attrMap[attr.name] = [attr.value];
      }
    }

    // Validate against schema before creating
    try {
      const valErrors = await wails.ValidateEntry(activeProfileId, tpl.objectClasses, attrMap);
      if (valErrors && valErrors.length > 0) {
        setValidationErrors(valErrors);
        return;
      }
    } catch {
      // Validation service unavailable — proceed without validation
    }
    setValidationErrors([]);

    const ldapAttrs: LDAPAttribute[] = [
      { name: 'objectClass', values: tpl.objectClasses, binary: false },
      { name: rdnAttr, values: [rdnValue], binary: false },
    ];

    for (const attr of attributes) {
      if (attr.name.trim() && attr.value.trim()) {
        ldapAttrs.push({ name: attr.name, values: [attr.value], binary: false });
      }
    }

    setLoading(true);
    setError(null);
    try {
      await wails.CreateEntry(activeProfileId, dn, ldapAttrs);
      toast.success(`Entry "${dn}" created`);
      onCreated?.();
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to create entry');
      toast.error(err?.message || 'Failed to create entry');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-card border border-border rounded-md shadow-2xl w-[500px] max-h-[80%] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">New Entry</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground">
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4 space-y-3">
          {/* Parent DN */}
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Parent DN</label>
            <div className="text-xs font-mono bg-background px-2 py-1.5 rounded border border-border truncate">
              {parentDN}
            </div>
          </div>

          {/* Template */}
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Template</label>
            <select
              value={selectedTemplate}
              onChange={(e) => setSelectedTemplate(parseInt(e.target.value))}
              className="input-field"
            >
              {TEMPLATES.map((tpl, i) => (
                <option key={i} value={i}>{tpl.label}</option>
              ))}
            </select>
          </div>

          {/* RDN */}
          <div className="flex gap-2">
            <div className="w-32">
              <label className="block text-xs text-muted-foreground mb-1">RDN Attribute</label>
              <input
                type="text"
                value={rdnAttr}
                onChange={(e) => setRdnAttr(e.target.value)}
                className="input-field font-mono"
              />
            </div>
            <div className="flex-1">
              <label className="block text-xs text-muted-foreground mb-1">RDN Value</label>
              <input
                type="text"
                value={rdnValue}
                onChange={(e) => setRdnValue(e.target.value)}
                placeholder="Enter value..."
                className="input-field"
                autoFocus
              />
            </div>
          </div>

          {/* Resulting DN */}
          {rdnValue && (
            <div className="text-[10px] font-mono text-muted-foreground bg-background px-2 py-1 rounded border border-border">
              DN: {rdnAttr}={rdnValue},{parentDN}
            </div>
          )}

          {/* Object Classes */}
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Object Classes</label>
            <div className="flex flex-wrap gap-1">
              {TEMPLATES[selectedTemplate].objectClasses.map(oc => (
                <span key={oc} className="px-1.5 py-0.5 bg-blue-500/15 text-blue-400 rounded text-[10px] font-mono">{oc}</span>
              ))}
            </div>
          </div>

          {/* Attributes */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs text-muted-foreground">Attributes</label>
              <button
                onClick={addAttribute}
                className="flex items-center gap-1 text-xs text-primary hover:text-primary/80"
              >
                <Plus size={10} />
                Add
              </button>
            </div>
            <div className="space-y-1">
              {attributes.map((attr, i) => (
                <div key={i} className="flex items-center gap-1">
                  <input
                    type="text"
                    value={attr.name}
                    onChange={(e) => updateAttribute(i, 'name', e.target.value)}
                    placeholder="Attribute"
                    className="input-field font-mono w-32"
                  />
                  <input
                    type="text"
                    value={attr.value}
                    onChange={(e) => updateAttribute(i, 'value', e.target.value)}
                    placeholder="Value"
                    className="input-field flex-1"
                  />
                  <button
                    onClick={() => removeAttribute(i)}
                    className="p-1 text-muted-foreground hover:text-destructive shrink-0"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {validationErrors.length > 0 && (
            <div className="bg-red-500/10 border border-red-500/30 rounded p-2 text-xs text-red-400 space-y-1">
              {validationErrors.map((e, i) => (
                <div key={i}>
                  <span className="font-medium">{e.attribute}:</span> {e.message}
                </div>
              ))}
            </div>
          )}

          {error && (
            <div className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded">{error}</div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
          <button onClick={onClose} className="text-xs px-3 py-1.5 rounded border border-border hover:bg-accent">
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={loading || !rdnValue.trim()}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            Create Entry
          </button>
        </div>
      </div>
    </div>
  );
}
