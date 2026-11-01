package ldap

import (
	"bytes"
	"encoding/pem"
	"errors"
	"fmt"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/models"
)

// PKCS #7 / CMS support for userSMIMECertificate, which RFC 2798 (9.1.4)
// defines as PKCS #7 SignedData: Outlook and Exchange publish the user's
// S/MIME certificates (plus the signing capabilities) in this form. The
// structure is read with a small BER walker because such blobs may use
// indefinite lengths, which encoding/asn1 (DER only) rejects; the embedded
// certificates themselves are DER and parsed by crypto/x509.

// oidPKCS7SignedDataDER is the DER content of OID 1.2.840.113549.1.7.2.
var oidPKCS7SignedDataDER = []byte{0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x07, 0x02}

// binaryBERMaxDepth bounds the nesting the BER walker follows.
const binaryBERMaxDepth = 32

// binaryBERElement is one BER TLV. For a constructed element of indefinite
// length, content holds the encoded children without the end-of-contents
// marker, so children are read from content the same way in both cases.
type binaryBERElement struct {
	class       byte // 0 universal, 1 application, 2 context-specific, 3 private
	constructed bool
	tag         int
	content     []byte
	full        []byte
}

// binaryReadBER reads one BER element from data and returns it with the
// bytes that follow it.
func binaryReadBER(data []byte, depth int) (binaryBERElement, []byte, error) {
	var el binaryBERElement
	if depth > binaryBERMaxDepth {
		return el, nil, errors.New("BER nesting too deep")
	}
	if len(data) < 2 {
		return el, nil, errors.New("truncated BER element")
	}
	el.class = data[0] >> 6
	el.constructed = data[0]&0x20 != 0
	el.tag = int(data[0] & 0x1F)
	i := 1
	if el.tag == 0x1F { // high tag number form
		el.tag = 0
		for {
			if i >= len(data) || i > 5 {
				return el, nil, errors.New("invalid BER tag")
			}
			b := data[i]
			i++
			el.tag = el.tag<<7 | int(b&0x7F)
			if b&0x80 == 0 {
				break
			}
		}
	}
	if i >= len(data) {
		return el, nil, errors.New("truncated BER length")
	}
	lb := data[i]
	i++
	if lb == 0x80 { // indefinite length: children up to an end-of-contents marker
		if !el.constructed {
			return el, nil, errors.New("indefinite length on a primitive BER element")
		}
		start := i
		rest := data[i:]
		for {
			if len(rest) >= 2 && rest[0] == 0 && rest[1] == 0 {
				end := len(data) - len(rest)
				el.content = data[start:end]
				el.full = data[:end+2]
				return el, rest[2:], nil
			}
			var err error
			if _, rest, err = binaryReadBER(rest, depth+1); err != nil {
				return el, nil, err
			}
		}
	}
	length := int(lb)
	if lb&0x80 != 0 {
		n := int(lb & 0x7F)
		if n > 4 || i+n > len(data) {
			return el, nil, errors.New("invalid BER length")
		}
		length = 0
		for _, b := range data[i : i+n] {
			length = length<<8 | int(b)
		}
		i += n
	}
	if length < 0 || length > len(data)-i {
		return el, nil, errors.New("truncated BER element")
	}
	el.content = data[i : i+length]
	el.full = data[:i+length]
	return el, data[i+length:], nil
}

// binaryBERChildren returns the elements inside a constructed element.
func binaryBERChildren(el binaryBERElement, depth int) ([]binaryBERElement, error) {
	if !el.constructed {
		return nil, errors.New("expected a constructed BER element")
	}
	var out []binaryBERElement
	rest := el.content
	for len(rest) > 0 {
		child, r, err := binaryReadBER(rest, depth+1)
		if err != nil {
			return nil, err
		}
		out = append(out, child)
		rest = r
	}
	return out, nil
}

// binaryPKCS7SignedData returns the SignedData element of a PKCS #7
// ContentInfo, or an error if data is not PKCS #7 SignedData.
func binaryPKCS7SignedData(data []byte) (binaryBERElement, error) {
	var none binaryBERElement
	top, rest, err := binaryReadBER(data, 0)
	if err != nil {
		return none, err
	}
	if len(bytes.Trim(rest, "\x00")) > 0 {
		return none, errors.New("trailing data after the PKCS #7 structure")
	}
	if top.class != 0 || top.tag != 16 || !top.constructed {
		return none, errors.New("not a PKCS #7 ContentInfo")
	}
	parts, err := binaryBERChildren(top, 0)
	if err != nil {
		return none, err
	}
	if len(parts) < 2 || parts[0].class != 0 || parts[0].tag != 6 {
		return none, errors.New("not a PKCS #7 ContentInfo")
	}
	if !bytes.Equal(parts[0].content, oidPKCS7SignedDataDER) {
		return none, errors.New("PKCS #7 content is not SignedData")
	}
	// content [0] EXPLICIT SignedData
	if parts[1].class != 2 || parts[1].tag != 0 {
		return none, errors.New("PKCS #7 SignedData has no content")
	}
	inner, err := binaryBERChildren(parts[1], 1)
	if err != nil {
		return none, err
	}
	if len(inner) != 1 || inner[0].class != 0 || inner[0].tag != 16 || !inner[0].constructed {
		return none, errors.New("malformed PKCS #7 SignedData")
	}
	return inner[0], nil
}

