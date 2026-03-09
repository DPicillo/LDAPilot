package services

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/dpicillo/LDAPilot/internal/config"
	internalldap "github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
)

const (
	maxToolRounds      = 5
	maxSearchResults   = 10
	maxToolResultChars = 2000  // truncate individual tool results
	maxHistoryMessages = 20   // keep only recent messages when sending to API
	maxTotalChars      = 30000 // rough char limit for all messages (~8k tokens)
	maxRetries         = 3     // retry count for rate limit errors
)

// noisyAttributes are AD attributes that waste tokens and are rarely useful for the AI.
var noisyAttributes = map[string]bool{
	"objectguid":              true,
	"objectsid":               true,
	"dscorepropagationdata":   true,
	"whenchanged":             true,
	"whencreated":             true,
	"usnchanged":              true,
	"usncreated":              true,
	"instancetype":            true,
	"objectcategory":          true,
	"showinadvancedviewonly":  true,
	"iscriticalsystemobject":  true,
	"systemflags":             true,
	"admincount":              true,
	"msds-supportedencryptiontypes": true,
	"serviceprincipalname":    true,
	"lastlogontimestamp":      true,
	"lastlogon":               true,
	"logoncount":              true,
	"badpasswordtime":         true,
	"badpwdcount":             true,
	"pwdlastset":              true,
	"accountexpires":          true,
	"primarygroupid":          true,
	"useraccountcontrol":      true,
	"samaccounttype":          true,
	"codepage":                true,
	"countrycode":             true,
	"revision":                true,
	"ntSecurityDescriptor":    true,
	"gplink":                  true,
}

// systemPrompt instructs the AI about its role and constraints.
const systemPrompt = `You are an expert LDAP/Active Directory assistant embedded in LDAPilot. You help users explore, search, and understand their LDAP directories.

## CORE RULES
1. **READ-ONLY** — You may ONLY read data. NEVER create, modify, or delete anything.
2. **Be concise** — Keep responses brief and well-formatted. Use tables for structured data.
3. **Be efficient with tools** — Each tool call costs tokens. Plan your approach before calling tools.
4. **Respond in the user's language** — Match the language of the user's message (German, English, etc.).

## TOOL STRATEGY (CRITICAL FOR EFFICIENCY)
- **ALWAYS start with list_connections** if you haven't already, to discover available directories.
- **Request ONLY the attributes you need** in search_ldap. Never request all attributes.
  - For user lookups: cn, displayName, sAMAccountName, mail, title, department, manager
  - For group lookups: cn, description, member, managedBy
  - For OU browsing: cn, description, ou
- **Use precise LDAP filters** to minimize result count:
  - Users: (&(objectCategory=person)(objectClass=user)(sAMAccountName=...))
  - Groups: (&(objectClass=group)(cn=...))
  - Computers: (objectClass=computer)
  - Disabled accounts: (&(objectCategory=person)(objectClass=user)(userAccountControl:1.2.840.113556.1.4.803:=2))
  - Locked accounts: (lockoutTime>=1)
- **Keep sizeLimit small** (5-10). Only increase if the user explicitly asks for more.
- **Avoid get_entry for multiple entries** — Use search_ldap with specific attributes instead.
- **Avoid get_children on large containers** — Use search_ldap with scope=one and a filter instead.

## FORMATTING
- Use markdown tables for lists of entries
- Use bullet points for single entry details
- Bold key attributes like names and email
- Keep DN displays short — show just the RDN when the full DN is obvious from context

## AD KNOWLEDGE
- sAMAccountName is the Windows login name
- userPrincipalName is the UPN (user@domain)
- memberOf shows group memberships (may be multi-valued)
- manager contains the DN of the direct manager
- userAccountControl is a bitmask (2=disabled, 512=normal, 66048=normal+password never expires)
- distinguishedName is the full DN of the entry

## MULTI-STEP REASONING
When a user asks a complex question:
1. Think about what data you need
2. Plan the minimum number of tool calls
3. Execute searches with precise filters and minimal attributes
4. Synthesize results into a clear answer

Example: "Who is John's manager?" → 
  1. Search for John (filter: (cn=John*), attrs: cn, manager, displayName)
  2. If manager DN found, get_entry for manager (only if needed for more details)
  3. Answer with manager name and title`

// chatMessage represents a single message in the OpenAI chat format.
type chatMessage struct {
	Role       string     `json:"role"`
	Content    string     `json:"content,omitempty"`
	ToolCalls  []toolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
}

// toolCall represents a function call requested by the AI.
type toolCall struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"`
	Function toolFunction `json:"function"`
}

