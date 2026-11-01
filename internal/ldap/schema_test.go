package ldap

import (
	"reflect"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/models"
)

type schemaDefs []string

func (raw schemaDefs) parse() []models.SchemaAttribute {
	out := make([]models.SchemaAttribute, 0, len(raw))
	for _, r := range raw {
		out = append(out, *parseAttributeType(r))
	}
	return out
}

// Samba writes quoted OIDs and names; OpenLDAP bare ones with length bounds.
func TestParseAttributeTypeQuotedAndBare(t *testing.T) {
	samba := parseAttributeType(`( 0.9.2342.19200300.100.1.3 NAME 'mail' SYNTAX '1.3.6.1.4.1.1466.115.121.1.15' SINGLE-VALUE )`)
	if samba == nil || samba.Name != "mail" || samba.Syntax != "1.3.6.1.4.1.1466.115.121.1.15" || samba.SyntaxName != "Directory String" || !samba.SingleValue {
		t.Fatalf("samba mail = %+v", samba)
	}
	ol := parseAttributeType(`( 0.9.2342.19200300.100.1.3 NAME ( 'mail' 'rfc822Mailbox' ) DESC 'RFC1274: RFC822 Mailbox (with SUP and MUST in the text)' EQUALITY caseIgnoreIA5Match SUBSTR caseIgnoreIA5SubstringsMatch SYNTAX 1.3.6.1.4.1.1466.115.121.1.26{256} )`)
	if ol == nil || ol.Name != "mail" || ol.Syntax != "1.3.6.1.4.1.1466.115.121.1.26" || ol.SyntaxName != "IA5 String" {
		t.Fatalf("openldap mail = %+v", ol)
	}
	if ol.Equality != "caseIgnoreIA5Match" || ol.Substring != "caseIgnoreIA5SubstringsMatch" || ol.SuperType != "" {
		t.Fatalf("rules / SUP from DESC text: %+v", ol)
	}
	if ol.Description != "RFC1274: RFC822 Mailbox (with SUP and MUST in the text)" {
		t.Fatalf("DESC = %q", ol.Description)
	}
	op := parseAttributeType(`( 2.5.18.1 NAME 'createTimestamp' EQUALITY generalizedTimeMatch ORDERING generalizedTimeOrderingMatch SYNTAX 1.3.6.1.4.1.1466.115.121.1.24 SINGLE-VALUE NO-USER-MODIFICATION USAGE directoryOperation )`)
	if op.Usage != "directoryOperation" || !op.NoUserMod || op.Ordering != "generalizedTimeOrderingMatch" {
		t.Fatalf("createTimestamp = %+v", op)
	}
}

// sn SUP name inherits syntax and rules; a chain and an OID SUP resolve too.
func TestResolveAttributeInheritance(t *testing.T) {
	attrs := schemaDefs{
		`( 2.5.4.41 NAME 'name' EQUALITY caseIgnoreMatch SUBSTR caseIgnoreSubstringsMatch SYNTAX 1.3.6.1.4.1.1466.115.121.1.15{32768} )`,
		`( 2.5.4.4 NAME ( 'sn' 'surname' ) DESC 'RFC2256: last (family) name(s)' SUP name )`,
		`( 1.1.1 NAME 'x-child' SUP 2.5.4.4 )`,
		`( 1.1.2 NAME 'loopA' SUP loopB )`,
		`( 1.1.3 NAME 'loopB' SUP loopA )`,
	}.parse()
	resolveAttributeInheritance(attrs)
	for _, a := range attrs[1:3] {
		if a.Syntax != "1.3.6.1.4.1.1466.115.121.1.15" || a.SyntaxName != "Directory String" || a.Equality != "caseIgnoreMatch" || a.Substring != "caseIgnoreSubstringsMatch" {
			t.Errorf("%s did not inherit: %+v", a.Name, a)
		}
	}
	if attrs[3].Syntax != "" {
		t.Errorf("cycle produced a syntax: %+v", attrs[3])
	}
}

func TestParseObjectClass(t *testing.T) {
	// Samba style: quoted SUP and single MUST, $-lists; OpenLDAP style: bare.
	samba := parseObjectClass(`( 2.5.6.6 NAME 'person' SUP 'top' STRUCTURAL MUST ( cn $ objectClass ) MAY ( sn $ userPassword $ telephoneNumber ) )`)
	if samba == nil || samba.Kind != "structural" || !reflect.DeepEqual(samba.SuperClass, []string{"top"}) ||
		!reflect.DeepEqual(samba.Must, []string{"cn", "objectClass"}) || len(samba.May) != 3 {
		t.Fatalf("person = %+v", samba)
	}
	aux := parseObjectClass(`( 1.3.6.1.1.1.2.0 NAME 'posixAccount' DESC 'Abstraction of an account with POSIX attributes' SUP top AUXILIARY MUST ( cn $ uid $ uidNumber $ gidNumber $ homeDirectory ) MAY ( userPassword $ loginShell $ gecos $ description ) )`)
	if aux.Kind != "auxiliary" || len(aux.Must) != 5 || aux.Must[4] != "homeDirectory" {
		t.Fatalf("posixAccount = %+v", aux)
	}
	multi := parseObjectClass(`( 2.16.840.1.113730.3.2.2 NAME 'inetOrgPerson' SUP organizationalPerson STRUCTURAL MAY 'audio' )`)
	if !reflect.DeepEqual(multi.May, []string{"audio"}) || multi.Must != nil {
		t.Fatalf("inetOrgPerson = %+v", multi)
	}
	abs := parseObjectClass(`( 2.5.6.0 NAME 'top' ABSTRACT MUST objectClass )`)
	if abs.Kind != "abstract" || !reflect.DeepEqual(abs.Must, []string{"objectClass"}) {
		t.Fatalf("top = %+v", abs)
	}
	// A keyword word inside DESC does not change the kind.
	desc := parseObjectClass(`( 1.2.3 NAME 'x' DESC 'not ABSTRACT nor AUXILIARY' SUP top STRUCTURAL )`)
	if desc.Kind != "structural" || desc.Description != "not ABSTRACT nor AUXILIARY" {
		t.Fatalf("desc keywords = %+v", desc)
	}
	if parseObjectClass(`garbage`) != nil || parseObjectClass(`( 1.2.3 DESC 'no name' )`) != nil {
		t.Fatal("invalid descriptions must give nil")
	}
}

