package ldaptools

import (
	"fmt"

	ber "github.com/go-asn1-ber/asn1-ber"
	goldap "github.com/go-ldap/ldap/v3"
)

// assertionControl is the RFC 4528 Assertion control: the server applies
// the operation only if the entry matches the filter (else result 122).
type assertionControl struct {
	filter string
	packet *ber.Packet
}

// NewAssertionControl builds a critical assertion control from an RFC 4515
// filter.
func NewAssertionControl(filter string) (goldap.Control, error) {
	p, err := goldap.CompileFilter(filter)
	if err != nil {
		return nil, fmt.Errorf("assertion filter: %w", err)
	}
	return &assertionControl{filter: filter, packet: p}, nil
}

func (c *assertionControl) GetControlType() string { return oidAssertion }

func (c *assertionControl) Encode() *ber.Packet {
	packet := ber.Encode(ber.ClassUniversal, ber.TypeConstructed, ber.TagSequence, nil, "Control")
	packet.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, oidAssertion, "Control Type (Assertion)"))
	packet.AppendChild(ber.NewBoolean(ber.ClassUniversal, ber.TypePrimitive, ber.TagBoolean, true, "Criticality"))
	value := ber.Encode(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, nil, "Control Value (Assertion)")
	value.AppendChild(c.packet)
	packet.AppendChild(value)
	return packet
}

func (c *assertionControl) String() string {
	return fmt.Sprintf("Control Type: Assertion (%q) Criticality: true Filter: %s", oidAssertion, c.filter)
}
