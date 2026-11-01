package services

import (
	"testing"

	"github.com/dpicillo/LDAPilot/internal/models"
)

// DEF-25: required checks and class lookups accept aliases.
func TestSchemaServiceAliases(t *testing.T) {
	s := NewSchemaService(nil)
	s.cache["p"] = &models.SchemaInfo{
		ObjectClasses: []models.SchemaObjectClass{
			{Name: "top", Kind: "abstract", Must: []string{"objectClass"}},
			{Name: "person", OID: "2.5.6.6", Kind: "structural", SuperClass: []string{"top"}, Must: []string{"sn", "cn"}},
			{Name: "pilotPerson", Aliases: []string{"newPilotPerson"}, Kind: "structural", SuperClass: []string{"person"}, Must: []string{"uid"}},
		},
		Attributes: []models.SchemaAttribute{
			{Name: "sn", Aliases: []string{"surname"}},
			{Name: "cn", Aliases: []string{"commonName"}},
			{Name: "uid", Aliases: []string{"userid"}},
		},
	}
	if errs := s.ValidateEntry("p", []string{"newPilotPerson"}, map[string][]string{"surname": {"Doe"}, "commonName": {"Jo Doe"}, "userid": {"jdoe"}}); len(errs) != 0 {
		t.Fatalf("values under aliases: %+v", errs)
	}
	errs := s.ValidateEntry("p", []string{"2.5.6.6"}, map[string][]string{"cn": {"x"}})
	if len(errs) != 1 || errs[0].Attribute != "sn" {
		t.Fatalf("class by OID, missing sn: %+v", errs)
	}
	if oc, err := s.GetObjectClass("p", "NEWPILOTPERSON"); err != nil || oc.Name != "pilotPerson" {
		t.Fatalf("GetObjectClass by alias: %+v %v", oc, err)
	}
	if info, err := s.GetObjectClassDetails("p", "newPilotPerson"); err != nil || info.Name != "pilotPerson" {
		t.Fatalf("GetObjectClassDetails by alias: %+v %v", info, err)
	}
	req, err := s.GetRequiredAttributes("p", []string{"pilotPerson"})
	if err != nil || len(req) != 4 {
		t.Fatalf("required = %v %v", req, err)
	}
}
