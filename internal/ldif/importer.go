package ldif

import (
	"fmt"
	"io"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/models"
)

// Parse reads an LDIF string with content records (and "changetype: add"
// records) and returns the entries. Other change types and URL values are
// rejected; use ParseChanges for change files. Attributes follow the binary
// contract of models.LDAPAttribute.
func Parse(ldifContent string) ([]models.LDAPEntry, error) {
	res := ParseChanges(ldifContent, ParseOptions{})
	if len(res.Errors) > 0 {
		return nil, res.Errors[0]
	}
	entries := make([]models.LDAPEntry, 0, len(res.Records))
	for _, rec := range res.Records {
		if rec.ChangeType != models.LDIFChangeAdd {
			return nil, &SyntaxError{Line: rec.Line, Msg: fmt.Sprintf("entry %q: changetype %q is not supported here, only content records and changetype add", rec.DN, rec.ChangeType)}
		}
		entries = append(entries, models.LDAPEntry{DN: rec.DN, Attributes: rec.Attributes})
	}
	return entries, nil
}

// ParseReader reads LDIF data from a reader and returns parsed entries
// (see Parse).
func ParseReader(r io.Reader) ([]models.LDAPEntry, error) {
	var sb strings.Builder
	if _, err := io.Copy(&sb, r); err != nil {
		return nil, fmt.Errorf("error reading LDIF: %w", err)
	}
	return Parse(sb.String())
}