// toolFunction holds the function name and arguments.
type toolFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// chatRequest is the request body for the chat completions API.
type chatRequest struct {
	Model    string        `json:"model"`
	Messages []chatMessage `json:"messages"`
	Tools    []toolDef     `json:"tools,omitempty"`
}

// toolDef describes a tool available to the AI.
type toolDef struct {
	Type     string         `json:"type"`
	Function toolFunctionDef `json:"function"`
}

// toolFunctionDef describes a function the AI can call.
type toolFunctionDef struct {
	Name        string      `json:"name"`
	Description string      `json:"description"`
	Parameters  interface{} `json:"parameters"`
}

// chatResponse is the response from the chat completions API.
type chatResponse struct {
	Choices []chatChoice `json:"choices"`
	Error   *apiError    `json:"error,omitempty"`
}

// chatChoice represents a single choice in the API response.
type chatChoice struct {
	Message      chatMessage `json:"message"`
	FinishReason string      `json:"finish_reason"`
}

// apiError represents an error returned by the API.
type apiError struct {
	Message string `json:"message"`
	Type    string `json:"type"`
}

// searchLDAPArgs holds the arguments for the search_ldap tool.
type searchLDAPArgs struct {
	ConnectionName string   `json:"connectionName"`
	BaseDN         string   `json:"baseDN"`
	Filter         string   `json:"filter"`
	Scope          string   `json:"scope"`
	Attributes     []string `json:"attributes"`
	SizeLimit      int      `json:"sizeLimit"`
}

// getEntryArgs holds the arguments for the get_entry tool.
type getEntryArgs struct {
	ConnectionName string `json:"connectionName"`
	DN             string `json:"dn"`
}

// getChildrenArgs holds the arguments for the get_children tool.
type getChildrenArgs struct {
	ConnectionName string `json:"connectionName"`
	DN             string `json:"dn"`
}

// connInfo is used to return connection info to the AI.
type connInfo struct {
	ProfileID string `json:"profileId"`
	Name      string `json:"name"`
	Host      string `json:"host"`
	BaseDN    string `json:"baseDN"`
}

// AIService provides AI-powered LDAP query capabilities.
type AIService struct {
	ctx         context.Context
	pool        *internalldap.Pool
	configStore *config.AIConfigStore
	chatStore   *config.ChatStore
	mu          sync.Mutex
}

// NewAIService creates a new AIService.
func NewAIService(pool *internalldap.Pool, configStore *config.AIConfigStore, chatStore *config.ChatStore) *AIService {
	return &AIService{
		pool:        pool,
		configStore: configStore,
		chatStore:   chatStore,
	}
}

// SetContext sets the Wails application context.
func (s *AIService) SetContext(ctx context.Context) {
	s.ctx = ctx
}

// GetAIConfig returns the current AI configuration (with API key masked).
func (s *AIService) GetAIConfig() config.AIConfig {
	return s.configStore.GetMasked()
}

// SaveAIConfig saves the AI configuration with encrypted API key.
func (s *AIService) SaveAIConfig(cfg config.AIConfig) error {
	return s.configStore.Set(cfg)
}

// ListModels fetches available models from the configured AI provider.
func (s *AIService) ListModels() ([]string, error) {
	cfg := s.configStore.Get()
	if cfg.URL == "" {
		return nil, fmt.Errorf("AI provider not configured")
	}

	endpoint := strings.TrimRight(cfg.URL, "/")
	switch cfg.Provider {
	case "ollama":
		endpoint += "/api/tags"
	default:
		endpoint += "/models"
	}

	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	if cfg.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("API returned status %d", resp.StatusCode)
	}

	var modelList []string

	if cfg.Provider == "ollama" {
		var ollamaResp struct {
			Models []struct {
				Name string `json:"name"`
			} `json:"models"`
		}
		if err := json.Unmarshal(body, &ollamaResp); err != nil {
			return nil, fmt.Errorf("failed to parse response: %w", err)
		}
		for _, m := range ollamaResp.Models {
			modelList = append(modelList, m.Name)
		}
	} else {
		var openaiResp struct {
			Data []struct {
				ID string `json:"id"`
			} `json:"data"`
		}
		if err := json.Unmarshal(body, &openaiResp); err != nil {
			return nil, fmt.Errorf("failed to parse response: %w", err)
		}
		for _, m := range openaiResp.Data {
			modelList = append(modelList, m.ID)
		}
	}

	return modelList, nil
}

// --- Chat management methods ---

// ListChats returns all conversations without messages, sorted by most recent.
func (s *AIService) ListChats() ([]config.ChatConversation, error) {
	return s.chatStore.ListChats()
}

