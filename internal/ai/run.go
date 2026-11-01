package ai

// Run, approval and facade view types (§3.4, §3.5, §6.3).

// SendRequest is the argument of AIService.SendMessage.
type SendRequest struct {
	ChatID string    `json:"chatId"`
	Text   string    `json:"text"`
	UI     UIContext `json:"ui"`
}

// SendResult identifies the run a send started.
type SendResult struct {
	RunID         string `json:"runId"`
	UserMessageID string `json:"userMessageId"`
}

// Run kinds (ai:run_started.kind).
const (
	RunKindSend       = "send"
	RunKindContinue   = "continue"
	RunKindRegenerate = "regenerate"
	RunKindEdit       = "edit"
	RunKindCompact    = "compact"
)

// Run statuses (RunSnapshot.Status and ai:done.status).
const (
	RunQueued           = "queued"
	RunRunning          = "running"
	RunAwaitingApproval = "awaiting_approval"
	RunCompleted        = "completed"
	RunCancelled        = "cancelled"
	RunFailed           = "error"
	RunStepLimit        = "step_limit"
	RunTruncated        = "truncated"
	RunRefusal          = "refusal"
)

// RunSnapshot lets the UI re-sync with a running run.
type RunSnapshot struct {
	ChatID           string            `json:"chatId"`
	RunID            string            `json:"runId"`
	Status           string            `json:"status"`
	Kind             string            `json:"kind"`
	StartedAt        int64             `json:"startedAt"`
	LastSeq          int64             `json:"lastSeq"`
	BaseMessageID    string            `json:"baseMessageId"` // last persisted message before the run
	Messages         []Message         `json:"messages"`      // messages persisted by this run so far
	Partial          *Message          `json:"partial"`       // the streaming assistant message (text so far)
	PendingApprovals []ApprovalRequest `json:"pendingApprovals"`
	ToolStatus       map[string]string `json:"toolStatus"` // toolCallId → status
	Usage            *UsageEvent       `json:"usage"`
}

// ContextInfo describes the context budget of a chat (§7.7).
type ContextInfo struct {
	ContextWindow    int            `json:"contextWindow"`
	MaxOutput        int            `json:"maxOutput"`
	InputBudget      int            `json:"inputBudget"`
	FixedOverhead    int            `json:"fixedOverhead"`
	EstimatedTokens  int            `json:"estimatedTokens"`
	LastActualTokens int            `json:"lastActualTokens"`
	Percent          float64        `json:"percent"`
	AutoCompactAt    float64        `json:"autoCompactAt"`
	Compactions      int            `json:"compactions"`
	Breakdown        map[string]int `json:"breakdown"`
	WindowSource     string         `json:"windowSource"`
	Suspect          bool           `json:"suspect"`
	Model            string         `json:"model"`
	Provider         string         `json:"provider"`
}

// ApprovalResult is returned by RespondApproval.
type ApprovalResult struct {
	Status   string `json:"status"` // "applied" | "already_resolved"
	Decision string `json:"decision"`
	By       string `json:"by"`
}

// SecretValue is returned once by RevealSecret.
type SecretValue struct {
	Kind      string `json:"kind"`
	DN        string `json:"dn"`
	Value     string `json:"value"`
	ExpiresAt int64  `json:"expiresAt"`
}

// Grant is an "approve for this chat" permission (§6.3).
type Grant struct {
	ID              string   `json:"id"`
	Tool            string   `json:"tool"`
	ProfileID       string   `json:"profileId"`
	ConnectionLabel string   `json:"connectionLabel"`
	Scope           string   `json:"scope"` // human-readable description
	DNs             []string `json:"dns"`   // group DN for update_group_membership
	Subtree         string   `json:"subtree"`
	Attributes      []string `json:"attributes"`
	UsesLeft        int      `json:"usesLeft"`
	ExpiresAt       int64    `json:"expiresAt"`
}

// GrantScope is what "approve for this chat" would cover.
type GrantScope struct {
	Tool        string   `json:"tool"`
	ProfileID   string   `json:"profileId"`
	Subtree     string   `json:"subtree,omitempty"`
	GroupDN     string   `json:"groupDn,omitempty"`
	Attributes  []string `json:"attributes"`
	Action      string   `json:"action,omitempty"` // unlock | enable | disable
	MaxUses     int      `json:"maxUses"`
	DurationMin int      `json:"durationMin"`
	Description string   `json:"description"`
}

// Approval kinds and decisions (§6.3).
const (
	ApprovalWrite  = "write"
	ApprovalAccess = "access"

	DecisionApprove          = "approve"
	DecisionApproveChat      = "approve_chat"
	DecisionApproveConfirmed = "approve_confirmed"
	DecisionApproveAlways    = "approve_always"
	DecisionDeny             = "deny"
	DecisionDenyRemaining    = "deny_remaining"

	ResolvedApproved       = "approved"
	ResolvedApprovedChat   = "approved_chat"
	ResolvedApprovedAlways = "approved_always"
	ResolvedDenied         = "denied"
	ResolvedTimeout        = "timeout"
	ResolvedCancelled      = "cancelled"
	ResolvedPolicyDenied   = "policy_denied"

	ByUser    = "user"
	ByGrant   = "grant"
	ByPolicy  = "policy"
	ByTimeout = "timeout"
	ByRun     = "run"
)