// IsPKCS7SignedData reports whether data is a BER/DER PKCS #7 (CMS)
// SignedData structure.
func IsPKCS7SignedData(data []byte) bool {
	if len(data) == 0 || data[0] != 0x30 {
		return false
	}
	_, err := binaryPKCS7SignedData(data)
	return err == nil
}

// binaryPEMPKCS7Types are the PEM labels of PKCS #7 / CMS data.
var binaryPEMPKCS7Types = map[string]bool{"PKCS7": true, "PKCS #7 SIGNED DATA": true, "CMS": true}

// ParsePKCS7Value returns the BER bytes of PKCS #7 SignedData given as
// BER/DER or as PEM text ("-----BEGIN PKCS7-----", also CMS).
func ParsePKCS7Value(data []byte) ([]byte, error) {
	if IsPKCS7SignedData(data) {
		return data, nil
	}
	if !bytes.Contains(data, []byte("-----BEGIN")) {
		return nil, errors.New("not PKCS #7 SignedData")
	}
	rest := data
	for {
		var block *pem.Block
		block, rest = pem.Decode(rest)
		if block == nil {
			return nil, errors.New("not PKCS #7 SignedData: the PEM data holds no PKCS7 block")
		}
		if !binaryPEMPKCS7Types[block.Type] {
			continue
		}
		if !IsPKCS7SignedData(block.Bytes) {
			return nil, errors.New("the PEM PKCS7 block is not PKCS #7 SignedData")
		}
		return block.Bytes, nil
	}
}

// DescribePKCS7 summarizes PKCS #7 SignedData (BER/DER or PEM): the
// embedded certificates and the number of signers.
func DescribePKCS7(data []byte) (*models.PKCS7Summary, error) {
	ber, err := ParsePKCS7Value(data)
	if err != nil {
		return nil, err
	}
	sd, err := binaryPKCS7SignedData(ber)
	if err != nil {
		return nil, err
	}
	fields, err := binaryBERChildren(sd, 2)
	if err != nil {
		return nil, fmt.Errorf("malformed PKCS #7 SignedData: %w", err)
	}
	// version, digestAlgorithms, encapContentInfo, [0] certificates,
	// [1] crls, signerInfos
	if len(fields) < 4 || fields[0].tag != 2 || fields[1].tag != 17 || fields[2].tag != 16 {
		return nil, errors.New("malformed PKCS #7 SignedData")
	}
	summary := &models.PKCS7Summary{
		ContentType:  "signedData",
		Version:      binaryBERInt(fields[0].content),
		Certificates: []models.CertificateSummary{},
		Size:         len(ber),
	}
	if encap, err := binaryBERChildren(fields[2], 3); err == nil && len(encap) > 0 && encap[0].tag == 6 {
		summary.EncapsulatedContentType = binaryOIDString(encap[0].content)
		summary.Detached = len(encap) < 2
	}
	for _, f := range fields[3:] {
		switch {
		case f.class == 2 && f.tag == 0: // certificates [0] IMPLICIT
			certs, err := binaryBERChildren(f, 3)
			if err != nil {
				return nil, fmt.Errorf("malformed PKCS #7 certificate set: %w", err)
			}
			for _, c := range certs {
				if c.class != 0 || c.tag != 16 { // attribute certificates etc.
					summary.OtherCertificates++
					continue
				}
				info, err := DescribeCertificate(c.full)
				if err != nil {
					summary.OtherCertificates++
					continue
				}
				summary.Certificates = append(summary.Certificates, *info)
			}
		case f.class == 2 && f.tag == 1: // crls [1] IMPLICIT
			if crls, err := binaryBERChildren(f, 3); err == nil {
				summary.CRLCount = len(crls)
			}
		case f.class == 0 && f.tag == 17: // signerInfos
			if signers, err := binaryBERChildren(f, 3); err == nil {
				summary.SignerCount = len(signers)
			}
		}
	}
	return summary, nil
}

// binaryBERInt decodes a small non-negative INTEGER (0 if it does not fit).
func binaryBERInt(b []byte) int {
	if len(b) == 0 || len(b) > 4 || b[0]&0x80 != 0 {
		return 0
	}
	n := 0
	for _, x := range b {
		n = n<<8 | int(x)
	}
	return n
}

// binaryOIDString renders the content bytes of an OBJECT IDENTIFIER in dotted
// form ("1.2.840.113549.1.7.1"), or "" if malformed.
func binaryOIDString(b []byte) string {
	if len(b) == 0 {
		return ""
	}
	var arcs []string
	v := 0
	first := true
	for i, x := range b {
		if v > 1<<24 {
			return ""
		}
		v = v<<7 | int(x&0x7F)
		if x&0x80 != 0 {
			if i == len(b)-1 {
				return ""
			}
			continue
		}
		if first {
			switch {
			case v < 40:
				arcs = append(arcs, "0", fmt.Sprint(v))
			case v < 80:
				arcs = append(arcs, "1", fmt.Sprint(v-40))
			default:
				arcs = append(arcs, "2", fmt.Sprint(v-80))
			}
			first = false
		} else {
			arcs = append(arcs, fmt.Sprint(v))
		}
		v = 0
	}
	return strings.Join(arcs, ".")
}
