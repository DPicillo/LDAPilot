package ldaptools

import "strings"

// FilterProblem locates the first problem of an invalid filter for the
// common mistakes (§5.2 validate_filter). ok is false when the problem
// cannot be located; position is a 0-based rune index.
func FilterProblem(filter string) (position int, hint string, ok bool) {
	r := []rune(filter)
	if strings.Contains(filter, "!=") {
		i := strings.Index(filter, "!=")
		return len([]rune(filter[:i])), "LDAP has no != operator; write (!(attr=value)) instead.", true
	}
	depth := 0
	inValue := false // after the comparison operator, until the closing ')'
	compStart := -1
	sawOp := false
	for i := 0; i < len(r); i++ {
		c := r[i]
		switch {
		case c == '\\':
			if i+2 >= len(r) || !isHex(r[i+1]) || !isHex(r[i+2]) {
				return i, `A backslash must be followed by two hex digits (\2a for *, \28 for (, \29 for ), \5c for \).`, true
			}
			i += 2
		case c == '(':
			if inValue {
				return i, `Unescaped "(" inside a value; write \28.`, true
			}
			depth++
			compStart = i
			sawOp = false
			if i+1 < len(r) && r[i+1] == ')' {
				return i, "Empty filter component ().", true
			}
		case c == ')':
			if depth == 0 {
				return i, "Unbalanced parentheses: there is a ')' without a matching '('.", true
			}
			if compStart >= 0 && !sawOp && !isCompositeStart(r, compStart) {
				return compStart, "Missing comparison operator (=, >=, <=, ~= or :=) in this component.", true
			}
			depth--
			inValue = false
			compStart = -1
		case c == '=' || (c == '>' || c == '<' || c == '~') && i+1 < len(r) && r[i+1] == '=':
			if compStart >= 0 && !inValue {
				sawOp = true
				inValue = true
				if c != '=' {
					i++
				}
			}
		}
	}
	if depth > 0 {
		return len(r), "Unbalanced parentheses: a '(' is not closed.", true
	}
	return 0, "", false
}

func isCompositeStart(r []rune, open int) bool {
	if open+1 >= len(r) {
		return false
	}
	switch r[open+1] {
	case '&', '|', '!':
		return true
	}
	return false
}

func isHex(c rune) bool {
	return c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F'
}
