package services

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/chatstore"
	"github.com/dpicillo/LDAPilot/internal/ai/ldaptools"
	"github.com/dpicillo/LDAPilot/internal/config"
)

// The AI redaction is a superset of the audit masking, except for the
// documented metadata exceptions (§6.5).
func TestRedactionSupersetOfAuditMasking(t *testing.T) {
	corpus := []string{"userPassword", "unicodePwd", "authPassword", "ms-Mcs-AdmPwd", "msLAPS-Password", "msLAPS-EncryptedPassword",
		"msLAPS-EncryptedDSRMPassword", "msLAPS-PasswordExpirationTime", "msDS-ManagedPassword", "msDS-ManagedPasswordId", "sambaNTPassword",
		"sambaLMPassword", "sambaPasswordHistory", "unixUserPassword", "userPKCS12", "supplementalCredentials", "dBCSPwd", "ntPwdHistory",
		"lmPwdHistory", "pwdHistory", "passwordHistory", "msFVE-RecoveryPassword", "msFVE-KeyPackage", "msTPM-OwnerInformation",
		"msTPM-OwnerInformationTemp", "krbPrincipalKey", "krbMKey", "krb5Key", "ipaNTHash", "olcRootPW", "nsslapd-rootpw", "rootpw",
		"pwdLastSet", "pwdChangedTime", "pwdReset", "pwdAccountLockedTime", "pwdFailureTime", "pwdPolicySubentry", "pwdGraceUseTime",
		"pwdLastSuccess", "passwordExpirationTime", "passwordRetryCount", "passwordGraceUserTime", "msDS-UserPasswordExpiryTimeComputed",
		"pwdHistoryLength", "msDS-PasswordHistoryLength", "badPwdCount", "badPasswordTime", "sharedSecret", "clientSecret", "cn", "mail",
		"description", "member", "memberOf", "userAccountControl", "lockoutTime", "nsds5ReplicaCredentials", "secretary", "telephoneNumber",
		"sAMAccountName", "userPrincipalName", "objectSid", "objectGUID", "accountExpires", "givenName", "sn", "displayName", "manager"}
	r := ldaptools.NewRedactor(ldaptools.RedactPolicy{Extra: isSensitiveAttribute}, nil)
	for _, n := range corpus {
		if isSensitiveAttribute(n) && !ldaptools.IsNeverRedacted(n) && !r.IsSecret(n) {
			t.Errorf("%s is masked in the audit but readable by the AI", n)
		}
	}
	for _, n := range []string{"krb5Key", "ipaNTHash", "nsds5ReplicaCredentials", "fooPrivateKey"} {
		if !r.IsSecret(n) {
			t.Errorf("%s not secret", n)
		}
	}
}

func TestFacadeInvalidIDs(t *testing.T) {
	s, _ := newTestAIService(t)
	for _, id := range []string{"../connections", `..\connections`, "", "a/b", "ABCDEF00-0000-4000-8000-000000000000", "00000000-0000-4000-8000-000000000001.json", " 00000000-0000-4000-8000-000000000001", "/etc/passwd"} {
		if _, err := s.GetChat(id); !errors.Is(err, chatstore.ErrInvalidChatID) || !strings.HasPrefix(err.Error(), "invalid_chat_id") {
			t.Errorf("GetChat(%q): %v", id, err)
		}
		if err := s.RenameChat(id, "x"); !errors.Is(err, chatstore.ErrInvalidChatID) {
			t.Errorf("RenameChat(%q): %v", id, err)
		}
		if _, err := s.SendMessage(ai.SendRequest{ChatID: id, Text: "x"}); !errors.Is(err, chatstore.ErrInvalidChatID) {
			t.Errorf("SendMessage(%q): %v", id, err)
		}
	}
}

func TestFacadeChatLifecycle(t *testing.T) {
	s, _ := newTestAIService(t)
	c, err := s.CreateChat("")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.RenameChat(c.ID, "Renamed"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetChatModel(c.ID, "other-model"); err != nil {
		t.Fatal(err)
	}
	v, err := s.GetChat(c.ID)
	if err != nil || v.Title != "Renamed" || v.ModelOverride != "other-model" || v.Messages == nil {
		t.Fatalf("%+v %v", v, err)
	}
	list, _ := s.ListChats()
	if len(list) != 1 {
		t.Fatal(list)
	}
	// No provider configured: the run fails with config_missing (persisted, not a facade error).
	if _, err := s.SendMessage(ai.SendRequest{ChatID: c.ID, Text: "hello"}); err != nil {
		t.Fatal(err)
	}
	s.mgr.Wait(c.ID, 5e9)
	msgs, _ := s.GetMessages(c.ID, "")
	// The error is stored on a marker answer, so it survives a reload and
	// the next message does not follow the user message directly.
	if len(msgs) != 2 || msgs[0].Role != ai.RoleUser || msgs[1].Role != ai.RoleAssistant || msgs[1].Error == nil ||
		msgs[1].Error.Code != ai.CodeConfigMissing || msgs[1].Blocks[0].Meta == nil || msgs[1].Blocks[0].Meta.Kind != "error" {
		t.Fatalf("%+v", msgs)
	}
	md, err := s.ExportChatMarkdown(c.ID)
	if err != nil || !strings.Contains(md, "hello") || strings.Contains(md, "ldapilot_context") {
		t.Fatalf("export: %v\n%s", err, md)
	}
	if err := s.DeleteChat(c.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetChat(c.ID); err == nil {
		t.Fatal("deleted chat still readable")
	}
}

func TestSetConnectionAccessBindsRemoteHost(t *testing.T) {
	s, store := newTestAIService(t)
	cfg := store.GetMasked()
	cfg.Provider, cfg.Flavor, cfg.URL, cfg.APIKey, cfg.Model = "openai", "openai", "https://api.openai.com/v1", "k", "gpt-x"
	if err := s.SaveAIConfig(cfg); err != nil {
		t.Fatal(err)
	}
	if err := s.SetConnectionAccess("p1", "read"); err != nil {
		t.Fatal(err)
	}
	got := store.Get().ConnectionAccess["p1"]
	if got.Level != "read" || len(got.Hosts) != 1 || got.Hosts[0] != "api.openai.com" {
		t.Fatalf("%+v", got)
	}
	if err := s.SetConnectionAccess("p1", "bogus"); err == nil {
		t.Fatal("invalid level accepted")
	}
}

func TestDegradedStore(t *testing.T) {
	base := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", base)
	store, _ := config.OpenAIConfigStore(filepath.Join(base, "ai_config.json"))
	s := NewAIService(nil, store, nil)
	if _, err := s.ListChats(); err == nil || !strings.HasPrefix(err.Error(), ai.CodeStoreUnavailable) {
		t.Fatalf("%v", err)
	}
	if got := s.GetAIConfig(); got.Version != 2 {
		t.Fatal("settings unavailable in degraded mode")
	}
}
