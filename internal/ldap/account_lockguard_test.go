package ldap

import (
	"testing"

	"github.com/dpicillo/LDAPilot/internal/models"
)

func TestChangesClearPermanentLock(t *testing.T) {
	c := func(op, attr string) models.AttributeChange {
		return models.AttributeChange{Operation: op, Attribute: attr}
	}
	for name, tc := range map[string]struct {
		changes []models.AttributeChange
		want    bool
	}{
		"replace userPassword":        {[]models.AttributeChange{c("replace", "userPassword")}, true},
		"delete userpassword":         {[]models.AttributeChange{c("delete", "userpassword")}, true},
		"add with option":             {[]models.AttributeChange{c("add", "userPassword;binary")}, true},
		"authPassword":                {[]models.AttributeChange{c("replace", "authPassword")}, true},
		"with other attributes":       {[]models.AttributeChange{c("replace", "mail"), c("replace", "userPassword")}, true},
		"explicit enable":             {[]models.AttributeChange{c("replace", "userPassword"), c("delete", "pwdAccountLockedTime")}, false},
		"explicit disable":            {[]models.AttributeChange{c("replace", "pwdAccountLockedTime"), c("replace", "userPassword")}, false},
		"no password":                 {[]models.AttributeChange{c("replace", "description")}, false},
		"unicodePwd (AD, no ppolicy)": {[]models.AttributeChange{c("replace", "unicodePwd")}, false},
		"empty":                       {nil, false},
	} {
		if got := ChangesClearPermanentLock(tc.changes); got != tc.want {
			t.Errorf("%s: got %v, want %v", name, got, tc.want)
		}
	}
	var g *PermanentLockGuard
	if g.Disabled() || g.Restore() != nil || (&PermanentLockGuard{}).Restore() != nil {
		t.Error("nil/zero guards must do nothing")
	}
}