// GetChat returns a conversation including all messages.
func (s *AIService) GetChat(id string) (*config.ChatConversation, error) {
	return s.chatStore.GetChat(id)
}

// CreateChat creates a new empty conversation.
func (s *AIService) CreateChat(title string) (*config.ChatConversation, error) {
	if title == "" {
		title = "New Chat"
	}
	return s.chatStore.CreateChat(title)
}

// DeleteChat removes a conversation.
func (s *AIService) DeleteChat(id string) error {
	return s.chatStore.DeleteChat(id)
}

// RenameChat changes the title of a conversation.
func (s *AIService) RenameChat(id string, title string) error {
	conv, err := s.chatStore.GetChat(id)
	if err != nil {
		return err
	}
	conv.Title = title
	return s.chatStore.SaveChat(conv)
}

// Chat sends a user message in the given conversation, processes tool calls, and returns the response.
// The AI can search across ALL connected LDAP directories.
func (s *AIService) Chat(chatID string, message string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Load conversation
	conv, err := s.chatStore.GetChat(chatID)
	if err != nil {
		return "", fmt.Errorf("failed to load chat: %w", err)
	}

	// Initialize with system prompt if empty
	if len(conv.Messages) == 0 {
		conv.Messages = append(conv.Messages, config.ChatMsg{
			Role:    "system",
			Content: systemPrompt,
		})
	}

	// Append user message
	conv.Messages = append(conv.Messages, config.ChatMsg{
		Role:    "user",
		Content: message,
	})

	// Convert stored messages to API format
	messages := s.storedToAPI(conv.Messages)
	tools := s.buildToolDefinitions()

	// Tool call loop
	for round := 0; round < maxToolRounds; round++ {
		resp, err := s.callAPI(messages, tools)
		if err != nil {
			return "", err
		}

		if len(resp.Choices) == 0 {
			return "", fmt.Errorf("AI returned no response")
		}

		choice := resp.Choices[0]
		assistantMsg := choice.Message

		// Add assistant message to messages
		messages = append(messages, assistantMsg)

		// Store assistant message
		storedAssistant := config.ChatMsg{
			Role:    "assistant",
			Content: assistantMsg.Content,
		}
		if len(assistantMsg.ToolCalls) > 0 {
			tcJSON, _ := json.Marshal(assistantMsg.ToolCalls)
			storedAssistant.ToolCalls = string(tcJSON)
		}
		conv.Messages = append(conv.Messages, storedAssistant)

		// If no tool calls, we have the final response
		if len(assistantMsg.ToolCalls) == 0 || choice.FinishReason == "stop" {
			s.autoTitle(conv, message)
			if err := s.chatStore.SaveChat(conv); err != nil {
				return "", fmt.Errorf("failed to save chat: %w", err)
			}
			return assistantMsg.Content, nil
		}

		// Process tool calls
		for _, tc := range assistantMsg.ToolCalls {
			result := s.executeTool(tc.Function.Name, tc.Function.Arguments)
			toolResultMsg := chatMessage{
				Role:       "tool",
				Content:    result,
				ToolCallID: tc.ID,
			}
			messages = append(messages, toolResultMsg)

			// Store tool result
			conv.Messages = append(conv.Messages, config.ChatMsg{
				Role:       "tool",
				Content:    result,
				ToolCallID: tc.ID,
			})
		}
	}

	// Max rounds reached - get a final response without tools
	resp, err := s.callAPI(messages, nil)
	if err != nil {
		return "", err
	}
	if len(resp.Choices) == 0 {
		return "", fmt.Errorf("AI returned no response after tool rounds")
	}

	finalMsg := resp.Choices[0].Message
	conv.Messages = append(conv.Messages, config.ChatMsg{
		Role:    "assistant",
		Content: finalMsg.Content,
	})

	s.autoTitle(conv, message)
	if err := s.chatStore.SaveChat(conv); err != nil {
		return "", fmt.Errorf("failed to save chat: %w", err)
	}

	return finalMsg.Content, nil
}

// autoTitle sets the conversation title based on the first user message if currently generic.
func (s *AIService) autoTitle(conv *config.ChatConversation, userMessage string) {
	if conv.Title != "" && conv.Title != "New Chat" {
		return
	}
	title := userMessage
	if len(title) > 50 {
		title = title[:50] + "..."
	}
	// Remove newlines for a clean title
	title = strings.ReplaceAll(title, "\n", " ")
	title = strings.ReplaceAll(title, "\r", "")
	conv.Title = title
}