// DEF-25: all NAMEs are kept, and references by alias or OID resolve to the
// primary name (cosine's account: MUST userid; pilotPerson: MAY rfc822Mailbox).
func TestResolveSchemaNamesAliases(t *testing.T) {
	schema := &models.SchemaInfo{}
	for _, raw := range []string{
		`( 2.5.6.0 NAME 'top' ABSTRACT MUST objectClass )`,
		`( 0.9.2342.19200300.100.4.4 NAME ( 'pilotPerson' 'newPilotPerson' ) SUP 2.5.6.0 STRUCTURAL MAY ( userid $ rfc822Mailbox $ mail $ 0.9.2342.19200300.100.1.20 ) )`,
		`( 0.9.2342.19200300.100.4.5 NAME 'account' SUP top STRUCTURAL MUST userid MAY host )`,
		`( 1.2.3.4 NAME 'pilotChild' SUP newPilotPerson AUXILIARY )`,
	} {
		schema.ObjectClasses = append(schema.ObjectClasses, *parseObjectClass(raw))
	}
	for _, raw := range []string{
		`( 2.5.4.41 NAME 'name' EQUALITY caseIgnoreMatch SYNTAX 1.3.6.1.4.1.1466.115.121.1.15{32768} )`,
		`( 0.9.2342.19200300.100.1.1 NAME ( 'uid' 'userid' ) SUP name )`,
		`( 0.9.2342.19200300.100.1.3 NAME ( 'mail' 'rfc822Mailbox' ) SYNTAX 1.3.6.1.4.1.1466.115.121.1.26 )`,
		`( 0.9.2342.19200300.100.1.20 NAME ( 'homePhone' 'homeTelephoneNumber' ) SYNTAX 1.3.6.1.4.1.1466.115.121.1.50 )`,
		`( 1.2.3.5 NAME 'nick' SUP userid )`,
	} {
		schema.Attributes = append(schema.Attributes, *parseAttributeType(raw))
	}
	resolveSchemaNames(schema)
	resolveAttributeInheritance(schema.Attributes)

	pilot := schema.FindObjectClass("newPilotPerson")
	if pilot == nil || pilot.Name != "pilotPerson" || !reflect.DeepEqual(pilot.Aliases, []string{"newPilotPerson"}) {
		t.Fatalf("class by alias: %+v", pilot)
	}
	if !reflect.DeepEqual(pilot.SuperClass, []string{"top"}) {
		t.Errorf("SUP by OID = %v, want [top]", pilot.SuperClass)
	}
	// rfc822Mailbox and mail are one type: listed once, by its name.
	if !reflect.DeepEqual(pilot.May, []string{"uid", "mail", "homePhone"}) {
		t.Errorf("pilotPerson MAY = %v", pilot.May)
	}
	if acc := schema.FindObjectClass("ACCOUNT"); acc == nil || !reflect.DeepEqual(acc.Must, []string{"uid"}) || !reflect.DeepEqual(acc.May, []string{"host"}) {
		t.Errorf("account = %+v (unknown names are kept)", acc)
	}
	if child := schema.FindObjectClass("pilotChild"); child == nil || !reflect.DeepEqual(child.SuperClass, []string{"pilotPerson"}) {
		t.Errorf("SUP by class alias: %+v", child)
	}
	nick := schema.FindAttribute("nick")
	if nick == nil || nick.SuperType != "uid" || nick.Equality != "caseIgnoreMatch" || nick.SyntaxName != "Directory String" {
		t.Errorf("SUP by alias, inherited rules: %+v", nick)
	}
	for _, n := range []string{"rfc822Mailbox", "RFC822MAILBOX", "0.9.2342.19200300.100.1.3", "mail;lang-de"} {
		if a := schema.FindAttribute(n); a == nil || a.Name != "mail" {
			t.Errorf("FindAttribute(%q) = %+v", n, a)
		}
	}
	if schema.AttributeName("surname") != "surname" || schema.AttributeName("userid") != "uid" {
		t.Errorf("AttributeName: unknown names stay, aliases resolve")
	}
}

// An alias never shadows the primary name of another type.
func TestResolveSchemaNamesPrimaryWins(t *testing.T) {
	schema := &models.SchemaInfo{
		Attributes: []models.SchemaAttribute{
			*parseAttributeType(`( 1.1 NAME ( 'a' 'b' ) )`),
			*parseAttributeType(`( 1.2 NAME 'b' )`),
		},
		ObjectClasses: []models.SchemaObjectClass{*parseObjectClass(`( 1.3 NAME 'x' MAY ( b $ a ) )`)},
	}
	resolveSchemaNames(schema)
	if got := schema.ObjectClasses[0].May; !reflect.DeepEqual(got, []string{"b", "a"}) {
		t.Fatalf("MAY = %v, want [b a]", got)
	}
	if a := schema.FindAttribute("b"); a == nil || a.OID != "1.2" {
		t.Fatalf("FindAttribute(b) = %+v, want the type named b", a)
	}
}
