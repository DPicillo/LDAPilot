package ldap

import (
	"errors"
	"fmt"
	"strconv"
	"strings"

	goldap "github.com/go-ldap/ldap/v3"
)

// crossRef systemFlags bits (MS-ADTS 2.2.10.2).
const (
	// CrossRefFlagNTDSNC marks a crossRef for a naming context of the AD forest
	// (FLAG_CR_NTDS_NC). crossRefs without it point to external directories.
	CrossRefFlagNTDSNC = 0x1
	// CrossRefFlagNTDSDomain marks a domain naming context (FLAG_CR_NTDS_DOMAIN).
	CrossRefFlagNTDSDomain = 0x2
)

// CrossRef describes one crossRef object below CN=Partitions of an AD forest.
type CrossRef struct {
	// NCName is the DN of the naming context.
	NCName string
	// DNSRoot is the DNS name of the partition (dnsRoot), may be empty.
	DNSRoot string
	// SystemFlags holds the crossRef systemFlags; only valid when HasFlags.
	SystemFlags int
	HasFlags    bool
	// Enabled is false only when the crossRef carries enabled=FALSE, i.e. the
	// partition is pre-created but not instantiated yet.
	Enabled bool
}

// GetCrossRefs lists the crossRef objects of CN=Partitions,<configNC>: every
// naming context of the forest (domains, application partitions,
// Configuration, Schema), including those hosted on other DCs.
func (c *Client) GetCrossRefs(configNC string) ([]CrossRef, error) {
	searchReq := goldap.NewSearchRequest(
		"CN=Partitions,"+configNC,
		goldap.ScopeSingleLevel,
		goldap.NeverDerefAliases,
		0, 0, false,
		"(objectClass=crossRef)",
		[]string{"nCName", "dnsRoot", "systemFlags", "enabled"},
		nil,
	)

	var result *goldap.SearchResult
	err := c.read(func(conn *goldap.Conn) (err error) {
		result, err = conn.Search(searchReq)
		return err
	})
	if err != nil {
		if errors.Is(err, ErrNotConnected) {
			return nil, err
		}
		// A referral answer may still carry usable entries.
		if !goldap.IsErrorWithCode(err, goldap.LDAPResultReferral) || result == nil {
			return nil, fmt.Errorf("%w: %s", ErrSearchFailed, ldapErrorDetail(err))
		}
	}

	refs := make([]CrossRef, 0, len(result.Entries))
	for _, entry := range result.Entries {
		ref := CrossRef{
			NCName:  entry.GetAttributeValue("nCName"),
			DNSRoot: entry.GetAttributeValue("dnsRoot"),
			Enabled: !strings.EqualFold(entry.GetAttributeValue("enabled"), "FALSE"),
		}
		if ref.NCName == "" {
			continue
		}
		if v := entry.GetAttributeValue("systemFlags"); v != "" {
			if n, convErr := strconv.Atoi(v); convErr == nil {
				ref.SystemFlags, ref.HasFlags = n, true
			}
		}
		refs = append(refs, ref)
	}
	return refs, nil
}