// storedToAPI converts stored ChatMsg to API chatMessage format.
func (s *AIService) storedToAPI(stored []config.ChatMsg) []chatMessage {
	messages := make([]chatMessage, 0, len(stored))
	for _, m := range stored {
		msg := chatMessage{
			Role:       m.Role,
			Content:    m.Content,
			ToolCallID: m.ToolCallID,
		}
		// Restore tool calls from JSON
		if m.ToolCalls != "" {
			var tcs []toolCall
			if err := json.Unmarshal([]byte(m.ToolCalls), &tcs); err == nil {
				msg.ToolCalls = tcs
			}
		}
		messages = append(messages, msg)
	}
	return messages
}

// --- Connection resolution ---

// getConnectedProfiles returns info about all currently connected profiles.
func (s *AIService) getConnectedProfiles() []connInfo {
	connected := s.pool.GetConnected()
	var infos []connInfo
	for id, client := range connected {
		profile := client.Profile()
		infos = append(infos, connInfo{
			ProfileID: id,
			Name:      profile.Name,
			Host:      profile.Host,
			BaseDN:    profile.BaseDN,
		})
	}
	return infos
}

// resolveConnection finds a connected client by name (case-insensitive partial match).
// If name is empty or "*", returns nil (meaning search all).
func (s *AIService) resolveConnection(name string) (*internalldap.Client, error) {
	if name == "" || name == "*" {
		// Use first connected profile
		connected := s.pool.GetConnected()
		for _, client := range connected {
			return client, nil
		}
		return nil, fmt.Errorf("no LDAP connections available")
	}

	connected := s.pool.GetConnected()
	nameLower := strings.ToLower(name)

	// Exact match first
	for _, client := range connected {
		if strings.EqualFold(client.Profile().Name, name) {
			return client, nil
		}
	}

	// Partial match
	for _, client := range connected {
		if strings.Contains(strings.ToLower(client.Profile().Name), nameLower) {
			return client, nil
		}
	}

	return nil, fmt.Errorf("no connected directory matching %q", name)
}

// resolveConnections returns all matching clients. If name is empty or "*", returns all connected.
func (s *AIService) resolveConnections(name string) ([]*internalldap.Client, error) {
	connected := s.pool.GetConnected()
	if len(connected) == 0 {
		return nil, fmt.Errorf("no LDAP connections available")
	}

	if name == "" || name == "*" {
		var clients []*internalldap.Client
		for _, client := range connected {
			clients = append(clients, client)
		}
		return clients, nil
	}

	client, err := s.resolveConnection(name)
	if err != nil {
		return nil, err
	}
	return []*internalldap.Client{client}, nil
}

// --- Tool definitions ---

// buildToolDefinitions returns the tool definitions for the AI.
func (s *AIService) buildToolDefinitions() []toolDef {
	return []toolDef{
		{
			Type: "function",
			Function: toolFunctionDef{
				Name:        "list_connections",
				Description: "List all currently connected LDAP directories. Returns name, host, and baseDN of each connected directory. Use this first to discover available directories.",
				Parameters: map[string]interface{}{
					"type":       "object",
					"properties": map[string]interface{}{},
				},
			},
		},
		{
			Type: "function",
			Function: toolFunctionDef{
				Name:        "search_ldap",
				Description: "Search an LDAP directory with a filter. ALWAYS specify 'attributes' to avoid returning unnecessary data. Use precise filters and small sizeLimit (5-10). If connectionName is empty, searches the first connected directory.",
				Parameters: map[string]interface{}{
					"type": "object",
					"properties": map[string]interface{}{
						"connectionName": map[string]interface{}{
							"type":        "string",
							"description": "Name of the connection (partial match). Leave empty for default connection.",
						},
						"baseDN": map[string]interface{}{
							"type":        "string",
							"description": "Base DN to search from. Leave empty to use the connection's default baseDN.",
						},
						"filter": map[string]interface{}{
							"type":        "string",
							"description": "LDAP filter. Examples: '(&(objectCategory=person)(objectClass=user)(cn=John*))', '(&(objectClass=group)(cn=Admin*))'",
						},
						"scope": map[string]interface{}{
							"type":        "string",
							"enum":        []string{"base", "one", "sub"},
							"description": "Search scope: 'sub' (subtree, default), 'one' (one level), 'base' (single entry)",
						},
						"attributes": map[string]interface{}{
							"type":        "array",
							"items":       map[string]interface{}{"type": "string"},
							"description": "IMPORTANT: Always specify attributes to save tokens. E.g. ['cn','mail','displayName','sAMAccountName','title','department'] for users, ['cn','description','member'] for groups.",
						},
						"sizeLimit": map[string]interface{}{
							"type":        "integer",
							"description": "Max entries to return. Keep low (5-10) unless user needs more. Max: 20.",
						},
					},
					"required": []string{"filter"},
				},
			},
		},
		{
			Type: "function",
			Function: toolFunctionDef{
				Name:        "get_entry",
				Description: "Read a single LDAP entry by its full DN. Returns all attributes of the entry.",
				Parameters: map[string]interface{}{
					"type": "object",
					"properties": map[string]interface{}{
						"connectionName": map[string]interface{}{
							"type":        "string",
							"description": "Name of the connection to use. If empty, tries all connected directories.",
						},
						"dn": map[string]interface{}{
							"type":        "string",
							"description": "The full distinguished name of the entry (e.g. 'CN=John Doe,OU=Users,DC=example,DC=com')",
						},
					},
					"required": []string{"dn"},
				},
			},
		},
		{
			Type: "function",
			Function: toolFunctionDef{
				Name:        "get_children",
				Description: "List the immediate child entries under a given DN. Returns DN, RDN, and objectClass of each child.",
				Parameters: map[string]interface{}{
					"type": "object",
					"properties": map[string]interface{}{
						"connectionName": map[string]interface{}{
							"type":        "string",
							"description": "Name of the connection to use. If empty, tries all connected directories.",
						},
						"dn": map[string]interface{}{
							"type":        "string",
							"description": "The DN of the parent entry whose children to list",
						},
					},
					"required": []string{"dn"},
				},
			},
		},
	}
}

