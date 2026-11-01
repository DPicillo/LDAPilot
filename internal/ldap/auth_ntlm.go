package ldap

import (
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"

	ntlmssp "github.com/Azure/go-ntlmssp"
	"github.com/dpicillo/LDAPilot/internal/models"
	ber "github.com/go-asn1-ber/asn1-ber"
	goldap "github.com/go-ldap/ldap/v3"
)

// NTLM binds come in two flavours: Active Directory implements the
// Microsoft "Sicily" NTLM bind (go-ldap's NTLMBind), Samba does not and
// offers the SASL mechanism "NTLM" (raw NTLMSSP tokens) instead. go-ldap can
// send neither generic SASL binds nor raw requests, so dialServerNTLM runs
// the connection setup (TLS, StartTLS) and a RootDSE query itself and, if
// the server offers SASL NTLM, also the bind, before it hands the socket to
// go-ldap. Otherwise bindConnHost performs the Sicily bind as usual.

// ntlmSASLMechanism is the SASL mechanism name of NTLM (Samba).
const ntlmSASLMechanism = "NTLM"

// preBound holds the bind summary of connections dialServerNTLM already
// authenticated; bindConnHost consumes the entry instead of binding again.
// Every dialServer caller binds the connection right after dialing.
var preBound sync.Map // *goldap.Conn -> string

// preBindError is a bind failure during dialServerNTLM.
type preBindError struct {
	summary string
	err     error
}

func (e *preBindError) Error() string { return e.err.Error() }
func (e *preBindError) Unwrap() error { return e.err }

// dialServerNTLM is dialServerTLS for a profile using NTLM.
func dialServerNTLM(profile models.ConnectionProfile, host, port string, tlsMode models.TLSMode) (*goldap.Conn, *tlsOutcome, error) {
	timeout := profileTimeout(profile)
	address := net.JoinHostPort(host, port)
	var tlsConfig *tls.Config
	var out *tlsOutcome
	useTLS := tlsMode == models.TLSSSL || tlsMode == models.TLSStartTLS
	if useTLS {
		var err error
		if tlsConfig, out, err = buildTLSConfig(profile, host); err != nil {
			return nil, nil, err
		}
	}
	tlsFailure := func(err error) error {
		if out != nil && out.certErr != nil {
			return out.certErr
		}
		return goldap.NewError(goldap.ErrorNetwork, fmt.Errorf("TLS handshake failed (%v)", err))
	}

	raw, err := (&net.Dialer{Timeout: timeout}).Dial("tcp", address)
	if err != nil {
		return nil, out, goldap.NewError(goldap.ErrorNetwork, err)
	}
	// The deadline bounds the whole setup including the bind.
	_ = raw.SetDeadline(time.Now().Add(timeout))
	x := &rawLDAP{conn: raw}
	fail := func(err error) (*goldap.Conn, *tlsOutcome, error) {
		_ = x.conn.Close()
		return nil, out, err
	}

	if tlsMode == models.TLSStartTLS {
		if err := x.startTLS(); err != nil {
			return fail(fmt.Errorf("StartTLS failed: %w", err))
		}
	}
	if useTLS {
		tc := tls.Client(raw, tlsConfig)
		if err := tc.Handshake(); err != nil {
			_ = raw.Close()
			return nil, out, tlsFailure(err)
		}
		x.conn = tc
	}

	mechs, err := x.rootDSESASLMechanisms()
	var ldapErr *goldap.Error
	if err != nil && (!errors.As(err, &ldapErr) || ldapErr.ResultCode >= goldap.ErrorNetwork) {
		return fail(err)
	}
	// A server refusing the anonymous RootDSE read gets the Sicily bind.
	var summary string
	if containsFold(mechs, ntlmSASLMechanism) {
		domain, user := ntlmCredentials(profile.BindDN, profile.NTLMDomain)
		summary = "NTLM (SASL) as " + user
		if user == "" || profile.Password == "" {
			// Reported by bindConnHost with the usual message.
			summary = ""
		} else if err := x.saslNTLMBind(domain, user, profile.Password); err != nil {
			return fail(&preBindError{summary: summary, err: err})
		}
	}

	_ = raw.SetDeadline(time.Time{})
	conn := goldap.NewConn(x.conn, useTLS)
	conn.Start()
	conn.SetTimeout(timeout)
	if summary != "" {
		preBound.Store(conn, summary)
	}
	return conn, out, nil
}

