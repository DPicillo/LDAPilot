package ldap

import (
	"regexp"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

// knownSyntaxes maps OIDs to human-readable syntax names.
var knownSyntaxes = map[string]string{
	"1.3.6.1.4.1.1466.115.121.1.3":  "Attribute Type Description",
	"1.3.6.1.4.1.1466.115.121.1.5":  "Binary",
	"1.3.6.1.4.1.1466.115.121.1.6":  "Bit String",
	"1.3.6.1.4.1.1466.115.121.1.7":  "Boolean",
	"1.3.6.1.4.1.1466.115.121.1.11": "Country String",
	"1.3.6.1.4.1.1466.115.121.1.12": "DN",
	"1.3.6.1.4.1.1466.115.121.1.14": "Delivery Method",
	"1.3.6.1.4.1.1466.115.121.1.15": "Directory String",
	"1.3.6.1.4.1.1466.115.121.1.22": "Facsimile Telephone Number",
	"1.3.6.1.4.1.1466.115.121.1.24": "Generalized Time",
	"1.3.6.1.4.1.1466.115.121.1.26": "IA5 String",
	"1.3.6.1.4.1.1466.115.121.1.27": "Integer",
	"1.3.6.1.4.1.1466.115.121.1.28": "JPEG",
	"1.3.6.1.4.1.1466.115.121.1.34": "Name And Optional UID",
	"1.3.6.1.4.1.1466.115.121.1.36": "Numeric String",
	"1.3.6.1.4.1.1466.115.121.1.37": "Object Class Description",
	"1.3.6.1.4.1.1466.115.121.1.38": "OID",
	"1.3.6.1.4.1.1466.115.121.1.39": "Other Mailbox",
	"1.3.6.1.4.1.1466.115.121.1.40": "Octet String",
	"1.3.6.1.4.1.1466.115.121.1.41": "Postal Address",
	"1.3.6.1.4.1.1466.115.121.1.44": "Printable String",
	"1.3.6.1.4.1.1466.115.121.1.50": "Telephone Number",
	"1.3.6.1.4.1.1466.115.121.1.53": "UTC Time",
	"1.3.6.1.4.1.1466.115.121.1.58": "Substring Assertion",
}

// GetSchema reads and parses the LDAP schema from the subschemaSubentry.
func (c *Client) GetSchema() (*models.SchemaInfo, error) {
	if c.conn == nil {
		return nil, ErrNotConnected
	}

	// First, find the subschemaSubentry DN from the root DSE
	subschemadn, err := c.getSubschemaDN()
	if err != nil {
		return nil, err
	}

	// Read the subschema entry
	req := goldap.NewSearchRequest(
		subschemadn,
		goldap.ScopeBaseObject,
		goldap.NeverDerefAliases,
		0, 0, false,
		"(objectClass=*)",
		[]string{"objectClasses", "attributeTypes"},
		nil,
	)

	result, err := c.conn.Search(req)
	if err != nil {
		return nil, err
	}

	if len(result.Entries) == 0 {
		return nil, ErrNotFound
	}

	entry := result.Entries[0]

	schema := &models.SchemaInfo{}

	// Parse objectClasses
	for _, raw := range entry.GetAttributeValues("objectClasses") {
		if oc := parseObjectClass(raw); oc != nil {
			schema.ObjectClasses = append(schema.ObjectClasses, *oc)
		}
	}

	// Parse attributeTypes
	for _, raw := range entry.GetAttributeValues("attributeTypes") {
		if at := parseAttributeType(raw); at != nil {
			schema.Attributes = append(schema.Attributes, *at)
		}
	}

	return schema, nil
}

// getSubschemaDN reads the subschemaSubentry from the root DSE.
func (c *Client) getSubschemaDN() (string, error) {
	req := goldap.NewSearchRequest(
		"",
		goldap.ScopeBaseObject,
		goldap.NeverDerefAliases,
		0, 0, false,
		"(objectClass=*)",
		[]string{"subschemaSubentry"},
		nil,
	)

	result, err := c.conn.Search(req)
	if err != nil {
		return "", err
	}

	if len(result.Entries) > 0 {
		dn := result.Entries[0].GetAttributeValue("subschemaSubentry")
		if dn != "" {
			return dn, nil
		}
	}

	// Fallback for servers that don't expose it
	return "cn=Subschema", nil
}

// Regex patterns for schema parsing (RFC 4512 format)
var (
	reOID         = regexp.MustCompile(`^\(\s*([0-9.]+|[a-zA-Z][a-zA-Z0-9-]*)`)
	reName        = regexp.MustCompile(`NAME\s+'([^']+)'`)
	reNames       = regexp.MustCompile(`NAME\s+\(\s*([^)]+)\)`)
	reDesc        = regexp.MustCompile(`DESC\s+'([^']*)'`)
	reSup         = regexp.MustCompile(`SUP\s+'?([a-zA-Z][a-zA-Z0-9-]*)'?`)
	reSups        = regexp.MustCompile(`SUP\s+\(\s*([^)]+)\)`)
	reMust        = regexp.MustCompile(`MUST\s+\(\s*([^)]+)\)`)
	reMustSingle  = regexp.MustCompile(`MUST\s+([a-zA-Z][a-zA-Z0-9-]*)`)
	reMay         = regexp.MustCompile(`MAY\s+\(\s*([^)]+)\)`)
	reMaySingle   = regexp.MustCompile(`MAY\s+([a-zA-Z][a-zA-Z0-9-]*)`)
	reSyntax      = regexp.MustCompile(`SYNTAX\s+([0-9.]+)`)
	reEquality    = regexp.MustCompile(`EQUALITY\s+([a-zA-Z][a-zA-Z0-9-]*)`)
	reOrdering    = regexp.MustCompile(`ORDERING\s+([a-zA-Z][a-zA-Z0-9-]*)`)
	reSubstring   = regexp.MustCompile(`SUBSTRING\s+([a-zA-Z][a-zA-Z0-9-]*)`)
	reUsage       = regexp.MustCompile(`USAGE\s+([a-zA-Z]+)`)
	reSupAttr     = regexp.MustCompile(`SUP\s+([a-zA-Z][a-zA-Z0-9-]*)`)
)

// parseObjectClass parses an RFC 4512 objectClass description.
func parseObjectClass(raw string) *models.SchemaObjectClass {
	oc := &models.SchemaObjectClass{}

	if m := reOID.FindStringSubmatch(raw); len(m) > 1 {
		oc.OID = m[1]
	}

	if m := reName.FindStringSubmatch(raw); len(m) > 1 {
		oc.Name = m[1]
	} else if m := reNames.FindStringSubmatch(raw); len(m) > 1 {
		names := splitSchemaList(m[1])
		if len(names) > 0 {
			oc.Name = names[0]
		}
	}

	if oc.Name == "" {
		return nil
	}

	if m := reDesc.FindStringSubmatch(raw); len(m) > 1 {
		oc.Description = m[1]
	}

	// Parse SUP (superclass)
	if m := reSups.FindStringSubmatch(raw); len(m) > 1 {
		oc.SuperClass = splitSchemaList(m[1])
	} else if m := reSup.FindStringSubmatch(raw); len(m) > 1 {
		oc.SuperClass = []string{m[1]}
	}

	// Parse kind
	if strings.Contains(raw, "ABSTRACT") {
		oc.Kind = "abstract"
	} else if strings.Contains(raw, "AUXILIARY") {
		oc.Kind = "auxiliary"
	} else {
		oc.Kind = "structural"
	}

	// Parse MUST
	if m := reMust.FindStringSubmatch(raw); len(m) > 1 {
		oc.Must = splitSchemaList(m[1])
	} else if m := reMustSingle.FindStringSubmatch(raw); len(m) > 1 {
		oc.Must = []string{m[1]}
	}

	// Parse MAY
	if m := reMay.FindStringSubmatch(raw); len(m) > 1 {
		oc.May = splitSchemaList(m[1])
	} else if m := reMaySingle.FindStringSubmatch(raw); len(m) > 1 {
		oc.May = []string{m[1]}
	}

	return oc
}

// parseAttributeType parses an RFC 4512 attributeType description.
func parseAttributeType(raw string) *models.SchemaAttribute {
	at := &models.SchemaAttribute{}

	if m := reOID.FindStringSubmatch(raw); len(m) > 1 {
		at.OID = m[1]
	}

	if m := reName.FindStringSubmatch(raw); len(m) > 1 {
		at.Name = m[1]
	} else if m := reNames.FindStringSubmatch(raw); len(m) > 1 {
		names := splitSchemaList(m[1])
		if len(names) > 0 {
			at.Name = names[0]
		}
	}

	if at.Name == "" {
		return nil
	}

	if m := reDesc.FindStringSubmatch(raw); len(m) > 1 {
		at.Description = m[1]
	}

	if m := reSyntax.FindStringSubmatch(raw); len(m) > 1 {
		at.Syntax = m[1]
		if name, ok := knownSyntaxes[m[1]]; ok {
			at.SyntaxName = name
		}
	}

	at.SingleValue = strings.Contains(raw, "SINGLE-VALUE")
	at.NoUserMod = strings.Contains(raw, "NO-USER-MODIFICATION")

	if m := reUsage.FindStringSubmatch(raw); len(m) > 1 {
		at.Usage = m[1]
	} else {
		at.Usage = "userApplications"
	}

	if m := reSupAttr.FindStringSubmatch(raw); len(m) > 1 {
		at.SuperType = m[1]
	}

	if m := reEquality.FindStringSubmatch(raw); len(m) > 1 {
		at.Equality = m[1]
	}
	if m := reOrdering.FindStringSubmatch(raw); len(m) > 1 {
		at.Ordering = m[1]
	}
	if m := reSubstring.FindStringSubmatch(raw); len(m) > 1 {
		at.Substring = m[1]
	}

	return at
}

// splitSchemaList splits a "$" or space-separated list of names.
func splitSchemaList(s string) []string {
	s = strings.TrimSpace(s)
	var parts []string

	// Try $ separator first (common in objectClass definitions)
	if strings.Contains(s, "$") {
		for _, p := range strings.Split(s, "$") {
			p = strings.TrimSpace(p)
			p = strings.Trim(p, "'")
			if p != "" {
				parts = append(parts, p)
			}
		}
		return parts
	}

	// Space-separated, possibly quoted
	for _, p := range strings.Fields(s) {
		p = strings.Trim(p, "'")
		if p != "" {
			parts = append(parts, p)
		}
	}
	return parts
}