// --- Tool execution ---

// executeTool runs a tool call and returns the result as a string.
func (s *AIService) executeTool(toolName string, argsJSON string) string {
	var result string
	switch toolName {
	case "list_connections":
		result = s.executeListConnections()
	case "search_ldap":
		result = s.executeSearch(argsJSON)
	case "get_entry":
		result = s.executeGetEntry(argsJSON)
	case "get_children":
		result = s.executeGetChildren(argsJSON)
	default:
		return fmt.Sprintf("Error: unknown tool %q", toolName)
	}
	// Truncate large results to prevent context overflow
	if len(result) > maxToolResultChars {
		result = result[:maxToolResultChars] + "\n... (truncated, use more specific filters or request fewer attributes)"
	}
	return result
}

// filterNoisyAttributes removes AD attributes that are rarely useful for the AI
// to keep tool results compact and avoid wasting tokens.
func filterNoisyAttributes(attrs []models.LDAPAttribute) []models.LDAPAttribute {
	filtered := make([]models.LDAPAttribute, 0, len(attrs))
	for _, attr := range attrs {
		if noisyAttributes[strings.ToLower(attr.Name)] {
			continue
		}
		// Truncate very long attribute values (e.g. certificates, huge multi-value)
		if len(attr.Values) > 5 {
			attr.Values = append(attr.Values[:5], fmt.Sprintf("... (%d more values)", len(attr.Values)-5))
		}
		for i, v := range attr.Values {
			if len(v) > 200 {
				attr.Values[i] = v[:200] + "..."
			}
		}
		filtered = append(filtered, attr)
	}
	return filtered
}

// executeListConnections returns information about all connected directories.
func (s *AIService) executeListConnections() string {
	infos := s.getConnectedProfiles()
	if len(infos) == 0 {
		return `{"connections": [], "message": "No LDAP directories are currently connected."}`
	}
	data, err := json.Marshal(map[string]interface{}{
		"connections": infos,
		"count":       len(infos),
	})
	if err != nil {
		return fmt.Sprintf("Error formatting connections: %v", err)
	}
	return string(data)
}