// takePreBound returns the bind summary of a connection dialServerNTLM
// already authenticated.
func takePreBound(conn *goldap.Conn) (string, bool) {
	v, ok := preBound.LoadAndDelete(conn)
	if !ok {
		return "", false
	}
	return v.(string), true
}

func containsFold(list []string, s string) bool {
	for _, v := range list {
		if strings.EqualFold(v, s) {
			return true
		}
	}
	return false
}

// rawLDAP speaks the few LDAP operations needed before go-ldap takes over
// the socket. Message IDs restart in go-ldap afterwards, which is allowed as
// all requests sent here are complete.
type rawLDAP struct {
	conn  net.Conn
	msgID int64
}

// roundTrip sends op and passes every response packet to handle until it
// reports done.
func (x *rawLDAP) roundTrip(op *ber.Packet, handle func(p *ber.Packet) (bool, error)) error {
	x.msgID++
	env := ber.Encode(ber.ClassUniversal, ber.TypeConstructed, ber.TagSequence, nil, "LDAP Request")
	env.AppendChild(ber.NewInteger(ber.ClassUniversal, ber.TypePrimitive, ber.TagInteger, x.msgID, "MessageID"))
	env.AppendChild(op)
	if _, err := x.conn.Write(env.Bytes()); err != nil {
		return goldap.NewError(goldap.ErrorNetwork, fmt.Errorf("unable to send request: %w", err))
	}
	for {
		p, err := ber.ReadPacket(x.conn)
		if err != nil {
			return goldap.NewError(goldap.ErrorNetwork, fmt.Errorf("unable to read LDAP response packet: %w", err))
		}
		if len(p.Children) < 2 {
			return goldap.NewError(goldap.ErrorUnexpectedResponse, errors.New("malformed LDAP response"))
		}
		if id, ok := p.Children[0].Value.(int64); ok && id == 0 {
			// Notice of disconnection.
			if err := goldap.GetLDAPError(p); err != nil {
				return err
			}
			return goldap.NewError(goldap.ErrorNetwork, errors.New("server closed the connection"))
		}
		done, err := handle(p)
		if err != nil || done {
			return err
		}
	}
}

// startTLS sends the StartTLS extended operation.
func (x *rawLDAP) startTLS() error {
	op := ber.Encode(ber.ClassApplication, ber.TypeConstructed, goldap.ApplicationExtendedRequest, nil, "Start TLS")
	op.AppendChild(ber.NewString(ber.ClassContext, ber.TypePrimitive, 0, "1.3.6.1.4.1.1466.20037", "TLS Extended Command"))
	return x.roundTrip(op, func(p *ber.Packet) (bool, error) {
		return true, goldap.GetLDAPError(p)
	})
}

// rootDSESASLMechanisms reads supportedSASLMechanisms from the RootDSE
// (anonymously, before any bind).
func (x *rawLDAP) rootDSESASLMechanisms() ([]string, error) {
	op := ber.Encode(ber.ClassApplication, ber.TypeConstructed, goldap.ApplicationSearchRequest, nil, "Search Request")
	op.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, "", "Base DN"))
	op.AppendChild(ber.NewInteger(ber.ClassUniversal, ber.TypePrimitive, ber.TagEnumerated, uint64(goldap.ScopeBaseObject), "Scope"))
	op.AppendChild(ber.NewInteger(ber.ClassUniversal, ber.TypePrimitive, ber.TagEnumerated, uint64(goldap.NeverDerefAliases), "Deref Aliases"))
	op.AppendChild(ber.NewInteger(ber.ClassUniversal, ber.TypePrimitive, ber.TagInteger, uint64(0), "Size Limit"))
	op.AppendChild(ber.NewInteger(ber.ClassUniversal, ber.TypePrimitive, ber.TagInteger, uint64(0), "Time Limit"))
	op.AppendChild(ber.NewBoolean(ber.ClassUniversal, ber.TypePrimitive, ber.TagBoolean, false, "Types Only"))
	filter, err := goldap.CompileFilter("(objectClass=*)")
	if err != nil {
		return nil, err
	}
	op.AppendChild(filter)
	attrs := ber.Encode(ber.ClassUniversal, ber.TypeConstructed, ber.TagSequence, nil, "Attributes")
	attrs.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, "supportedSASLMechanisms", "Attribute"))
	op.AppendChild(attrs)

	var mechs []string
	err = x.roundTrip(op, func(p *ber.Packet) (bool, error) {
		res := p.Children[1]
		switch res.Tag {
		case goldap.ApplicationSearchResultEntry:
			if len(res.Children) < 2 {
				return false, nil
			}
			for _, attr := range res.Children[1].Children {
				if len(attr.Children) < 2 || !strings.EqualFold(packetText(attr.Children[0]), "supportedSASLMechanisms") {
					continue
				}
				for _, v := range attr.Children[1].Children {
					mechs = append(mechs, packetText(v))
				}
			}
			return false, nil
		case goldap.ApplicationSearchResultDone:
			return true, goldap.GetLDAPError(p)
		}
		return false, nil // references and intermediate responses
	})
	return mechs, err
}