// ApprovalConnection describes the directory of an approval request.
type ApprovalConnection struct {
	ProfileID     string `json:"profileId"`
	Label         string `json:"label"`
	ServerType    string `json:"serverType"`
	Host          string `json:"host"`
	Identity      string `json:"identity"`
	ReadOnly      bool   `json:"readOnly"`
	LocalProvider bool   `json:"localProvider"`
}

// ApprovalPosition is "1 of N" for the writes of one step.
type ApprovalPosition struct {
	Index int `json:"index"`
	Total int `json:"total"`
}

// ApprovalRequest is the payload of ai:approval_request.
type ApprovalRequest struct {
	Envelope
	ApprovalID       string             `json:"approvalId"`
	ToolCallID       string             `json:"toolCallId"`
	Kind             string             `json:"kind"` // write | access
	Tool             string             `json:"tool"`
	ToolDisplayName  string             `json:"toolDisplayName"`
	Connection       ApprovalConnection `json:"connection"`
	Position         ApprovalPosition   `json:"position"`
	Preview          *ChangePreview     `json:"preview,omitempty"`
	ProviderHost     string             `json:"providerHost,omitempty"`
	ProviderRemote   bool               `json:"providerRemote,omitempty"`
	AllowedDecisions []string           `json:"allowedDecisions"`
	RequireConfirm   bool               `json:"requireConfirm"`
	ExpiresAt        int64              `json:"expiresAt"`
	GrantsSuspended  bool               `json:"grantsSuspended,omitempty"` // "Auto-approval paused: …"
}

// ChangePreview is the exact change a write tool will run (§6.3).
type ChangePreview struct {
	Operation    string      `json:"operation"` // modify|create|rename|delete|group_membership|unlock|enable|disable|reset_password
	DN           string      `json:"dn"`
	NewDN        string      `json:"newDn,omitempty"`
	LDIF         string      `json:"ldif"`
	Changes      []AttrDiff  `json:"changes"`
	EntrySummary []AttrValue `json:"entrySummary,omitempty"`
	Risk         string      `json:"risk"` // medium | high
	RiskReasons  []string    `json:"riskReasons"`
	Warnings     []string    `json:"warnings"`
	Explanation  string      `json:"explanation"`
	BeforeHash   string      `json:"beforeHash"`
	Assertion    bool        `json:"assertion"`
	GrantScope   *GrantScope `json:"grantScope,omitempty"`
	Unchanged    []string    `json:"unchanged,omitempty"` // e.g. members already present
	// Password is set for reset_password: how the password will be stored
	// (method, client-side scheme, the connection's password storage
	// policy, cleartext on the wire). Never contains a value.
	Password *PasswordPreview `json:"password,omitempty"`
}

// PasswordPreview describes how a password reset stores the password
// (password track + the connection's password storage policy, GitHub
// issue #1).
type PasswordPreview struct {
	Method      string `json:"method"`      // unicodePwd | exop | userPassword
	MethodLabel string `json:"methodLabel"` // e.g. "Password Modify extended operation (RFC 3062)"
	// Scheme/SchemeLabel: the client-side hash for userPassword
	// ("CRYPT-SHA512", "{CRYPT} SHA-512-crypt ($6$)"; "CLEARTEXT").
	Scheme      string `json:"scheme,omitempty"`
	SchemeLabel string `json:"schemeLabel,omitempty"`
	// Policy is the effective policy (client | server | ask | ad) and
	// PolicySummary its one-sentence description.
	Policy        string `json:"policy"`
	PolicySummary string `json:"policySummary"`
	// ServerHashes: the server hashes cleartext values itself.
	ServerHashes bool `json:"serverHashes"`
	// CleartextOnWire: the cleartext password is sent to the server;
	// Unencrypted: over a connection without TLS (needs the confirmation).
	CleartextOnWire bool     `json:"cleartextOnWire"`
	Unencrypted     bool     `json:"unencrypted"`
	MustChange      bool     `json:"mustChange"`
	Notes           []string `json:"notes"`
}

// AttrDiff is one attribute of a change preview.
type AttrDiff struct {
	Attribute string   `json:"attribute"`
	Op        string   `json:"op"` // add | delete | replace
	Before    []string `json:"before"`
	After     []string `json:"after"`
	Values    []string `json:"values"`
}

// AttrValue is one attribute of an entry summary.
type AttrValue struct {
	Attribute string   `json:"attribute"`
	Values    []string `json:"values"`
}