// executeSearch performs an LDAP search, optionally across all connected directories.
// Results are filtered to remove noisy attributes and save tokens.
func (s *AIService) executeSearch(argsJSON string) string {
	var args searchLDAPArgs
	if err := json.Unmarshal([]byte(argsJSON), &args); err != nil {
		return fmt.Sprintf("Error parsing arguments: %v", err)
	}

	// Determine scope
	scope := models.ScopeSub
	switch strings.ToLower(args.Scope) {
	case "base":
		scope = models.ScopeBase
	case "one":
		scope = models.ScopeOne
	case "sub", "":
		scope = models.ScopeSub
	}

	// Enforce size limit
	sizeLimit := args.SizeLimit
	if sizeLimit <= 0 || sizeLimit > maxSearchResults {
		sizeLimit = maxSearchResults
	}

	// If no specific attributes requested, default to useful ones for AI
	attrs := args.Attributes
	if len(attrs) == 0 {
		attrs = []string{"dn", "cn", "displayName", "sAMAccountName", "mail",
			"objectClass", "description", "memberOf", "member", "distinguishedName",
			"userPrincipalName", "title", "department", "company", "manager",
			"telephoneNumber", "l", "st", "co"}
	}

	// Resolve connections to search
	clients, err := s.resolveConnections(args.ConnectionName)
	if err != nil {
		return fmt.Sprintf("Error: %v", err)
	}

	type dirResult struct {
		Directory  string             `json:"directory"`
		BaseDN     string             `json:"baseDN"`
		TotalCount int                `json:"totalCount"`
		Truncated  bool               `json:"truncated"`
		Entries    []models.LDAPEntry `json:"entries"`
		Error      string             `json:"error,omitempty"`
	}

	var results []dirResult
	for _, client := range clients {
		profile := client.Profile()
		baseDN := args.BaseDN
		if baseDN == "" {
			baseDN = profile.BaseDN
		}

		params := models.SearchParams{
			BaseDN:     baseDN,
			Filter:     args.Filter,
			Scope:      scope,
			Attributes: attrs,
			SizeLimit:  sizeLimit,
		}

		result, err := client.Search(params)
		if err != nil {
			results = append(results, dirResult{
				Directory: profile.Name,
				BaseDN:    baseDN,
				Error:     err.Error(),
			})
			continue
		}

		// Filter noisy attributes from each entry
		for i := range result.Entries {
			result.Entries[i].Attributes = filterNoisyAttributes(result.Entries[i].Attributes)
		}

		results = append(results, dirResult{
			Directory:  profile.Name,
			BaseDN:     baseDN,
			TotalCount: result.TotalCount,
			Truncated:  result.Truncated,
			Entries:    result.Entries,
		})
	}

	data, err := json.Marshal(map[string]interface{}{
		"results":          results,
		"directoriesCount": len(results),
	})
	if err != nil {
		return fmt.Sprintf("Error formatting results: %v", err)
	}
	return string(data)
}

// executeGetEntry reads a single LDAP entry and returns it as JSON.
// Noisy AD attributes are filtered out to save tokens.
func (s *AIService) executeGetEntry(argsJSON string) string {
	var args getEntryArgs
	if err := json.Unmarshal([]byte(argsJSON), &args); err != nil {
		return fmt.Sprintf("Error parsing arguments: %v", err)
	}

	clients, err := s.resolveConnections(args.ConnectionName)
	if err != nil {
		return fmt.Sprintf("Error: %v", err)
	}

	// Try each client until we find the entry
	for _, client := range clients {
		entry, err := client.GetEntry(args.DN)
		if err != nil {
			continue
		}
		// Filter noisy attributes to save tokens
		entry.Attributes = filterNoisyAttributes(entry.Attributes)
		data, err := json.Marshal(map[string]interface{}{
			"directory": client.Profile().Name,
			"entry":     entry,
		})
		if err != nil {
			return fmt.Sprintf("Error formatting entry: %v", err)
		}
		return string(data)
	}

	return fmt.Sprintf("Error: entry %q not found in any connected directory", args.DN)
}

// executeGetChildren lists children of a DN and returns them as JSON.
func (s *AIService) executeGetChildren(argsJSON string) string {
	var args getChildrenArgs
	if err := json.Unmarshal([]byte(argsJSON), &args); err != nil {
		return fmt.Sprintf("Error parsing arguments: %v", err)
	}

	clients, err := s.resolveConnections(args.ConnectionName)
	if err != nil {
		return fmt.Sprintf("Error: %v", err)
	}

	// Try each client until we find children
	for _, client := range clients {
		children, err := client.GetChildren(args.DN)
		if err != nil {
			continue
		}

		// Limit to prevent oversized context
		if len(children) > maxSearchResults {
			children = children[:maxSearchResults]
		}

		data, err := json.Marshal(map[string]interface{}{
			"directory": client.Profile().Name,
			"children":  children,
		})
		if err != nil {
			return fmt.Sprintf("Error formatting children: %v", err)
		}
		return string(data)
	}

	return fmt.Sprintf("Error: DN %q not found in any connected directory", args.DN)
}

// --- API communication ---