// saslNTLMBind performs a SASL "NTLM" bind with raw NTLMSSP tokens.
func (x *rawLDAP) saslNTLMBind(domain, user, password string) error {
	negotiate, err := ntlmssp.NewNegotiateMessage(domain, "")
	if err != nil {
		return fmt.Errorf("NTLM negotiate message: %v", err)
	}
	code, challenge, err := x.saslBind(ntlmSASLMechanism, negotiate)
	if err != nil {
		return err
	}
	if code != goldap.LDAPResultSaslBindInProgress || len(challenge) == 0 {
		return goldap.NewError(goldap.ErrorUnexpectedResponse, fmt.Errorf("NTLM: expected a challenge, got result code %d", code))
	}
	authenticate, err := ntlmssp.NewAuthenticateMessage(challenge, user, password, nil)
	if err != nil {
		return fmt.Errorf("NTLM authenticate message: %v", err)
	}
	code, _, err = x.saslBind(ntlmSASLMechanism, authenticate)
	if err != nil {
		return err
	}
	if code != goldap.LDAPResultSuccess {
		return goldap.NewError(uint16(code), fmt.Errorf("unexpected result code %d", code))
	}
	return nil
}

// saslBind sends one SASL bind request and returns the result code and the
// server's SASL credentials. Result codes other than success and
// saslBindInProgress are returned as *goldap.Error.
func (x *rawLDAP) saslBind(mech string, creds []byte) (uint16, []byte, error) {
	op := ber.Encode(ber.ClassApplication, ber.TypeConstructed, goldap.ApplicationBindRequest, nil, "Bind Request")
	op.AppendChild(ber.NewInteger(ber.ClassUniversal, ber.TypePrimitive, ber.TagInteger, 3, "Version"))
	op.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, "", "User Name"))
	auth := ber.Encode(ber.ClassContext, ber.TypeConstructed, 3, "", "authentication")
	auth.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, mech, "SASL Mech"))
	auth.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, string(creds), "Credentials"))
	op.AppendChild(auth)

	var code uint16
	var serverCreds []byte
	err := x.roundTrip(op, func(p *ber.Packet) (bool, error) {
		res := p.Children[1]
		if res.Tag != goldap.ApplicationBindResponse || len(res.Children) < 3 {
			return true, goldap.NewError(goldap.ErrorUnexpectedResponse, errors.New("unexpected response to the bind request"))
		}
		c, ok := res.Children[0].Value.(int64)
		if !ok {
			return true, goldap.NewError(goldap.ErrorUnexpectedResponse, errors.New("invalid bind result code"))
		}
		code = uint16(c)
		for _, child := range res.Children[3:] {
			if child.ClassType == ber.ClassContext && child.Tag == 7 {
				serverCreds = packetBytes(child)
			}
		}
		if code != goldap.LDAPResultSuccess && code != goldap.LDAPResultSaslBindInProgress {
			return true, goldap.GetLDAPError(p)
		}
		return true, nil
	})
	return code, serverCreds, err
}

// packetBytes returns the content octets of a primitive packet.
func packetBytes(p *ber.Packet) []byte {
	if p.Data != nil && p.Data.Len() > 0 {
		return p.Data.Bytes()
	}
	return p.ByteValue
}

// packetText returns the content of an octet string packet.
func packetText(p *ber.Packet) string {
	if s, ok := p.Value.(string); ok {
		return s
	}
	return string(packetBytes(p))
}