// callAPI sends a request to the configured AI provider's chat completions endpoint.
// trimMessages reduces the message list to fit within token/char limits.
// It always keeps the system prompt (first message) and the most recent messages.
// Older messages are dropped, and tool results are truncated.
// trimMessages intelligently reduces the message list to fit within token/char limits.
// Key strategies:
//   1. Always keep system prompt (first message)
//   2. Compress old tool results into short summaries
//   3. Keep tool_call + tool_result pairs together (never orphan them)
//   4. Add a summary note when dropping old messages so the AI knows prior context existed
//   5. Always keep the most recent messages intact
func trimMessages(messages []chatMessage) []chatMessage {
	if len(messages) == 0 {
		return messages
	}

	// First pass: aggressively truncate ALL tool results
	for i := range messages {
		if messages[i].Role == "tool" && len(messages[i].Content) > maxToolResultChars {
			messages[i].Content = messages[i].Content[:maxToolResultChars] + "\n... (truncated)"
		}
	}

	// Check if we're within limits
	totalChars := 0
	for _, m := range messages {
		totalChars += len(m.Content)
	}
	if len(messages) <= maxHistoryMessages && totalChars <= maxTotalChars {
		return messages
	}

	// Separate system prompt
	var systemMsg *chatMessage
	workMessages := messages
	if len(messages) > 0 && messages[0].Role == "system" {
		systemMsg = &messages[0]
		workMessages = messages[1:]
	}

	// Second pass: compress old tool results into short summaries.
	// Keep the last 6 messages fully intact, compress older tool results.
	keepFullCount := 6
	if keepFullCount > len(workMessages) {
		keepFullCount = len(workMessages)
	}
	cutoff := len(workMessages) - keepFullCount
	for i := 0; i < cutoff; i++ {
		if workMessages[i].Role == "tool" && len(workMessages[i].Content) > 200 {
			// Create a short summary of the tool result
			content := workMessages[i].Content
			summary := content
			if len(summary) > 150 {
				summary = summary[:150]
			}
			// Count entries if it looks like JSON search results
			entryCount := strings.Count(content, `"dn"`)
			if entryCount > 0 {
				workMessages[i].Content = fmt.Sprintf("[Tool result: %d entries found. First result: %s...]", entryCount, summary)
			} else {
				workMessages[i].Content = fmt.Sprintf("[Tool result summary: %s...]", summary)
			}
		}
	}

	// Recalculate total
	totalChars = 0
	if systemMsg != nil {
		totalChars += len(systemMsg.Content)
	}
	for _, m := range workMessages {
		totalChars += len(m.Content)
	}

	// If still over limits, drop messages from the front while keeping pairs intact
	droppedUserMessages := 0
	for len(workMessages) > keepFullCount && (len(workMessages) > maxHistoryMessages-1 || totalChars > maxTotalChars) {
		// Find the next safe cut point - don't break tool_call/tool_result pairs
		cutIdx := 0
		
		// If message[0] is an assistant with tool_calls, we need to also remove
		// all subsequent tool results that reference those calls
		if workMessages[0].Role == "assistant" && len(workMessages[0].ToolCalls) > 0 {
			cutIdx = 1
			// Skip all tool results that follow
			for cutIdx < len(workMessages) && workMessages[cutIdx].Role == "tool" {
				cutIdx++
			}
		} else if workMessages[0].Role == "tool" {
			// Orphaned tool result - safe to remove
			cutIdx = 1
		} else {
			cutIdx = 1
		}

		if workMessages[0].Role == "user" {
			droppedUserMessages++
		}

		// Subtract chars being removed
		for i := 0; i < cutIdx && i < len(workMessages); i++ {
			totalChars -= len(workMessages[i].Content)
		}

		if cutIdx >= len(workMessages) {
			workMessages = nil
			break
		}
		workMessages = workMessages[cutIdx:]
	}

	// Build final result
	var result []chatMessage
	if systemMsg != nil {
		result = append(result, *systemMsg)
	}

	// If we dropped messages, add a context note so the AI knows
	if droppedUserMessages > 0 {
		result = append(result, chatMessage{
			Role:    "system",
			Content: fmt.Sprintf("[Context note: %d earlier conversation turns were trimmed to save context space. Focus on the recent messages below.]", droppedUserMessages),
		})
	}

	result = append(result, workMessages...)

	// CRITICAL: Final validation — remove orphaned tool results.
	// Claude/Anthropic requires every tool_result to have a matching tool_use
	// in the immediately preceding assistant message.
	result = removeOrphanedToolResults(result)

	return result
}

// removeOrphanedToolResults removes tool messages whose tool_call_id
// doesn't match any tool_call in the messages. This prevents API errors
// like "unexpected tool_use_id found in tool_result blocks".
func removeOrphanedToolResults(messages []chatMessage) []chatMessage {
	// Collect all valid tool_call IDs from assistant messages
	validToolCallIDs := make(map[string]bool)
	for _, m := range messages {
		if m.Role == "assistant" {
			for _, tc := range m.ToolCalls {
				validToolCallIDs[tc.ID] = true
			}
		}
	}

	// Filter out tool results with no matching tool_call
	var cleaned []chatMessage
	for _, m := range messages {
		if m.Role == "tool" {
			if m.ToolCallID == "" || !validToolCallIDs[m.ToolCallID] {
				continue // drop orphaned tool result
			}
		}
		// Also ensure assistant messages with tool_calls have ALL their
		// tool results present. If not, remove the tool_calls from
		// the assistant message to avoid the API expecting results.
		cleaned = append(cleaned, m)
	}

	// Second pass: check that every tool_call in assistant messages
	// has a matching tool result. If not, clear the tool_calls.
	toolResultIDs := make(map[string]bool)
	for _, m := range cleaned {
		if m.Role == "tool" && m.ToolCallID != "" {
			toolResultIDs[m.ToolCallID] = true
		}
	}

	for i, m := range cleaned {
		if m.Role == "assistant" && len(m.ToolCalls) > 0 {
			allPresent := true
			for _, tc := range m.ToolCalls {
				if !toolResultIDs[tc.ID] {
					allPresent = false
					break
				}
			}
			if !allPresent {
				// Remove tool_calls from this assistant message
				// and keep only the text content
				cleaned[i].ToolCalls = nil
			}
		}
	}

	return cleaned
}

func (s *AIService) callAPI(messages []chatMessage, tools []toolDef) (*chatResponse, error) {
	cfg := s.configStore.Get()
	if cfg.URL == "" {
		return nil, fmt.Errorf("AI provider not configured. Please set up the AI provider in the AI Chat settings.")
	}

	// Trim messages to fit within context limits
	messages = trimMessages(messages)

	model := cfg.Model
	if model == "" {
		switch cfg.Provider {
		case "ollama":
			model = "llama3.1"
		default:
			model = "gpt-4o"
		}
	}

	// Build endpoint URL based on provider
	endpoint := strings.TrimRight(cfg.URL, "/")
	switch cfg.Provider {
	case "ollama":
		endpoint += "/api/chat"
	default: // litellm, openai, etc.
		endpoint += "/chat/completions"
	}

	reqBody := chatRequest{
		Model:    model,
		Messages: messages,
	}
	if len(tools) > 0 {
		reqBody.Tools = tools
	}

	bodyBytes, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	// Retry loop with exponential backoff for rate limits
	for attempt := 0; attempt <= maxRetries; attempt++ {
		req, err := http.NewRequestWithContext(s.ctx, http.MethodPost, endpoint, bytes.NewReader(bodyBytes))
		if err != nil {
			return nil, fmt.Errorf("failed to create request: %w", err)
		}
		req.Header.Set("Content-Type", "application/json")
		if cfg.APIKey != "" {
			req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
		}

		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return nil, fmt.Errorf("API request failed: %w", err)
		}

		respBytes, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("failed to read API response: %w", err)
		}

		// Handle rate limit errors (429 Too Many Requests, 529 Overloaded)
		if resp.StatusCode == 429 || resp.StatusCode == 529 {
			if attempt < maxRetries {
				// Exponential backoff: 2s, 4s, 8s
				waitDuration := time.Duration(1<<uint(attempt+1)) * time.Second
				// Check Retry-After header
				if retryAfter := resp.Header.Get("Retry-After"); retryAfter != "" {
					var secs int
					if n, _ := fmt.Sscanf(retryAfter, "%d", &secs); n == 1 && secs > 0 {
						waitDuration = time.Duration(secs) * time.Second
					}
				}
				if waitDuration > 30*time.Second {
					waitDuration = 30 * time.Second
				}
				select {
				case <-time.After(waitDuration):
					continue // retry
				case <-s.ctx.Done():
					return nil, fmt.Errorf("request cancelled during rate limit backoff")
				}
			}
			return nil, fmt.Errorf("API rate limited (status %d) after %d retries. Please wait a moment and try again.", resp.StatusCode, maxRetries)
		}

		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("API returned status %d: %s", resp.StatusCode, string(respBytes))
		}

		var chatResp chatResponse
		if err := json.Unmarshal(respBytes, &chatResp); err != nil {
			return nil, fmt.Errorf("failed to parse API response: %w", err)
		}

		if chatResp.Error != nil {
			return nil, fmt.Errorf("API error: %s", chatResp.Error.Message)
		}

		return &chatResp, nil
	}

	return nil, fmt.Errorf("API request failed after %d retries", maxRetries)
}
